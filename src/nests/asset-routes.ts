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
 *   - image + video (mp4/webm) extensions only (upload-service.ts holds the
 *     allowlist, shared with MCP context_upload); SVG deliberately excluded
 *     v1 (stored-XSS surface — script-capable when navigated to directly)
 *   - server-minted uuid filenames; the GET route accepts ONLY that shape,
 *     so traversal input can never resolve to a path
 *   - POST is write-tier, GET read-tier via the standard nest middleware
 *     (public nests serve their media publicly, same as their docs)
 *   - size is capped per type in the POST handler (images 10 MB, video
 *     env-configurable via VIDEO_MAX_MB, default 30 MB). The global
 *     MAX_BODY_BYTES request cap still applies to
 *     every other route; app.ts raises ONLY this route's effective
 *     Content-Length limit to ASSET_MAX_REQUEST_BYTES so video uploads
 *     aren't rejected before the handler runs.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuthEnv } from "../auth/middleware.js";
import { resolveNestPath } from "../shared/paths.js";
import { config } from "../config.js";
import { ValidationError, NotFoundError } from "../shared/errors.js";
import {
  ASSET_CONTENT_TYPES,
  IMAGE_MAX_BYTES,
  readUploadRequest,
  storeAsset,
} from "../nodes/upload-service.js";

export { IMAGE_MAX_BYTES };

export const assetRoutes = new Hono<AuthEnv>();

// Video cap is env-configurable (VIDEO_MAX_MB) — default 30 MB, under Cloud
// Run's 32 MiB request limit so oversized videos fail with our clear message,
// not a platform 413. See config.VIDEO_MAX_BYTES.
export const VIDEO_MAX_BYTES = config.VIDEO_MAX_BYTES;
// Effective Content-Length ceiling for the asset POST route only (largest
// allowed file + slack for multipart framing). app.ts consults this so the
// global MAX_BODY_BYTES cap never has to be raised for video uploads.
export const ASSET_MAX_REQUEST_BYTES = VIDEO_MAX_BYTES + 1024 * 1024;

// Server-minted names only: uuid + allowed extension. This regex IS the
// traversal defense — anything else 400s before touching the filesystem.
const SAFE_NAME = /^[0-9a-f-]{36}\.(png|jpe?g|gif|webp|mp4|webm)$/;

function tooLargeMessage(len?: number): string {
  return (
    `upload too large (${len === undefined ? "" : `${(len / (1024 * 1024)).toFixed(1)} MB, `}` +
    `max ${VIDEO_MAX_BYTES / (1024 * 1024)} MB for video, ` +
    `${IMAGE_MAX_BYTES / (1024 * 1024)} MB for images)`
  );
}

// POST /nests/:nestId/assets — multipart (field "file") or a JSON body
// { filename, content_base64 } / { url } (upload-service.ts). The first
// handler caps the body as it is read, so a chunked upload without a
// Content-Length can't be buffered past the ceiling either.
assetRoutes.post(
  "/",
  (c, next) =>
    bodyLimit({
      maxSize: ASSET_MAX_REQUEST_BYTES,
      onError: (c) => c.json({ error: tooLargeMessage() }, 400),
    })(c, next),
  async (c) => {
    const nestId = c.req.param("nestId")!;
    // Pre-parse guard. The media type (image vs video) lives inside the
    // body — the filename is not knowable from headers — so the per-type
    // caps CANNOT be applied before parsing. What can be rejected cheaply
    // here is anything larger than the biggest allowed upload: mirrors
    // app.ts's route-level Content-Length gate for defense in depth (and
    // covers a configuration where the global MAX_BODY_BYTES was raised
    // above the asset ceiling).
    const lenStr = c.req.header("Content-Length");
    if (lenStr) {
      const len = parseInt(lenStr, 10);
      if (Number.isFinite(len) && len > ASSET_MAX_REQUEST_BYTES) {
        throw new ValidationError(tooLargeMessage(len));
      }
    }
    // Type by extension and the per-type cap (on file.size, before the bytes
    // are copied) are checked inside readUploadRequest.
    const { upload } = await readUploadRequest(c, "asset");
    return c.json(await storeAsset(nestId, upload), 201);
  },
);

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
    "Content-Type": ASSET_CONTENT_TYPES[ext],
    // uuid names never change content — cache hard.
    "Cache-Control": "public, max-age=31536000, immutable",
    // Never let the browser second-guess the declared type on direct
    // navigation (same posture as annotation attachments).
    "X-Content-Type-Options": "nosniff",
  });
});
