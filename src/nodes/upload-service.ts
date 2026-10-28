/**
 * File uploads — the one code path behind every way a file gets into a nest:
 *
 *   POST /nests/:id/assets          images + video  → the asset store
 *   POST /nests/:id/nodes/pdf       a PDF           → a governed `pdf` node
 *   POST /nests/:id/nodes/office    .pptx / .docx / .xlsx → a governed document
 *   MCP  context_upload             any of the above, routed by file type
 *
 * Each REST route takes multipart (`file`) or a JSON body naming the bytes —
 * `{ filename, content_base64 }` or `{ url }` — so an API caller or an agent
 * never has to build multipart. `readUploadRequest` turns either into the same
 * `ResolvedUpload`; `storeAsset` / `savePdfUpload` / `createOfficeDocument` do
 * the write. Type allowlist and per-type caps live here once, so MCP can't
 * accept what REST refuses.
 *
 * `url` mode fetches server-side through metacognition/net.ts guardedFetch,
 * the codebase's SSRF-safe outbound fetch: https only, the host's addresses
 * checked at connect time (private, loopback, link-local and metadata
 * addresses refused, with no second resolution to rebind), redirects not
 * followed, and the body torn down past the type's cap before it is buffered.
 * The private-address fence is pinned on here regardless of the metacognition
 * dev switch.
 */
import type { Context } from "hono";
import { v4 as uuid } from "uuid";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isPdf } from "@promptowl/contextnest-engine";
import type { ContextNode } from "@promptowl/contextnest-engine";
import { config } from "../config.js";
import {
  ForbiddenError,
  PayloadTooLargeError,
  ValidationError,
  type AppError,
} from "../shared/errors.js";
import { resolveNestPath } from "../shared/paths.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import type { ClientMetadata } from "../shared/client-metadata.js";
import { guardedFetch, OutboundBlockedError, OutboundTooLargeError } from "../metacognition/net.js";
import { isPushAllowlisted } from "../nests/push-confirmation-service.js";
import { nestRequiresPushConfirmation } from "../nests/service.js";
import * as stewardship from "../governance/stewardship-service.js";
import { createNode, updateNode, PDF_NODE_TYPE, type OriginalFile } from "./service.js";
import { createOfficeDocument } from "./office-service.js";

// ─── Types and caps ────────────────────────────────────────────────────────

export type UploadKind = "image" | "video" | "pdf" | "office";

/** Asset content types by extension. SVG is deliberately absent (stored-XSS
 *  surface — script-capable when navigated to directly). */
export const ASSET_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
};

const EXT_KIND: Record<string, UploadKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  mp4: "video",
  webm: "video",
  pdf: "pdf",
  pptx: "office",
  docx: "office",
  xlsx: "office",
};

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/** The kind a file name's extension routes to, or null. */
export function uploadKindOf(filename: string): UploadKind | null {
  const ext = extOf(filename);
  return Object.prototype.hasOwnProperty.call(EXT_KIND, ext) ? EXT_KIND[ext] : null;
}

function extOf(filename: string): string {
  const leaf = filename.split(/[/\\]/).pop() || "";
  return leaf.includes(".") ? (leaf.split(".").pop() || "").toLowerCase() : "";
}

/** Per-type cap, read per call so env changes apply without a restart. */
export function uploadCap(kind: UploadKind): number {
  switch (kind) {
    case "image":
      return IMAGE_MAX_BYTES;
    case "video":
      return config.VIDEO_MAX_BYTES;
    case "pdf":
      return config.PDF_MAX_BYTES;
    case "office":
      return config.OFFICE_MAX_BYTES;
  }
}

const mb = (n: number) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;

/** "png, jpg, … (images, 10 MB); mp4, webm (video, 30 MB); …" for the kinds given. */
export function supportedTypes(kinds: UploadKind[] = ["image", "video", "pdf", "office"]): string {
  const parts: string[] = [];
  if (kinds.includes("image")) parts.push(`png, jpg, jpeg, gif, webp (images, max ${mb(uploadCap("image"))})`);
  if (kinds.includes("video")) parts.push(`mp4, webm (video, max ${mb(uploadCap("video"))})`);
  if (kinds.includes("pdf")) parts.push(`pdf (a PDF document, max ${mb(uploadCap("pdf"))})`);
  if (kinds.includes("office")) parts.push(`pptx, docx, xlsx (a document from PowerPoint/Word/Excel, max ${mb(uploadCap("office"))})`);
  return parts.join("; ");
}

