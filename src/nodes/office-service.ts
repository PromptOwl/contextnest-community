/**
 * Office documents — a .pptx, .docx or .xlsx uploaded as a governed markdown
 * document, with the original kept beside it as a download.
 *
 * The text is extracted here (office-extract.ts) rather than by an engine op:
 * unlike a pdf node, the result is an ordinary `document` whose body is the
 * extracted markdown, so it goes through createNode exactly like a typed
 * document — same governance, same version rows, editable afterwards. The
 * original file is provenance, not the source of the body:
 *
 *   - stored once, under a server-minted name, at <nest>/.originals/<uuid>.<kind>
 *     (a dot-folder, so no folder listing ever shows it);
 *   - bound to the document by `metadata.original` {file, filename, kind,
 *     bytes, sha256}, which is part of every version's hash;
 *   - served only through GET /nests/:nestId/originals/:file, which finds the
 *     document(s) binding that name and requires the caller to be able to
 *     read every one of them (canReadNode — so document-level stewardship and
 *     the public reader's approved-only rule apply), then verifies the sha256
 *     before answering as an attachment.
 *
 * The name is the link, not the node id, so a moved document's body link
 * keeps working.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { v4 as uuid } from "uuid";
import { resolveNestPath } from "../shared/paths.js";
import { AppError, NotFoundError, ValidationError } from "../shared/errors.js";
import { canReadNode } from "../governance/access-guard.js";
import { getApprovedVersion } from "../governance/version-service.js";
import { reconstructApproved } from "../governance/approved-body.js";
import { isPublicReader } from "../shared/access.js";
import { parseDocument } from "@promptowl/contextnest-engine";
import { engineCache } from "./engine.js";
import { getDb } from "../db/client.js";
import type { ClientMetadata } from "../shared/client-metadata.js";
import { ensureNodeIndex } from "./node-index.js";
import { extractOffice, OfficeFileError, type OfficeKind } from "./office-extract.js";
import {
  createNode,
  updateNode,
  isOriginalFile,
  ORIGINAL_FILE_NAME,
  type NodeMutationResult,
  type OriginalFile,
} from "./service.js";

export const OFFICE_CONTENT_TYPES: Record<OfficeKind, string> = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const KIND_LABEL: Record<OfficeKind, string> = { pptx: "PowerPoint", docx: "Word", xlsx: "Excel" };

/** The Office kind a file name claims, or null. Legacy .ppt/.doc/.xls and the
 *  macro-enabled .pptm/.docm/.xlsm are not accepted. */
export function officeKindOf(filename: string): OfficeKind | null {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  return ext === "pptx" || ext === "docx" || ext === "xlsx" ? ext : null;
}

function originalsDir(nestId: string): string {
  return join(resolveNestPath(nestId), ".originals");
}

/** The URL a document links its original at. */
export function originalUrl(nestId: string, file: string): string {
  return `/nests/${nestId}/originals/${file}`;
}

