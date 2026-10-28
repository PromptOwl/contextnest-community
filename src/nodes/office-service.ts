/**
 * Office documents — a .pptx or .docx uploaded as a governed markdown
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
import { getDb } from "../db/client.js";
import type { ClientMetadata } from "../shared/client-metadata.js";
import { ensureNodeIndex } from "./node-index.js";
import { extractOffice, OfficeFileError, type OfficeKind } from "./office-extract.js";
import {
  createNode,
  isOriginalFile,
  ORIGINAL_FILE_NAME,
  type NodeMutationResult,
  type OriginalFile,
} from "./service.js";

export const OFFICE_CONTENT_TYPES: Record<OfficeKind, string> = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const KIND_LABEL: Record<OfficeKind, string> = { pptx: "PowerPoint", docx: "Word" };

/** The Office kind a file name claims, or null. Legacy .ppt/.doc and the
 *  macro-enabled .pptm/.docm are not accepted. */
export function officeKindOf(filename: string): OfficeKind | null {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  return ext === "pptx" || ext === "docx" ? ext : null;
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
    .replace(/\.(pptx|docx)$/i, "")
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

/**
 * Extract, store the original, and create the document. Nothing is written
 * when the file is refused; the stored original is removed again if the create
 * fails. Size is the caller's to check (the route answers 413 before parsing).
 */
export async function createOfficeDocument(
  nestId: string,
  upload: OfficeUpload,
  userEmail: string,
): Promise<NodeMutationResult & { original: OriginalFile }> {
  const kind = officeKindOf(upload.filename);
  if (!kind) {
    throw new ValidationError("Only .pptx and .docx files can be uploaded as Office documents.");
  }
  let extraction;
  try {
    extraction = await extractOffice(upload.bytes, kind);
  } catch (err) {
    if (err instanceof OfficeFileError) throw new ValidationError(err.message);
    throw err;
  }

  const file = `${uuid()}.${kind}`;
  const original: OriginalFile = {
    file,
    filename: displayName(upload.filename),
    kind,
    bytes: upload.bytes.length,
    sha256: `sha256:${createHash("sha256").update(upload.bytes).digest("hex")}`,
  };
  const summary =
    kind === "pptx"
      ? `${extraction.slides} slide${extraction.slides === 1 ? "" : "s"}`
      : "Word document";
  const content =
    `> Imported from **${original.filename}** (${KIND_LABEL[kind]}, ${summary}). ` +
    `[Download the original](${originalUrl(nestId, file)})\n\n${extraction.markdown}\n`;

  const dir = originalsDir(nestId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), upload.bytes, { flag: "wx" });
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
    await rm(join(dir, file), { force: true }).catch(() => {});
    throw err;
  }
}

/** The ids of the documents whose `metadata.original` names this file. */
async function nodesBinding(nestId: string, file: string): Promise<string[]> {
  await ensureNodeIndex(nestId);
  // The name is a validated uuid + extension: no LIKE wildcards in it. The
  // JSON is re-checked exactly below — the LIKE only narrows the scan.
  const rows = (await getDb().all(
    "SELECT node_id, frontmatter_json FROM node_index WHERE nest_id = ? AND frontmatter_json LIKE ?",
    [nestId, `%${file}%`],
  )) as Array<{ node_id: string; frontmatter_json: string }>;
  return rows
    .filter((r) => {
      try {
        const original = JSON.parse(r.frontmatter_json)?.metadata?.original;
        return isOriginalFile(original) && original.file === file;
      } catch {
        return false;
      }
    })
    .map((r) => r.node_id);
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
 * narrow who gets the file, never widen it.
 */
export async function readOriginal(
  nestId: string,
  file: string,
  caller: { userId: string; userEmail: string },
): Promise<ServedOriginal> {
  const notFound = () => new NotFoundError("Original file not found");
  if (!ORIGINAL_FILE_NAME.test(file)) throw new ValidationError("invalid original file name");
  const ids = await nodesBinding(nestId, file);
  if (ids.length === 0) throw notFound();
  for (const id of ids) {
    if (!(await canReadNode(nestId, id, caller.userId, caller.userEmail))) throw notFound();
  }
  const row = (await getDb().get(
    "SELECT frontmatter_json FROM node_index WHERE nest_id = ? AND node_id = ?",
    [nestId, ids[0]],
  )) as { frontmatter_json: string } | undefined;
  const original = row ? JSON.parse(row.frontmatter_json)?.metadata?.original : undefined;
  if (!isOriginalFile(original)) throw notFound();
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
