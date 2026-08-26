import { MAX_FOLDER_DEPTH } from "./constants";

/**
 * Shared checks for a typed folder path ("gtm/deals"), used by every surface
 * that lets someone name a folder — New folder, and the Move dialog's inline
 * "New folder…" destination.
 *
 * `path` is the normalized value to send: surrounding and repeated slashes
 * removed, each segment trimmed. `error` is what the server would reject, said
 * before the round-trip.
 */
export interface FolderPathCheck {
  /** Normalized path — what should actually be sent. */
  path: string;
  /** Blocking problem, or null when the path is usable. */
  error: string | null;
}

export function checkFolderPath(raw: string): FolderPathCheck {
  const segments = raw
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  const path = segments.join("/");

  if (!path) return { path, error: null }; // empty = "nest root", never an error

  if (segments.length > MAX_FOLDER_DEPTH) {
    const over = segments.length - MAX_FOLDER_DEPTH;
    return {
      path,
      error: `Folders may nest at most ${MAX_FOLDER_DEPTH} levels deep — this path is ${segments.length}. Remove ${over} level${over === 1 ? "" : "s"}.`,
    };
  }
  // The server derives folder paths by slugifying to a-z0-9, so a segment with
  // none of those ("!!!", "...", a purely non-Latin name) slugifies away and
  // the document silently lands somewhere else.
  if (segments.some((s) => !/[a-z0-9]/i.test(s))) {
    return {
      path,
      error:
        "Folder paths are built from a-z and 0-9, so every level needs at least one of those.",
    };
  }
  return { path, error: null };
}