/** A file name safe to show inside markdown link text. */
function displayName(filename: string): string {
  const leaf = filename.split(/[/\\]/).pop() || "file";
  return leaf.replace(/[\u0000-\u001f\u007f[\]*_`<>\\|]/g, "").trim().slice(0, 200) || "file";
}

/** "Q3 deck.pptx" → "Q3 deck". */
export function titleFromOfficeFilename(name: string): string {
  return (name.split(/[/\\]/).pop() || "")
    .replace(/\.(pptx|docx|xlsx)$/i, "")
    .replace(/[_]+/g, " ")
    .trim()
    .slice(0, 200);
}

export interface OfficeUpload {
  bytes: Uint8Array;
  filename: string;
  title?: string;
  folder?: string;
  tags?: string[];
  client?: ClientMetadata;
}

const bodyHash = (body: string) => `sha256:${createHash("sha256").update(body.trim()).digest("hex")}`;

/**
 * Extract the file and store it under a fresh server-minted name. Nothing is
 * written when the file is refused; `discard` removes the stored copy again
 * when the write that was to bind it fails.
 */
async function storeOriginal(
  nestId: string,
  upload: OfficeUpload,
): Promise<{ kind: OfficeKind; original: OriginalFile; content: string; discard: () => Promise<void> }> {
  const kind = officeKindOf(upload.filename);
  if (!kind) {
    throw new ValidationError("Only .pptx, .docx and .xlsx files can be uploaded as Office documents.");
  }
  let extraction;
  try {
    extraction = await extractOffice(upload.bytes, kind);
  } catch (err) {
    if (err instanceof OfficeFileError) throw new ValidationError(err.message);
    throw err;
  }

  const file = `${uuid()}.${kind}`;
  const filename = displayName(upload.filename);
  const summary =
    kind === "pptx"
      ? `${extraction.slides} slide${extraction.slides === 1 ? "" : "s"}`
      : kind === "xlsx"
        ? `${extraction.sheets} sheet${extraction.sheets === 1 ? "" : "s"}`
        : "Word document";
  const content =
    `> Imported from **${filename}** (${KIND_LABEL[kind]}, ${summary}). ` +
    `[Download the original](${originalUrl(nestId, file)})\n\n${extraction.markdown}\n`;
  const original: OriginalFile = {
    file,
    filename,
    kind,
    bytes: upload.bytes.length,
    sha256: `sha256:${createHash("sha256").update(upload.bytes).digest("hex")}`,
    body_sha256: bodyHash(content),
  };

  const dir = originalsDir(nestId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), upload.bytes, { flag: "wx" });
  const discard = () => rm(join(dir, file), { force: true }).catch(() => {});
  return { kind, original, content, discard };
}

/**
 * Extract, store the original, and create the document. Size is the caller's
 * to check (the route answers 413 before parsing).
 */
export async function createOfficeDocument(
  nestId: string,
  upload: OfficeUpload,
  userEmail: string,
): Promise<NodeMutationResult & { original: OriginalFile }> {
  const { kind, original, content, discard } = await storeOriginal(nestId, upload);
  try {
    const made = await createNode(
      nestId,
      {
        title: upload.title || titleFromOfficeFilename(upload.filename) || `Untitled ${KIND_LABEL[kind]} document`,
        content,
        ...(upload.tags ? { tags: upload.tags } : {}),
        ...(upload.folder ? { folder: upload.folder } : {}),
        ...(upload.client ? { client: upload.client } : {}),
        original,
      },
      userEmail,
    );
    return { ...made, original };
  } catch (err) {
    await discard();
    throw err;
  }
}

/**
 * Re-upload: the file becomes a new version of the document it was extracted
 * for — new body, new original — through updateNode, so permission, the
 * review lock and the draft/publish decision are exactly an edit's. The
 * earlier originals move to `previous_originals` and stay downloadable from
 * the versions that name them.
 */
export async function replaceOfficeDocument(
  nestId: string,
  nodeId: string,
  upload: OfficeUpload & { changeNote?: string },
  userEmail: string,
): Promise<NodeMutationResult & { original: OriginalFile; warnings: string[] }> {
  const { storage } = await engineCache.get(nestId);
  let node;
  try {
    node = await storage.readDocument(nodeId);
  } catch {
    throw new NotFoundError(`Node not found: ${nodeId}`);
  }
  const metadata = (node.frontmatter.metadata ?? {}) as Record<string, unknown>;
  const current = metadata.original;
  const kind = officeKindOf(upload.filename);
  if (!isOriginalFile(current)) {
    throw new ValidationError("That document wasn't created from an Office file, so a file can't replace its text.");
  }
  if (kind !== current.kind) {
    throw new ValidationError(`That document came from a .${current.kind} file; upload a .${current.kind} to replace it.`);
  }
  // Hand edits since the last upload are replaced; say so rather than lose them quietly.
  const warnings =
    current.body_sha256 && current.body_sha256 !== bodyHash(node.body ?? "")
      ? ["Edits made to the document since the last upload were replaced. Its version history still has them."]
      : [];
  const earlier = Array.isArray(metadata.previous_originals) ? metadata.previous_originals.filter(isOriginalFile) : [];

  const { original, content, discard } = await storeOriginal(nestId, upload);
  try {
    const made = await updateNode(
      nestId,
      nodeId,
      {
        content,
        original,
        previousOriginals: [current, ...earlier],
        ...(upload.title ? { title: upload.title } : {}),
        ...(upload.tags ? { tags: upload.tags } : {}),
        changeNote: upload.changeNote || `Replaced the ${KIND_LABEL[current.kind]} file`,
        ...(upload.client ? { client: upload.client } : {}),
      },
      userEmail,
    );
    return { ...made, original, warnings };
  } catch (err) {
    await discard();
    throw err;
  }
}

/** The originals a frontmatter names: the current one, then the earlier ones. */
function namedOriginals(frontmatter: any): OriginalFile[] {
  const m = frontmatter?.metadata ?? {};
  const earlier = Array.isArray(m.previous_originals) ? m.previous_originals : [];
  return [m.original, ...earlier].filter(isOriginalFile);
}

/** The documents naming this file, with the record each holds for it. */
async function nodesBinding(nestId: string, file: string): Promise<Array<{ id: string; original: OriginalFile }>> {
  await ensureNodeIndex(nestId);
  // The name is a validated uuid + extension: no LIKE wildcards in it. The
  // JSON is re-checked exactly below — the LIKE only narrows the scan.
  const rows = (await getDb().all(
    "SELECT node_id, frontmatter_json FROM node_index WHERE nest_id = ? AND frontmatter_json LIKE ?",
    [nestId, `%${file}%`],
  )) as Array<{ node_id: string; frontmatter_json: string }>;
  const out: Array<{ id: string; original: OriginalFile }> = [];
  for (const r of rows) {
    try {
      const hit = namedOriginals(JSON.parse(r.frontmatter_json)).find((o) => o.file === file);
      if (hit) out.push({ id: r.node_id, original: hit });
    } catch {
      // unreadable row: not a binding
    }
  }
  return out;
}

/** A public reader sees the approved version only, so only the file it names. */
async function approvedVersionNames(nestId: string, nodeId: string, file: string): Promise<boolean> {
  const approved = await getApprovedVersion(nestId, nodeId);
  if (approved == null) return false;
  try {
    const { versions } = await engineCache.get(nestId);
    const { raw } = await reconstructApproved(versions, nestId, nodeId, approved);
    const metadata = parseDocument(`${nodeId}.md`, raw, nodeId).frontmatter.metadata as { original?: { file?: string } } | undefined;
    return metadata?.original?.file === file;
  } catch {
    return false;
  }
}

export interface ServedOriginal {
  bytes: Buffer;
  original: OriginalFile;
}

/**
 * The original behind `file`, for this caller. 404 for a name that is not
 * server-minted, not bound to any document, or bound to one the caller can't
 * read — the three look the same, so probing names reveals nothing. When more
 * than one document binds the name (only possible by writing frontmatter by
 * hand), the caller must be able to read all of them: a second binding can
 * narrow who gets the file, never widen it. A public reader gets only the
 * file the approved version names — never a draft's re-upload or an older one.
 */
export async function readOriginal(
  nestId: string,
  file: string,
  caller: { userId: string; userEmail: string },
): Promise<ServedOriginal> {
  const notFound = () => new NotFoundError("Original file not found");
  if (!ORIGINAL_FILE_NAME.test(file)) throw new ValidationError("invalid original file name");
  const bindings = await nodesBinding(nestId, file);
  if (bindings.length === 0) throw notFound();
  const publicReader = await isPublicReader(nestId, caller.userId);
  for (const { id } of bindings) {
    if (!(await canReadNode(nestId, id, caller.userId, caller.userEmail))) throw notFound();
    if (publicReader && !(await approvedVersionNames(nestId, id, file))) throw notFound();
  }
  const { original } = bindings[0];
  let bytes: Buffer;
  try {
    bytes = await readFile(join(originalsDir(nestId), file));
  } catch {
    throw notFound();
  }
  const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actual !== original.sha256) {
    console.error("[office] integrity failure serving", nestId, file);
    throw new AppError(
      500,
      "This file no longer matches the document's record of it, so it is not being served. Ask an admin to check the nest.",
    );
  }
  return { bytes, original };
}