function unsupported(filename: string, kinds: UploadKind[]): ValidationError {
  const ext = extOf(filename);
  return new ValidationError(
    `unsupported file type ${ext ? `".${ext}"` : "(no extension)"} — allowed: ${supportedTypes(kinds)}.` +
      (ext === "svg" ? " SVG is not accepted (it can carry script)." : ""),
  );
}

/** The one 413 message for an oversized PDF, whichever gate refuses it. */
export function pdfTooLargeMessage(bytes?: number): string {
  const size = bytes === undefined ? "" : `${(bytes / (1024 * 1024)).toFixed(1)} MB, `;
  return `PDF too large (${size}max ${config.PDF_MAX_BYTES / (1024 * 1024)} MB)`;
}

/** The one 413 message for an oversized Office file, whichever gate refuses it. */
export function officeTooLargeMessage(bytes?: number): string {
  const size = bytes === undefined ? "" : `${(bytes / (1024 * 1024)).toFixed(1)} MB, `;
  return `Office file too large (${size}max ${config.OFFICE_MAX_BYTES / (1024 * 1024)} MB)`;
}

/**
 * The refusal for a file over its type's cap. Each route keeps the status it
 * always had: 400 for assets, 413 for documents.
 */
export function tooLargeError(kind: UploadKind, bytes?: number): AppError {
  if (kind === "pdf") return new PayloadTooLargeError(pdfTooLargeMessage(bytes));
  if (kind === "office") return new PayloadTooLargeError(officeTooLargeMessage(bytes));
  const video = kind === "video";
  const size = bytes === undefined ? "" : `${(bytes / (1024 * 1024)).toFixed(1)} MB, `;
  return new ValidationError(
    `${video ? "video" : "image"} too large (${size}max ${uploadCap(kind) / (1024 * 1024)} MB for ${video ? "video" : "images"})`,
  );
}

// ─── Resolving the bytes ───────────────────────────────────────────────────

/** Which route is asking: it decides the kinds accepted and how they're told apart. */
export type UploadRoute = "asset" | "pdf" | "office" | "any";

const ROUTE_KINDS: Record<UploadRoute, UploadKind[]> = {
  asset: ["image", "video"],
  pdf: ["pdf"],
  office: ["office"],
  any: ["image", "video", "pdf", "office"],
};

export interface UploadSource {
  filename?: unknown;
  content_base64?: unknown;
  url?: unknown;
}

export interface ResolvedUpload {
  bytes: Uint8Array;
  filename: string;
  kind: UploadKind;
}

/**
 * The kind for this file on this route. The PDF route judges by bytes, not
 * by name (a PDF named .txt is still a PDF — isPdf decides later), so any
 * name is "pdf" there; every other route goes by extension.
 */
function kindFor(filename: string, route: UploadRoute): UploadKind {
  if (route === "pdf") return "pdf";
  const kind = uploadKindOf(filename);
  if (!kind || !ROUTE_KINDS[route].includes(kind)) throw unsupported(filename, ROUTE_KINDS[route]);
  return kind;
}

/** Outbound fetch for `url` mode. An object so a test can stand in for the network. */
export const uploadNet = {
  fetch(url: string, maxBytes: number): Promise<Response> {
    return guardedFetch({ maxBytes, timeoutMs: 30_000, allowPrivate: false })(url, {
      headers: { "user-agent": "ContextNest-Upload/1" },
      // Whole-request ceiling; the socket timeout above only catches silence.
      signal: AbortSignal.timeout(120_000),
    });
  },
};

