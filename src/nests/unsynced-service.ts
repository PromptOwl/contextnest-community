import { readdirSync, readFileSync, rmSync, statSync, type Dirent } from "fs";
import { join, relative, resolve } from "path";
import { config } from "../config.js";
import { nestStorageRoot } from "../shared/paths.js";
import { ValidationError, NotFoundError } from "../shared/errors.js";
import { importNest, uniqueNestName } from "./service.js";
import { registerImportedDocuments } from "../nodes/service.js";
import type { ImportedFile } from "../fs/vault-import.js";
import type { Nest } from "../shared/types.js";

/**
 * A folder under DATA_ROOT that isn't a nest yet — usually dropped in by the
 * starter CLI or a manual copy. Surfaces in the dashboard so the user can sync
 * it (convert to a real nest with DB rows).
 */
export interface UnsyncedFolder {
  /** Path relative to DATA_ROOT, slash-separated (e.g. "nodes/architecture"). */
  name: string;
  /** Display label — leaf folder name (e.g. "architecture"). */
  label: string;
  /** Number of markdown files discovered recursively. */
  mdCount: number;
  /** Total size in bytes (markdown files only). */
  sizeBytes: number;
}

/** Top-level entries we never treat as syncable folders. */
const RESERVED = new Set(["nests"]);

/**
 * True when `absPath` IS the live nest vault root. Compared by resolved path,
 * not folder name: the default root (`<DATA_ROOT>/nests`) is already covered by
 * RESERVED, but a configured NEST_STORAGE_ROOT can point at a differently-named
 * folder under DATA_ROOT — and surfacing THAT as an "unsynced" candidate would
 * let a sync duplicate then delete every live nest. Guard by real path so any
 * name is caught.
 */
function isNestStorageRoot(absPath: string): boolean {
  return resolve(absPath) === resolve(nestStorageRoot());
}

/** Walk a directory recursively, counting .md files + total size. Skips dot dirs. */
function scanMarkdown(dir: string): { count: number; size: number } {
  let count = 0;
  let size = 0;
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { count, size };
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const sub = scanMarkdown(full);
      count += sub.count;
      size += sub.size;
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      try {
        size += statSync(full).size;
        count++;
      } catch {
        // unreadable file — ignore
      }
    }
  }
  return { count, size };
}

/** Whether `dir` contains any .md file as a direct child (no recursion). */
function hasDirectMarkdown(dir: string): boolean {
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(
    (e) => e.isFile() && e.name.toLowerCase().endsWith(".md"),
  );
}

/**
 * Surface a folder as a sync candidate if it has markdown directly inside.
 * Otherwise descend one level and apply the same rule to each subdir. This
 * matches how the starter CLI organizes templates — a parent folder like
 * `nodes/` groups several category folders (architecture/, standards/), and
 * the user wants each category to become its own nest, not one giant blob.
 */
function collectLeafFolders(rel: string, abs: string): UnsyncedFolder[] {
  if (hasDirectMarkdown(abs)) {
    const { count, size } = scanMarkdown(abs);
    const segments = rel.split("/").filter(Boolean);
    return [
      {
        name: rel,
        label: segments[segments.length - 1] || rel,
        mdCount: count,
        sizeBytes: size,
      },
    ];
  }
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: UnsyncedFolder[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    out.push(
      ...collectLeafFolders(`${rel}/${e.name}`, join(abs, e.name)),
    );
  }
  return out;
}

/**
 * List folders under DATA_ROOT that are candidates for sync. Excludes the
 * reserved `nests/` dir, dot-prefixed dirs, top-level files, and empty
 * folders. When a top-level dir has no markdown directly but contains
 * subfolders with markdown (e.g. `nodes/architecture/`), each subfolder is
 * returned as its own card so users can sync them independently.
 */
export function listUnsyncedFolders(): UnsyncedFolder[] {
  const root = config.DATA_ROOT;
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: UnsyncedFolder[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith(".")) continue;
    if (RESERVED.has(e.name)) continue;
    const abs = join(root, e.name);
    if (isNestStorageRoot(abs)) continue;
    out.push(...collectLeafFolders(e.name, abs));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  console.log(
    `[unsynced] discovered ${out.length} candidate folder(s) under ${root}`,
  );
  return out;
}

