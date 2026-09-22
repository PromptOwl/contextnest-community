/**
 * PDF documents (CU-wdqcq02pmh) — a PDF uploaded as a governed `pdf` node.
 *
 *   POST /nests/:nestId/nodes/pdf            multipart `file` (+ title, folder,
 *                                            tags, nodeId, changeNote)
 *   GET  /nests/:nestId/nodes/:nodeId/pdf    the binary (?version=N,
 *                                            ?approved_only=1, ?download=1)
 *
 * The engine owns everything about the PDF itself (engine spec §1.11): the
 * `context_import_pdf` op extracts the text, stores the binary as a sidecar
 * beside the node, binds it by sha256 in the `pdf:` frontmatter block, and
 * archives prior binaries by hash; `readPdfBinary` resolves a version to its
 * bytes and verifies them. This file is only the community surface on top:
 * size/type checks that answer before any work, the same create/update
 * governance every other node goes through (service.ts), and a read path that
 * serves a public reader the APPROVED version's bytes, never a draft's.
 *
 * Security posture of the served binary:
 *   - Content-Type application/pdf + nosniff: never reinterpreted as HTML;
 *   - CSP `sandbox`: if a browser ever renders the response as a document of
 *     the app origin, it runs on an opaque origin with scripts off (verified:
 *     Chromium's built-in viewer still renders a sandboxed PDF);
 *   - Cache-Control `private, no-cache` + a sha256 ETag: the URL is stable
 *     while what it names changes on approval, so every use revalidates (a
 *     cheap 304) instead of trusting a cached copy of a superseded version,
 *     and no shared cache keeps a private nest's PDF.
 */
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { isPdf, readPdfBinary } from "@promptowl/contextnest-engine";
import type { NestStorage } from "@promptowl/contextnest-engine";
import type { AuthEnv } from "../auth/middleware.js";
import { config } from "../config.js";
import {
  AppError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from "../shared/errors.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { attributeRequest } from "../shared/client-metadata.js";
import { isPublicReader } from "../shared/access.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import * as versions from "../governance/version-service.js";
import * as stewardship from "../governance/stewardship-service.js";
import { engineCache } from "./engine.js";
import {
  createNode,
  getNodeForCaller,
  toNodeResponse,
  updateNode,
  PDF_NODE_TYPE,
} from "./service.js";

export const pdfNodeRoutes = new Hono<AuthEnv>();

/** The upload route — app.ts lifts the global body cap for it. */
export const PDF_UPLOAD_PATH = /^\/nests\/[^/]+\/nodes\/pdf\/?$/;

/** Content-Length ceiling for the upload: the PDF cap + multipart framing slack. */
export function pdfMaxRequestBytes(): number {
  return config.PDF_MAX_BYTES + 1024 * 1024;
}

function tooLarge(bytes: number): PayloadTooLargeError {
  return new PayloadTooLargeError(
    `PDF too large (${(bytes / (1024 * 1024)).toFixed(1)} MB, max ${
      config.PDF_MAX_BYTES / (1024 * 1024)
    } MB)`,
  );
}

/** A multipart field as one trimmed string ("" when absent or a file). */
function field(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  const one = Array.isArray(v) ? v[0] : v;
  return typeof one === "string" ? one.trim() : "";
}

/** Tags from repeated `tags` fields and/or a comma-separated list. */
function tagsField(body: Record<string, unknown>): string[] | undefined {
  const v = body["tags"];
  if (v === undefined) return undefined;
  const raw = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
  const tags = raw
    .flatMap((s) => s.split(","))
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean);
  return tags;
}

/** A readable title from an uploaded file name ("Q3 report.pdf" → "Q3 report"). */
function titleFromFilename(name: string): string {
  return name
    .split(/[/\\]/)
    .pop()!
    .replace(/\.pdf$/i, "")
    .replace(/[_]+/g, " ")
    .trim()
    .slice(0, 200);
}