async function fetchUpload(raw: string, kind: UploadKind): Promise<Uint8Array> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("url is not a valid URL");
  }
  if (url.protocol !== "https:") throw new ValidationError("url must be an https:// URL");
  if (url.username || url.password) throw new ValidationError("url must not carry credentials");
  const cap = uploadCap(kind);
  let res: Response;
  try {
    res = await uploadNet.fetch(url.toString(), cap);
  } catch (err) {
    if (err instanceof OutboundBlockedError) {
      throw new ValidationError(`That URL can't be fetched: ${err.message}.`);
    }
    throw new ValidationError(`Couldn't fetch the URL (${(err as Error)?.message || "network error"}).`);
  }
  const drop = () => res.body?.cancel().catch(() => {});
  if (res.status >= 300 && res.status < 400) {
    void drop();
    throw new ValidationError("The URL redirects, and redirects are not followed — pass the final URL.");
  }
  if (!res.ok) {
    void drop();
    throw new ValidationError(`Fetching the URL failed (HTTP ${res.status}).`);
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    void drop();
    throw tooLargeError(kind, declared);
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        throw tooLargeError(kind, total);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof OutboundTooLargeError) throw tooLargeError(kind);
    if (err instanceof ValidationError || err instanceof PayloadTooLargeError) throw err;
    throw new ValidationError(`The download from the URL failed (${(err as Error)?.message || "network error"}).`);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function decodeBase64(raw: string, kind: UploadKind): Uint8Array {
  // Tolerate a data: URL and line-wrapped base64 — both are how agents
  // commonly hand bytes over.
  const clean = raw.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) {
    throw new ValidationError("content_base64 is not valid base64");
  }
  // Refuse on the decoded size BEFORE decoding, so an oversized body never
  // becomes a second buffer.
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  const decoded = Math.floor((clean.length * 3) / 4) - padding;
  if (decoded > uploadCap(kind)) throw tooLargeError(kind, decoded);
  return new Uint8Array(Buffer.from(clean, "base64"));
}

/** The leaf of a URL's path, for a URL upload that names no filename. */
function filenameFromUrl(raw: string): string {
  try {
    const leaf = new URL(raw).pathname.split("/").pop() || "";
    return decodeURIComponent(leaf);
  } catch {
    return "";
  }
}

/**
 * Bytes from a JSON upload body: exactly one of `content_base64` (with a
 * `filename`, whose extension decides the type) or `url` (filename optional —
 * the URL's own file name is used). Type and size are refused before any
 * bytes are fetched or decoded wherever they can be; `beforeBytes` runs the
 * caller's own refusals for the kind at that point too.
 */
export async function resolveUpload(
  src: UploadSource,
  route: UploadRoute,
  beforeBytes?: (kind: UploadKind) => Promise<void>,
): Promise<ResolvedUpload> {
  const b64 = typeof src.content_base64 === "string" && src.content_base64.length > 0 ? src.content_base64 : null;
  const url = typeof src.url === "string" && src.url.trim() ? src.url.trim() : null;
  if (src.content_base64 !== undefined && typeof src.content_base64 !== "string") {
    throw new ValidationError("content_base64 must be a string");
  }
  if (src.url !== undefined && typeof src.url !== "string") throw new ValidationError("url must be a string");
  if (src.filename !== undefined && typeof src.filename !== "string") {
    throw new ValidationError("filename must be a string");
  }
  if ((b64 === null) === (url === null)) {
    throw new ValidationError("Send exactly one of content_base64 (with filename) or url.");
  }
  let filename = typeof src.filename === "string" ? src.filename.trim() : "";
  if (!filename && url) filename = filenameFromUrl(url);
  if (!filename && route !== "pdf") {
    throw new ValidationError(
      b64
        ? "filename is required with content_base64 — its extension decides the file type."
        : "The URL has no file name; pass filename (its extension decides the file type).",
    );
  }
  const kind = kindFor(filename, route);
  await beforeBytes?.(kind);
  const bytes = b64 ? decodeBase64(b64, kind) : await fetchUpload(url!, kind);
  if (bytes.length === 0) throw new ValidationError("The file is empty.");
  return { bytes, filename, kind };
}

/** The non-file fields an upload can carry, from multipart or JSON. */
export interface UploadFields {
  title?: string;
  folder?: string;
  tags?: string[];
  nodeId?: string;
  changeNote?: string;
}