/**
 * Validate the path supplied by the client. Slash-separated segments are
 * allowed (so a leaf like "nodes/architecture" can sync), but every segment
 * is checked against the same rules as a single-name validation: no
 * traversal, no backslashes, no reserved top-level name, no dot-prefixed
 * segments anywhere.
 */
function assertSafeFolderName(name: string): void {
  if (!name || name.includes("\\")) {
    throw new ValidationError("Invalid folder name");
  }
  const segments = name.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new ValidationError("Invalid folder name");
  }
  if (RESERVED.has(segments[0])) {
    throw new ValidationError("Folder is not eligible for sync");
  }
  for (const seg of segments) {
    if (seg === ".." || seg.startsWith(".") || seg === "node_modules") {
      throw new ValidationError("Folder is not eligible for sync");
    }
  }
}

/** Recursively collect every .md file under `dir`, with paths relative to `root`. */
function collectMarkdownFiles(dir: string, root: string): ImportedFile[] {
  const out: ImportedFile[] = [];
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...collectMarkdownFiles(full, root));
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      try {
        const rel = relative(root, full);
        out.push({ path: rel, content: readFileSync(full, "utf-8") });
      } catch {
        // unreadable file — skip
      }
    }
  }
  return out;
}

/**
 * Convert a sibling folder under DATA_ROOT into a real nest. The folder's
 * markdown is imported (flat-layout import, like {@link importNest}), governance
 * rows are seeded, and the source folder is removed afterwards so the same
 * content can't be synced twice.
 */
export async function syncUnsyncedFolder(
  userId: string,
  folderName: string,
  callerEmail: string,
): Promise<{ nest: Nest; documents: number }> {
  console.log(
    `[unsynced] sync requested folder="${folderName}" user="${callerEmail}"`,
  );
  assertSafeFolderName(folderName);

  const src = join(config.DATA_ROOT, folderName);
  // Never sync (and then delete) the live nest vault root itself, even if a
  // NEST_STORAGE_ROOT under DATA_ROOT let it slip past name-based checks.
  if (isNestStorageRoot(src)) {
    throw new ValidationError("Folder is not eligible for sync");
  }
  let stat;
  try {
    stat = statSync(src);
  } catch {
    console.warn(`[unsynced] source missing: ${src}`);
    throw new NotFoundError(`Folder not found: ${folderName}`);
  }
  if (!stat.isDirectory()) {
    throw new ValidationError(`Not a directory: ${folderName}`);
  }

  const files = collectMarkdownFiles(src, src);
  console.log(
    `[unsynced] collected ${files.length} markdown file(s) from ${src}`,
  );
  if (files.length === 0) {
    throw new ValidationError(`Folder has no markdown to sync: ${folderName}`);
  }

  // Use the leaf segment as the nest's display name so a path like
  // "nodes/architecture" becomes a nest named "architecture", not the full
  // slashed path. If that name (or its slug) already exists for this user the
  // import would hit the UNIQUE(user_id, slug) constraint — uniqueNestName
  // picks the next free "<name> (n)" suffix so repeat syncs Just Work.
  const segments = folderName.split("/").filter(Boolean);
  const baseName = segments[segments.length - 1] || folderName;
  const nestName = await uniqueNestName(userId, baseName);
  if (nestName !== baseName) {
    console.log(
      `[unsynced] name "${baseName}" already in use, using "${nestName}" instead`,
    );
  }
  const nest = await importNest(userId, nestName, files);
  console.log(
    `[unsynced] nest created id=${nest.id} name="${nest.name}" from folder="${folderName}"`,
  );
  const documents = await registerImportedDocuments(nest.id, callerEmail);
  console.log(
    `[unsynced] registered ${documents} document(s) for nest ${nest.id}`,
  );

  // Source folder is the only piece left; once removed the sync is final. A
  // failure here is non-fatal — the nest is fully built, an orphan source dir
  // just means listUnsyncedFolders will still show it. Log and move on.
  try {
    rmSync(src, { recursive: true, force: true });
    console.log(`[unsynced] removed source folder ${src}`);
  } catch (err) {
    console.error("[unsynced] failed to remove source folder", src, err);
  }

  return { nest, documents };
}
