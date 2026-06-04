import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join, dirname, isAbsolute } from "path";

/** One file uploaded by the browser's folder picker, path relative to the vault root. */
export interface ImportedFile {
  path: string;
  content: string;
}

/**
 * Shared rule for what counts as a non-content path segment in an imported
 * vault. Hidden dirs (.git, .obsidian, .context) and node_modules are skipped
 * by both flat discovery (FlatNestStorage) and the import write below, so the
 * two stay in lockstep. `.versions` is hidden but kept on the write path (it
 * carries governance history) — that exception lives where it's used, since
 * discovery must still skip it.
 */
export function isSkippedSegment(segment: string): boolean {
  return segment.startsWith(".") || segment === "node_modules";
}

/**
 * Validate a client-supplied relative path and return its safe segments, or
 * null if it must be rejected. Guards against path traversal (`..`), absolute
 * paths, and non-content dirs (hidden/node_modules) — `.versions` is allowed
 * so engine history survives the import.
 */
function safeSegments(rel: string): string[] | null {
  if (!rel || isAbsolute(rel)) return null;
  const segs = rel.split(/[\\/]/).filter(Boolean);
  if (!segs.length) return null;
  for (const s of segs) {
    if (s === "..") return null;
    if (s !== ".versions" && isSkippedSegment(s)) return null;
  }
  return segs;
}

/**
 * Write the files uploaded from a browser folder pick into the nest's own
 * storage under DATA_ROOT, preserving relative structure so document ids stay
 * stable. Unsafe paths are skipped. Returns the number of files written.
 */
export function writeImportedFiles(dest: string, files: ImportedFile[]): number {
  let written = 0;
  for (const f of files) {
    const segs = safeSegments(f?.path || "");
    if (!segs) continue;
    const full = join(dest, ...segs);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content ?? "", "utf-8");
    written++;
  }
  return written;
}

/** Remove a half-written import dir (best-effort rollback). */
export function discardImportDir(dest: string): void {
  try {
    rmSync(dest, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
