import { MAX_FOLDER_DEPTH } from "./constants";

/**
 * Shared checks for a typed folder path ("gtm/deals"), used by every surface
 * that lets someone name a folder — New folder, and the Move dialog's inline
 * "New folder…" destination.
 *
 * `path` is the folder that will actually exist: the server derives it by
 * slugifying each segment, so the same rule runs here and the caller can show
 * it before anything is created. `error` is what the server would reject,
 * said before the round-trip.
 */

/** Mirrors the server's slugify (src/nodes/service.ts). */
function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Server bound on each folder/title segment. */
const MAX_SEGMENT_LENGTH = 100;

export interface FolderPathCheck {
  /** The folder as it will be created — slugified, separators normalized. */
  path: string;
  /** Blocking problem, or null when the path is usable. */
  error: string | null;
  /** True when the result differs from what was typed (worth showing). */
  rewritten: boolean;
}

export function checkFolderPath(raw: string): FolderPathCheck {
  const typed = raw
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  const path = typed.map(slugify).filter(Boolean).join("/");
  const rewritten = path !== raw.trim();
  const fail = (error: string): FolderPathCheck => ({ path, error, rewritten });

  // Empty = "nest root", never an error.
  if (typed.length === 0) return { path: "", error: null, rewritten: false };

  if (typed.some((s) => s === "." || s === "..")) {
    return fail('"." and ".." don\'t name a folder — use a name.');
  }
  if (!path) {
    return fail(
      "Folder paths are built from a-z and 0-9, so the name needs at least one of those.",
    );
  }
  const depth = path.split("/").length;
  if (depth > MAX_FOLDER_DEPTH) {
    const over = depth - MAX_FOLDER_DEPTH;
    return fail(
      `Folders may nest at most ${MAX_FOLDER_DEPTH} levels deep — this path is ${depth}. Remove ${over} level${over === 1 ? "" : "s"}.`,
    );
  }
  if (path.split("/").some((s) => s.length > MAX_SEGMENT_LENGTH)) {
    return fail(
      `Each folder level must be at most ${MAX_SEGMENT_LENGTH} characters.`,
    );
  }
  return { path, error: null, rewritten };
}
