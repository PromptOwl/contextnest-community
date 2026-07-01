/**
 * Per-nest image assets — the storage half of "images in markdown docs".
 *
 * Files live beside the vault at <nest>/assets/<uuid>.<ext> and are
 * referenced from documents as relative same-origin URLs
 * (/nests/<id>/assets/<file>), so the standard markdown image syntax just
 * works in both the editor and the read view.
 *
 * Security posture:
 *   - image extensions only; SVG deliberately excluded v1 (stored-XSS
 *     surface — script-capable when navigated to directly)
 *   - server-minted uuid filenames; the GET route accepts ONLY that shape,
 *     so traversal input can never resolve to a path
 *   - POST is write-tier, GET read-tier via the standard nest middleware
 *     (public nests serve their images publicly, same as their docs)
 *   - size is bounded by the global MAX_BODY_BYTES request cap
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
};

// Server-minted names only: uuid + allowed extension. This regex IS the
// traversal defense — anything else 400s before touching the filesystem.
const SAFE_NAME = /^[0-9a-f-]{36}\.(png|jpe?g|gif|webp)$/;

// POST /nests/:nestId/assets — multipart upload, field name "file".
assetRoutes.post("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) {
    throw new ValidationError('multipart field "file" (an image) is required');
  }
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!CONTENT_TYPES[ext]) {
    throw new ValidationError(
      `unsupported image type ".${ext}" — allowed: ${Object.keys(CONTENT_TYPES).join(", ")}`,
    );
  }
  const name = `${uuid()}.${ext === "jpeg" ? "jpg" : ext}`;
  const dir = join(resolveNestPath(nestId), "assets");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), Buffer.from(await file.arrayBuffer()));
  return c.json(
    {
      file: name,
      url: `/nests/${nestId}/assets/${name}`,
      markdown: `![${file.name.replace(/\.[^.]+$/, "")}](/nests/${nestId}/assets/${name})`,
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
