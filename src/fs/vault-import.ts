import { rmSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
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
 *
 * `_suggestions` (underscore, so not caught by the dot rule) is the engine's
 * per-doc staged-suggestion store. It is a nest's own derived governance state
 * — importing another vault's copy would surface its old suggestions as
 * phantom external edits (with stale, unresolvable doc ids), so we skip it.
 */
export function isSkippedSegment(segment: string): boolean {
  return (
    segment.startsWith(".") ||
    segment === "node_modules" ||
    segment === "_suggestions"
  );
}

/**
 * Validate a client-supplied relative path and return its safe segments, or
 * null if it must be rejected. Guards against path traversal (`..`), absolute
 * paths, and non-content dirs (hidden/node_modules) — `.versions` (engine
 * history) and `.context` (nest config) are allowed so they survive the import.
 */
const ALLOWED_DOT_DIRS = new Set([".versions", ".context"]);
function safeSegments(rel: string): string[] | null {
  if (!rel || isAbsolute(rel)) return null;
  const segs = rel.split(/[\\/]/).filter(Boolean);
  if (!segs.length) return null;
  for (const s of segs) {
    if (s === "..") return null;
    if (!ALLOWED_DOT_DIRS.has(s) && isSkippedSegment(s)) return null;
  }
  return segs;
}

/** Files written per parallel batch — see writeImportedFiles.
 *  NOTE: fixed batch of 32; tune if a huge vault exhausts file handles. */
const WRITE_CONCURRENCY = 32;

/**
 * Write the files uploaded from a browser folder pick into the nest's own
 * storage under DATA_ROOT, preserving relative structure so document ids stay
 * stable. Unsafe paths are skipped. Returns the number of files written.
 *
 * Both deployments write through `fs`, but on Cloud Run `NEST_STORAGE_ROOT` is
 * a gcsfuse-mounted bucket where every mkdir/write is a network round-trip. So
 * the write is shaped to minimise round-trips regardless of backend:
 *   1. resolve+validate every target first (pure, no I/O),
 *   2. mkdir each DISTINCT parent dir once (a per-file mkdir turned 300 files
 *      in one folder into 300 network calls),
 *   3. write files in bounded-parallel batches so the round-trips overlap
 *      instead of serialising — the single biggest win on the bucket mount.
 */
export async function writeImportedFiles(
  dest: string,
  files: ImportedFile[],
): Promise<number> {
  const targets: Array<{ full: string; content: string }> = [];
  const skipped: string[] = [];
  for (const f of files) {
    const segs = safeSegments(f?.path || "");
    if (!segs) {
      skipped.push(f?.path || "(empty)");
      continue;
    }
    targets.push({ full: join(dest, ...segs), content: f.content ?? "" });
  }

  // One mkdir per distinct directory, not per file.
  const dirs = new Set(targets.map((t) => dirname(t.full)));
  await Promise.all([...dirs].map((d) => mkdir(d, { recursive: true })));

  // Bounded-parallel writes. `written` increments are safe — JS runs them on a
  // single thread; only the awaited I/O overlaps.
  let written = 0;
  for (let i = 0; i < targets.length; i += WRITE_CONCURRENCY) {
    const batch = targets.slice(i, i + WRITE_CONCURRENCY);
    await Promise.all(
      batch.map(async (t) => {
        await writeFile(t.full, t.content, "utf-8");
        written++;
      }),
    );
  }

  console.log(
    `[import] writeImportedFiles: received=${files.length} written=${written} skipped=${skipped.length}`,
  );
  if (skipped.length) {
    console.log("[import] skipped (unsafe/hidden path):", skipped.join(", "));
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
