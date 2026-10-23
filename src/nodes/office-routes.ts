/**
 * Office documents — a .pptx or .docx uploaded as a governed markdown
 * document (office-service.ts has the model).
 *
 *   POST /nests/:nestId/nodes/office        multipart `file` (+ title, folder,
 *                                           tags)
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
import { PayloadTooLargeError, ValidationError } from "../shared/errors.js";
import { attributeRequest } from "../shared/client-metadata.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import * as stewardship from "../governance/stewardship-service.js";
import { toNodeResponse } from "./service.js";
import {
  createOfficeDocument,
  OFFICE_CONTENT_TYPES,
  officeKindOf,
  readOriginal,
} from "./office-service.js";

export const officeNodeRoutes = new Hono<AuthEnv>();
export const originalRoutes = new Hono<AuthEnv>();

/** The upload route — app.ts lifts the global body cap for it. */
export const OFFICE_UPLOAD_PATH = /^\/nests\/[^/]+\/nodes\/office\/?$/;

/** Content-Length ceiling for the upload: the Office cap + multipart slack. */
export function officeMaxRequestBytes(): number {
  return config.OFFICE_MAX_BYTES + 1024 * 1024;
}

/** The one 413 message for an oversized Office file, whichever gate refuses it. */
export function officeTooLargeMessage(bytes?: number): string {
  const size = bytes === undefined ? "" : `${(bytes / (1024 * 1024)).toFixed(1)} MB, `;
  return `Office file too large (${size}max ${config.OFFICE_MAX_BYTES / (1024 * 1024)} MB)`;
}

function field(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  const one = Array.isArray(v) ? v[0] : v;
  return typeof one === "string" ? one.trim() : "";
}

function tagsField(body: Record<string, unknown>): string[] | undefined {
  const v = body["tags"];
  if (v === undefined) return undefined;
  return (Array.isArray(v) ? v : [v])
    .filter((x): x is string => typeof x === "string")
    .flatMap((s) => s.split(","))
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean);
}

// POST /nests/:nestId/nodes/office — write tier (app.ts: nest-scope steward
// editors are admitted like a create). Same body gates as the PDF upload: the
// declared length, the length as it streams, then file.size.
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
    const body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
    const fileField = Array.isArray(body["file"]) ? body["file"][0] : body["file"];
    if (!(fileField instanceof File)) {
      throw new ValidationError('multipart field "file" (a .pptx or .docx) is required');
    }
    if (!officeKindOf(fileField.name || "")) {
      throw new ValidationError("Only .pptx and .docx files can be uploaded as Office documents.");
    }
    if (fileField.size > config.OFFICE_MAX_BYTES) {
      throw new PayloadTooLargeError(officeTooLargeMessage(fileField.size));
    }
    const userEmail = await resolveCallerEmail(c.get("userId"));
    const folder = field(body, "folder");
    const title = field(body, "title");
    const tags = tagsField(body);
    const { node, version } = await createOfficeDocument(
      nestId,
      {
        bytes: new Uint8Array(await fileField.arrayBuffer()),
        filename: fileField.name,
        ...(title ? { title } : {}),
        ...(folder ? { folder } : {}),
        ...(tags ? { tags } : {}),
        client: attributeRequest(c, undefined),
      },
      userEmail,
    );
    const resolved = await stewardship.resolveStewardsForNode(nestId, node.id);
    return c.json(
      {
        node: toNodeResponse(node),
        version,
        stewards:
          resolved.length > 0
            ? resolved.map((r) => ({ email: r.steward.userEmail, role: r.steward.role, source: r.source }))
            : undefined,
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
