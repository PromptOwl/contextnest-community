/**
 * Per-nest media assets — the storage half of "images and video in
 * markdown docs".
 *
 * Files live beside the vault at <nest>/assets/<uuid>.<ext> and are
 * referenced from documents as relative same-origin URLs
 * (/nests/<id>/assets/<file>), so the standard markdown image syntax just
 * works in both the editor and the read view; video assets are referenced
 * by bare URL and rendered as a <video> player by the read view.
 *
 * Security posture:
 *   - image + video (mp4/webm) extensions only; SVG deliberately excluded
 *     v1 (stored-XSS surface — script-capable when navigated to directly)
 *   - server-minted uuid filenames; the GET route accepts ONLY that shape,
 *     so traversal input can never resolve to a path
 *   - POST is write-tier, GET read-tier via the standard nest middleware
 *     (public nests serve their media publicly, same as their docs)
 *   - size is capped per type in the POST handler (images 10 MB, video
 *     100 MB). The global MAX_BODY_BYTES request cap still applies to
 *     every other route; app.ts raises ONLY this route's effective
 *     Content-Length limit to ASSET_MAX_REQUEST_BYTES so video uploads
 *     aren't rejected before the handler runs.
 */
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthEnv } from "../auth/middleware.js";
import { resolveNestPath } from "../shared/paths.js";
import { ValidationError, NotFoundError } from "../shared/errors.js";

export const assetRoutes = new Hono<AuthEnv>();

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
};

const VIDEO_EXTS = new Set(["mp4", "webm"]);

// Per-type upload caps, enforced on the parsed file in the POST handler.
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const VIDEO_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
// Effective Content-Length ceiling for the asset POST route only (largest
// allowed file + slack for multipart framing). app.ts consults this so the
// global MAX_BODY_BYTES cap never has to be raised for video uploads.
export const ASSET_MAX_REQUEST_BYTES = VIDEO_MAX_BYTES + 1024 * 1024;

// Server-minted names only: uuid + allowed extension. This regex IS the
// traversal defense — anything else 400s before touching the filesystem.
const SAFE_NAME = /^[0-9a-f-]{36}\.(png|jpe?g|gif|webp|mp4|webm)$/;

// POST /nests/:nestId/assets — multipart upload, field name "file".
assetRoutes.post("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  // Pre-parse guard. The media type (image vs video) lives inside the
  // multipart body — the filename is not knowable from headers — so the
  // per-type caps CANNOT be applied before parsing. What can be rejected
  // cheaply here is anything larger than the biggest allowed upload:
  // mirrors app.ts's route-level Content-Length gate for defense in depth
  // (and covers a configuration where the global MAX_BODY_BYTES was
  // raised above the asset ceiling). Bodies without a declared
  // Content-Length fall through to the post-parse checks below.
  const lenStr = c.req.header("Content-Length");
  if (lenStr) {
    const len = parseInt(lenStr, 10);
    if (Number.isFinite(len) && len > ASSET_MAX_REQUEST_BYTES) {
      throw new ValidationError(
        `upload too large (${(len / (1024 * 1024)).toFixed(1)} MB, ` +
          `max ${VIDEO_MAX_BYTES / (1024 * 1024)} MB for video, ` +
          `${IMAGE_MAX_BYTES / (1024 * 1024)} MB for images)`,
      );
    }
  }
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) {
    throw new ValidationError(
      'multipart field "file" (an image or video) is required',
    );
  }
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!CONTENT_TYPES[ext]) {
    throw new ValidationError(
      `unsupported asset type ".${ext}" — allowed: ${Object.keys(CONTENT_TYPES).join(", ")}`,
    );
  }
  // Per-type cap on file.size — a File property, so this rejects an
  // oversized upload BEFORE arrayBuffer() ever materializes a second
  // copy of the bytes. Order matters: keep this ahead of any read.
  const isVideo = VIDEO_EXTS.has(ext);
  const maxBytes = isVideo ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;
  if (file.size > maxBytes) {
    throw new ValidationError(
      `${isVideo ? "video" : "image"} too large ` +
        `(${(file.size / (1024 * 1024)).toFixed(1)} MB, ` +
        `max ${maxBytes / (1024 * 1024)} MB for ${isVideo ? "video" : "images"})`,
    );
  }
  const name = `${uuid()}.${ext === "jpeg" ? "jpg" : ext}`;
  const dir = join(resolveNestPath(nestId), "assets");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), Buffer.from(await file.arrayBuffer()));
  const url = `/nests/${nestId}/assets/${name}`;
  return c.json(
    {
      file: name,
      url,
      // Ready-to-paste reference: image syntax for images; videos are
      // referenced by bare URL on its own line (the read view upgrades
      // same-origin asset video URLs to a <video> player).
      markdown: isVideo
        ? url
        : `![${file.name.replace(/\.[^.]+$/, "")}](${url})`,
    },
    201,
  );
});

// GET /nests/:nestId/assets/:file
assetRoutes.get("/:file", async (c) => {
  const nestId = c.req.param("nestId")!;
  const name = c.req.param("file")!;
  if (!SAFE_NAME.test(name)) {
    throw new ValidationError("invalid asset name");
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(join(resolveNestPath(nestId), "assets", name));
  } catch {
    throw new NotFoundError("Asset not found");
  }
  const ext = name.split(".").pop()!;
  return c.body(new Uint8Array(bytes), 200, {
    "Content-Type": CONTENT_TYPES[ext],
    // uuid names never change content — cache hard.
    "Cache-Control": "public, max-age=31536000, immutable",
  });
});