function str(v: unknown): string {
  const one = Array.isArray(v) ? v[0] : v;
  return typeof one === "string" ? one.trim() : "";
}

/** Tags from repeated fields, an array and/or a comma-separated list. */
function tagList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  return (Array.isArray(v) ? v : [v])
    .filter((x): x is string => typeof x === "string")
    .flatMap((s) => s.split(","))
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean);
}

function fieldsOf(body: Record<string, unknown>): UploadFields {
  const out: UploadFields = {};
  for (const k of ["title", "folder", "nodeId", "changeNote"] as const) {
    const v = str(body[k]);
    if (v) out[k] = v;
  }
  const tags = tagList(body.tags);
  if (tags) out.tags = tags;
  return out;
}

const MISSING_FILE: Record<Exclude<UploadRoute, "any">, string> = {
  asset: 'multipart field "file" (an image or video) is required',
  pdf: 'multipart field "file" (a PDF) is required',
  office: 'multipart field "file" (a .pptx, .docx or .xlsx) is required',
};

/**
 * The upload in a REST request, multipart or JSON. The route has already
 * capped the body as it streams; a multipart file is refused on `file.size`
 * before its bytes are copied.
 */
export async function readUploadRequest(
  c: Context,
  route: Exclude<UploadRoute, "any">,
): Promise<{ upload: ResolvedUpload; fields: UploadFields }> {
  const type = (c.req.header("Content-Type") || "").toLowerCase();
  if (type.startsWith("application/json")) {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ValidationError("The request body is not valid JSON.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ValidationError("The request body must be a JSON object.");
    }
    const b = body as Record<string, unknown>;
    return { upload: await resolveUpload(b, route), fields: fieldsOf(b) };
  }
  const body = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  const fileField = Array.isArray(body["file"]) ? body["file"][0] : body["file"];
  if (!(fileField instanceof File)) throw new ValidationError(MISSING_FILE[route]);
  const filename = fileField.name || "";
  const kind = kindFor(filename, route);
  // Size first — a File property, so an oversized upload is refused before
  // arrayBuffer() materializes a second copy of it.
  if (fileField.size > uploadCap(kind)) throw tooLargeError(kind, fileField.size);
  return {
    upload: { bytes: new Uint8Array(await fileField.arrayBuffer()), filename, kind },
    fields: fieldsOf(body),
  };
}

// ─── Writing ───────────────────────────────────────────────────────────────

export interface StoredAsset {
  file: string;
  url: string;
  markdown: string;
}

/** Store an image or video in the nest's asset store under a minted name. */
export async function storeAsset(nestId: string, upload: ResolvedUpload): Promise<StoredAsset> {
  const ext = extOf(upload.filename);
  if (!ASSET_CONTENT_TYPES[ext]) throw unsupported(upload.filename, ROUTE_KINDS.asset);
  if (upload.bytes.length > uploadCap(upload.kind)) throw tooLargeError(upload.kind, upload.bytes.length);
  const name = `${uuid()}.${ext === "jpeg" ? "jpg" : ext}`;
  const dir = join(resolveNestPath(nestId), "assets");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), upload.bytes);
  const url = `/nests/${nestId}/assets/${name}`;
  const alt = (upload.filename.split(/[/\\]/).pop() || "").replace(/\.[^.]+$/, "").replace(/[[\]]/g, "");
  return {
    file: name,
    url,
    // Ready-to-paste reference: image syntax for images; videos are
    // referenced by bare URL on its own line (the read view upgrades
    // same-origin asset video URLs to a <video> player).
    markdown: upload.kind === "video" ? url : `![${alt}](${url})`,
  };
}

/** A readable title from an uploaded file name ("Q3 report.pdf" → "Q3 report"). */
export function titleFromUploadFilename(name: string): string {
  return (name.split(/[/\\]/).pop() || "")
    .replace(/\.(pdf|pptx|docx|xlsx)$/i, "")
    .replace(/[_]+/g, " ")
    .trim()
    .slice(0, 200);
}

export interface SavedDocument {
  node: ContextNode;
  version: number;
  /** False when a pdf upload replaced an existing pdf node. */
  created: boolean;
  original?: OriginalFile;
}

