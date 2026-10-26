import { accessSync, constants, existsSync, mkdirSync, readdirSync } from "fs";
import { dirname, join } from "path";

/** Thrown for an unusable data directory; index.ts prints its message without a stack. */
export class DataDirError extends Error {
  override name = "DataDirError";
}

/** How many unwritable paths to list before summarising the rest. */
const MAX_LISTED = 5;
/**
 * How many entries of a `children` directory to check (in readdir order,
 * which the filesystem decides). Each is one access() call, a network round
 * trip on FUSE/NFS storage, so boot cost stays bounded however many nests
 * there are. A volume chowned at the top only is caught by any of them.
 */
const MAX_CHILDREN = 50;

export interface WritableCheck {
  label: string;
  path: string;
  /** A file that may not exist yet: its directory is checked, and the file if present. */
  file?: boolean;
  /**
   * Also check the directory's immediate entries (each nest's directory under
   * NEST_STORAGE_ROOT). Not for DATA_ROOT, where an operator may mount a
   * read-only `access.yaml` or `.env` on purpose.
   */
  children?: boolean;
}

function code(err: unknown): string {
  return (err as NodeJS.ErrnoException).code ?? "error";
}

/**
 * Fail fast, with the fix, when the server can't write its data directories.
 *
 * The container image runs as uid 1000, not root. A bind mount, or a volume
 * written by an earlier image that ran as root, is owned by root, and without
 * this check the first symptom is a bare `SQLITE_READONLY` stack trace from
 * the DB driver, or a failed write deep inside a nest. Checked once at boot
 * (index.ts), never per request.
 *
 * Fatal (throws): a directory that can't be created or written; for a file,
 * its directory (SQLite creates -wal/-journal files beside it), the file and
 * its -wal/-shm/-journal companions when they exist.
 *
 * Warning (returned, the server still boots): with `children`, any of up to
 * MAX_CHILDREN entries that isn't writable — a top-level-only chown
 * leaves root-owned nests behind, but one odd entry (a deliberately read-only
 * nest, a stray file) shouldn't stop the whole server.
 *
 * Best effort: it reads permission bits (and EROFS), not ACLs or quotas, and
 * doesn't walk inside each nest.
 */
export function assertWritable(checks: WritableCheck[]): string | null {
  const fatal: string[] = [];
  const warn: string[] = [];
  const note = (into: string[], label: string, path: string, err: unknown) =>
    into.push(`${label} ${path} is not writable (${code(err)})`);

  for (const { label, path, file, children } of checks) {
    const dir = file ? dirname(path) : path;
    try {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
    } catch (err) {
      note(fatal, label, dir, err);
      continue;
    }
    if (file) {
      for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
        if (!existsSync(f)) continue;
        try {
          accessSync(f, constants.W_OK);
        } catch (err) {
          note(fatal, label, f, err);
        }
      }
      continue;
    }
    if (!children) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      note(fatal, label, dir, err);
      continue;
    }
    for (const name of entries.slice(0, MAX_CHILDREN)) {
      const child = join(dir, name);
      try {
        accessSync(child, constants.W_OK);
      } catch (err) {
        if (code(err) !== "ENOENT") note(warn, label, child, err);
      }
    }
  }
  if (fatal.length > 0) {
    throw new DataDirError(explain("The server can't write its data directory", fatal));
  }
  return warn.length > 0
    ? explain("Some nests can't be written, so edits to them will fail", warn)
    : null;
}

function explain(headline: string, problems: string[]): string {
  const unique = [...new Set(problems)];
  const listed = unique.slice(0, MAX_LISTED).map((p) => `  ${p}`);
  if (unique.length > MAX_LISTED) listed.push(`  …and ${unique.length - MAX_LISTED} more`);
  const uid = typeof process.getuid === "function" ? process.getuid() : "?";
  const gid = typeof process.getgid === "function" ? process.getgid() : "?";
  return [
    `${headline}, running as uid ${uid} gid ${gid}:`,
    ...listed,
    `Give that user ownership, e.g. \`chown -R ${uid}:${gid} <dir>\`. The container image runs as`,
    "1000:1000; a volume written by an older image that ran as root needs this once. On Kubernetes",
    "set podSecurityContext.fsGroup. See CONFIGURATION.md → Docker. If this check is wrong for your",
    "storage (it reads permission bits), SKIP_DATA_DIR_CHECK=1 skips it.",
  ].join("\n");
}