// POST /nests/:nestId/nodes/pdf — write tier (app.ts: every non-GET node route
// requires write; nest-scope steward editors are admitted like a create).
pdfNodeRoutes.post("/pdf", async (c) => {
  const nestId = c.req.param("nestId")!;

  // Cheap refusal before the body is parsed. Mirrors app.ts's route-level
  // Content-Length gate for defense in depth; a body without a declared length
  // falls through to the file.size check below.
  const lenStr = c.req.header("Content-Length");
  if (lenStr) {
    const len = parseInt(lenStr, 10);
    if (Number.isFinite(len) && len > pdfMaxRequestBytes()) throw tooLarge(len);
  }

  const body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  const fileField = Array.isArray(body["file"]) ? body["file"][0] : body["file"];
  if (!(fileField instanceof File)) {
    throw new ValidationError('multipart field "file" (a PDF) is required');
  }
  const file = fileField;
  // Size first — a File property, so an oversized upload is refused before
  // arrayBuffer() materializes a second copy of it.
  if (file.size > config.PDF_MAX_BYTES) throw tooLarge(file.size);
  const bytes = new Uint8Array(await file.arrayBuffer());
  // The bytes decide, not the name or the declared type: a PDF begins with
  // %PDF-. (The engine checks again, and also refuses encrypted/unreadable
  // files — those come back as a 400 from the service.)
  if (!isPdf(bytes)) {
    throw new ValidationError("That file is not a PDF (it does not start with %PDF-).");
  }

  const userEmail = await resolveCallerEmail(c.get("userId"));
  const title = field(body, "title");
  const tags = tagsField(body);
  const client = attributeRequest(c, undefined);
  const pdf = { bytes, filename: file.name || undefined };

  // Replace: a new version of an existing pdf node, through updateNode — the
  // same review lock, draft/publish decision and version rows as any edit.
  const targetId = field(body, "nodeId");
  if (targetId) {
    // The node-id chokepoint in app.ts guards path params only; this id
    // arrives in the body, so it is checked here before it becomes a path.
    assertSafeNodeId(targetId);
    const changeNote = field(body, "changeNote") || "Replaced the PDF";
    const { node, version } = await updateNode(
      nestId,
      targetId,
      {
        pdf,
        ...(title ? { title } : {}),
        ...(tags ? { tags } : {}),
        changeNote,
        client,
      },
      userEmail,
    );
    return c.json({ node: toNodeResponse(node), version });
  }

  const folder = field(body, "folder");
  const { node, version } = await createNode(
    nestId,
    {
      title: title || titleFromFilename(file.name || "") || "Untitled PDF",
      content: "",
      type: PDF_NODE_TYPE,
      ...(tags ? { tags } : {}),
      ...(folder ? { folder } : {}),
      client,
      pdf,
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
          ? resolved.map((r) => ({
              email: r.steward.userEmail,
              role: r.steward.role,
              source: r.source,
            }))
          : undefined,
    },
    201,
  );
});

// GET /nests/:nestId/nodes/:nodeId/pdf — the binary, through the node read
// path. Registered ahead of every greedy node route (app.ts); when the id is
// not a pdf node the request falls through, so a document whose own id ends
// in "/pdf" (e.g. nodes/guides/pdf) is still served by the node catch-all.
pdfNodeRoutes.get("/:nodeId{.+}/pdf", async (c, next) => {
  const nestId = c.req.param("nestId")!;
  const nodeId = c.req.param("nodeId")!;
  const userId = c.get("userId");
  const userEmail = await resolveCallerEmail(userId);

  // Same gate as GET /nodes/:id (canReadNode inside, before any read). A miss
  // or a refusal falls through too: the catch-all then answers for the
  // literal "<id>/pdf", which never tells a caller more than a 404/403 on
  // that id would.
  let node;
  try {
    node = await getNodeForCaller(nestId, { id: nodeId }, userId, userEmail);
  } catch {
    return next();
  }
  if (node.frontmatter.type !== PDF_NODE_TYPE) return next();

  const requested = c.req.query("version");
  if (requested !== undefined && !/^[1-9]\d*$/.test(requested)) {
    throw new ValidationError("version must be a positive integer");
  }
  // Public readers see the approved version only — the same rule the JSON
  // read applies to the body — whatever version they ask for. approved_only
  // asks for that view on purpose (an owner previewing the public reader).
  const approvedOnly =
    c.req.query("approved_only") === "1" || c.req.query("approved_only") === "true";
  let version: number | undefined;
  if (approvedOnly || (await isPublicReader(nestId, userId))) {
    const approved = await versions.getApprovedVersion(nestId, nodeId);
    if (approved == null) {
      throw new NotFoundError("This document has no approved version yet.");
    }
    version = approved;
  } else if (requested !== undefined) {
    version = Number(requested);
  }

  const { storage } = await engineCache.get(nestId);
  let bytes: Buffer;
  try {
    bytes = await readPdfBinary(
      storage as unknown as NestStorage,
      nodeId,
      version !== undefined ? { version } : {},
    );
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "INTEGRITY_ERROR") {
      // The bytes on disk no longer hash to what the version records. Never
      // serve them; say what is wrong so an operator runs `ctx verify`.
      console.error("[pdf] integrity failure serving", nestId, nodeId, version, err);
      throw new AppError(
        500,
        "This PDF no longer matches the version history's record of it, so it is not being served. Ask an admin to verify the nest.",
      );
    }
    throw new NotFoundError(
      version !== undefined
        ? `Version ${version} of this PDF was not found.`
        : "This document's PDF was not found.",
    );
  }

  const etag = `"sha256:${createHash("sha256").update(bytes).digest("hex")}"`;
  const leaf = (nodeId.split("/").pop() || "document").replace(/[^A-Za-z0-9._-]/g, "-");
  const disposition = c.req.query("download") === "1" ? "attachment" : "inline";
  const headers: Record<string, string> = {
    "Content-Type": "application/pdf",
    "Content-Disposition": `${disposition}; filename="${leaf}.pdf"`,
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
