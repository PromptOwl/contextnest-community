/**
 * Office documents — a .pptx or .docx uploaded as a governed markdown
 * document (office-service.ts has the model).
 *
 *   POST /nests/:nestId/nodes/office        multipart `file` or JSON
 *                                           { filename, content_base64 | url }
 *                                           (+ title, folder, tags)
 *   GET  /nests/:nestId/originals/:file     the uploaded file, as a download
 *
 * Security posture of the served original:
 *   - read tier through the nest middleware, then canReadNode on every
 *     document that binds the file (office-service.ts readOriginal);
 *   - only server-minted `<uuid>.(pptx|docx)` names reach the filesystem;
 *   - `Content-Disposition: attachment` always, the Office content type,
 *     nosniff and CSP `sandbox`, so the response is never rendered as a page;
 *   - Cache-Control `private, no-cache` + a sha256 ETag, as for PDFs.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AuthEnv } from "../auth/middleware.js";
import { config } from "../config.js";
import { PayloadTooLargeError } from "../shared/errors.js";
import { attributeRequest } from "../shared/client-metadata.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { toNodeResponse } from "./service.js";
import { OFFICE_CONTENT_TYPES, readOriginal } from "./office-service.js";
import {
  assertDocumentUploadNotGated,
  officeTooLargeMessage,
  readUploadRequest,
  saveOfficeUpload,
  stewardsFor,
} from "./upload-service.js";

export const officeNodeRoutes = new Hono<AuthEnv>();
export const originalRoutes = new Hono<AuthEnv>();

/** The upload route — app.ts lifts the global body cap for it. */
export const OFFICE_UPLOAD_PATH = /^\/nests\/[^/]+\/nodes\/office\/?$/;

/** Content-Length ceiling for the upload: the Office cap + multipart slack. */
export function officeMaxRequestBytes(): number {
  return config.OFFICE_MAX_BYTES + 1024 * 1024;
}

export { officeTooLargeMessage };

// POST /nests/:nestId/nodes/office — write tier (app.ts: nest-scope steward
// editors are admitted like a create). Multipart `file`, or a JSON body
// { filename, content_base64 } / { url } (upload-service.ts). Same body gates
// as the PDF upload: the declared length, the length as it streams, then the
// file's own size.
officeNodeRoutes.post(
  "/office",
  (c, next) =>
    bodyLimit({
      maxSize: officeMaxRequestBytes(),
      onError: (c) => c.json({ error: officeTooLargeMessage() }, 413),
    })(c, next),
  async (c) => {
    const nestId = c.req.param("nestId")!;
    const lenStr = c.req.header("Content-Length");
    if (lenStr) {
      const len = parseInt(lenStr, 10);
      if (Number.isFinite(len) && len > officeMaxRequestBytes()) {
        throw new PayloadTooLargeError(officeTooLargeMessage(len));
      }
    }
    // Before the body is read, so a held nest never fetches a URL for nothing.
    await assertDocumentUploadNotGated({
      nestId,
      userId: c.get("userId"),
      keyId: c.get("apiKeyId") ?? null,
      agentSurface: false,
    });
    const { upload, fields } = await readUploadRequest(c, "office");
    const userEmail = await resolveCallerEmail(c.get("userId"));
    const saved = await saveOfficeUpload(nestId, upload, fields, userEmail, attributeRequest(c, undefined));
    return c.json(
      {
        node: toNodeResponse(saved.node),
        version: saved.version,
        stewards: await stewardsFor(nestId, saved.node.id),
      },
      201,
    );
  },
);

// GET /nests/:nestId/originals/:file — read tier; see readOriginal.
originalRoutes.get("/:file", async (c) => {
  const nestId = c.req.param("nestId")!;
  const userId = c.get("userId");
  const { bytes, original } = await readOriginal(nestId, c.req.param("file")!, {
    userId,
    userEmail: await resolveCallerEmail(userId),
  });
  const etag = `"${original.sha256}"`;
  // ASCII fallback plus the RFC 5987 form for the real name.
  const ascii = original.filename.replace(/[^A-Za-z0-9._ -]/g, "_");
  const headers: Record<string, string> = {
    "Content-Type": OFFICE_CONTENT_TYPES[original.kind],
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(original.filename)}`,
    "Content-Security-Policy": "sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-cache",
    ETag: etag,
  };
  const ifNoneMatch = c.req.header("If-None-Match");
  if (ifNoneMatch && ifNoneMatch.split(",").map((t) => t.trim()).includes(etag)) {
    return c.body(null, 304, headers);
  }
  return c.body(new Uint8Array(bytes), 200, headers);
});
