import { accessSync, constants, existsSync, mkdirSync } from "fs";

/**
 * Fail fast, with the fix, when the server can't write its data directories.
 *
 * The container image runs as uid 1000 (not root). A bind mount, or a volume
 * written by an earlier image that ran as root, is owned by root, and without
 * this check the first symptom is a bare `SQLITE_READONLY` stack trace from
 * the DB driver. Checked at boot only (index.ts), never per request.
 */
export function assertWritable(paths: { label: string; path: string; file?: boolean }[]): void {
  const problems: string[] = [];
  for (const { label, path, file } of paths) {
    try {
      if (file) {
        if (!existsSync(path)) continue; // created on first open, inside a dir checked separately
      } else {
        mkdirSync(path, { recursive: true });
      }
      accessSync(path, constants.W_OK);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "error";
      problems.push(`  ${label} ${path} is not writable (${code})`);
    }
  }
  if (problems.length === 0) return;
  const uid = typeof process.getuid === "function" ? process.getuid() : "?";
  const gid = typeof process.getgid === "function" ? process.getgid() : "?";
  throw new Error(
    [
      `The server can't write its data directory, running as uid ${uid} gid ${gid}:`,
      ...problems,
      `Give that user ownership, e.g. \`chown -R ${uid}:${gid} <dir>\` (the container image runs as 1000:1000;`,
      "volumes written by images before 2.3.0, which ran as root, need this once). On Kubernetes set",
      "podSecurityContext.fsGroup. See CONFIGURATION.md → Docker.",
    ].join("\n"),
  );
}
