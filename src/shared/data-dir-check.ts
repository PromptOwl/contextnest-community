import { accessSync, constants, existsSync, mkdirSync, readdirSync } from "fs";
import { dirname, join } from "path";

/** How many unwritable paths to list before summarising the rest. */
const MAX_LISTED = 5;
/**
 * How many entries of a `children` directory to check. Each is one access()
 * call, a network round trip on FUSE/NFS storage, so boot cost stays bounded
 * however many nests there are. A volume chowned at the top only is caught by
 * the first few nests.
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
 * For each directory: it's created if missing and must be writable; with
 * `children`, so must its first MAX_CHILDREN entries, since a top-level-only
 * chown leaves root-owned nests behind. Best effort: it reads permission bits
 * (and EROFS), not ACLs or quotas, and doesn't walk inside each nest. For a file: its directory must be writable
 * (SQLite creates -wal/-journal files beside it), and so must the file and its
 * -wal/-shm/-journal companions when they exist.
 */
export function assertWritable(checks: WritableCheck[]): void {
  const problems: string[] = [];
  const note = (label: string, path: string, err: unknown) =>
    problems.push(`${label} ${path} is not writable (${code(err)})`);

  for (const { label, path, file, children } of checks) {
    const dir = file ? dirname(path) : path;
    try {
      mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
    } catch (err) {
      note(label, dir, err);
      continue;
    }
    if (file) {
      for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
        if (!existsSync(f)) continue;
        try {
          accessSync(f, constants.W_OK);
        } catch (err) {
          note(label, f, err);
        }
      }
      continue;
    }
    if (!children) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      note(label, dir, err);
      continue;
    }
    for (const name of entries.slice(0, MAX_CHILDREN)) {
      const child = join(dir, name);
      try {
        accessSync(child, constants.W_OK);
      } catch (err) {
        if (code(err) !== "ENOENT") note(label, child, err);
      }
    }
  }
  if (problems.length === 0) return;

  const unique = [...new Set(problems)];
  const listed = unique.slice(0, MAX_LISTED).map((p) => `  ${p}`);
  if (unique.length > MAX_LISTED) listed.push(`  …and ${unique.length - MAX_LISTED} more`);
  const uid = typeof process.getuid === "function" ? process.getuid() : "?";
  const gid = typeof process.getgid === "function" ? process.getgid() : "?";
  throw new Error(
    [
      `The server can't write its data directory, running as uid ${uid} gid ${gid}:`,
      ...listed,
      `Give that user ownership, e.g. \`chown -R ${uid}:${gid} <dir>\`. The container image runs as`,
      "1000:1000; a volume written by an older image that ran as root needs this once. On Kubernetes",
      "set podSecurityContext.fsGroup. See CONFIGURATION.md → Docker.",
    ].join("\n"),
  );
}