/**
 * A PDF upload: a new `pdf` node, or (`nodeId`) a new version of one. The
 * bytes decide, not the name or the declared type: a PDF begins with %PDF-.
 * (The engine checks again, and also refuses encrypted/unreadable files.)
 */
export async function savePdfUpload(
  nestId: string,
  upload: ResolvedUpload,
  fields: UploadFields,
  userEmail: string,
  client?: ClientMetadata,
): Promise<SavedDocument> {
  if (upload.bytes.length > config.PDF_MAX_BYTES) throw tooLargeError("pdf", upload.bytes.length);
  if (!isPdf(upload.bytes)) {
    throw new ValidationError("That file is not a PDF (it does not start with %PDF-).");
  }
  const pdf = { bytes: upload.bytes, filename: upload.filename || undefined };
  // Replace: a new version of an existing pdf node, through updateNode — the
  // same review lock, draft/publish decision and version rows as any edit.
  if (fields.nodeId) {
    // The node-id chokepoint in app.ts guards path params only; this id
    // arrives in the body, so it is checked here before it becomes a path.
    assertSafeNodeId(fields.nodeId);
    const { node, version } = await updateNode(
      nestId,
      fields.nodeId,
      {
        pdf,
        ...(fields.title ? { title: fields.title } : {}),
        ...(fields.tags ? { tags: fields.tags } : {}),
        changeNote: fields.changeNote || "Replaced the PDF",
        client,
      },
      userEmail,
    );
    return { node, version, created: false };
  }
  const { node, version } = await createNode(
    nestId,
    {
      title: fields.title || titleFromUploadFilename(upload.filename) || "Untitled PDF",
      content: "",
      type: PDF_NODE_TYPE,
      ...(fields.tags ? { tags: fields.tags } : {}),
      ...(fields.folder ? { folder: fields.folder } : {}),
      client,
      pdf,
    },
    userEmail,
  );
  return { node, version, created: true };
}

/** A .pptx/.docx/.xlsx upload: always a new document. */
export async function saveOfficeUpload(
  nestId: string,
  upload: ResolvedUpload,
  fields: UploadFields,
  userEmail: string,
  client?: ClientMetadata,
): Promise<SavedDocument> {
  if (fields.nodeId) {
    throw new ValidationError("An Office upload always creates a new document; nodeId is not supported.");
  }
  if (upload.bytes.length > config.OFFICE_MAX_BYTES) throw tooLargeError("office", upload.bytes.length);
  const made = await createOfficeDocument(
    nestId,
    {
      bytes: upload.bytes,
      filename: upload.filename,
      ...(fields.title ? { title: fields.title } : {}),
      ...(fields.folder ? { folder: fields.folder } : {}),
      ...(fields.tags ? { tags: fields.tags } : {}),
      ...(client ? { client } : {}),
    },
    userEmail,
  );
  return { node: made.node, version: made.version, created: true, original: made.original };
}

/** The stewards block a document upload's 201 carries. */
export async function stewardsFor(nestId: string, nodeId: string) {
  const resolved = await stewardship.resolveStewardsForNode(nestId, nodeId);
  return resolved.length > 0
    ? resolved.map((r) => ({ email: r.steward.userEmail, role: r.steward.role, source: r.source }))
    : undefined;
}

/**
 * The agent-write gate for document uploads. A nest that holds agent writes
 * for confirmation queues them as pending pushes, which carry markdown, not
 * binaries — so an upload from an API key or an agent is refused instead of
 * slipping past the hold. A person in the web app (session cookie) and an
 * always-allowed key are not affected. Asset uploads write no document and
 * are not gated (as before).
 */
export async function assertDocumentUploadNotGated(params: {
  nestId: string;
  userId: string;
  keyId: string | null;
  agentSurface: boolean;
}): Promise<void> {
  if (!params.keyId && !params.agentSurface) return;
  if (!(await nestRequiresPushConfirmation(params.nestId))) return;
  if (await isPushAllowlisted(params.nestId, params.userId, params.keyId)) return;
  throw new ForbiddenError(
    "This nest holds agent writes for review, and a file upload can't be queued for it. Upload it from the web app, or ask a nest reviewer to always allow this key.",
  );
}
