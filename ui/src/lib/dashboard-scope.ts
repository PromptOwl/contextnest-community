/**
 * Dashboard grid scoping — pure, so the rule that is easiest to get wrong
 * stays testable without a browser.
 *
 * That rule: an unsynced folder is a directory sitting on disk, not a nest. It
 * has no owner, no collaborators and no visibility, so it cannot satisfy an
 * access scope and every one of them hides it. Rendering the raw list instead
 * left "Public" showing a grid of unsynced cards that matched nothing the
 * filter had asked for.
 */
import type { UnsyncedFolder } from "./api";

export type NestScope =
  | "all"
  | "owned"
  | "shared"
  | "public"
  | "synced"
  | "unsynced";

/** Registered nests are hidden only by the unsynced-only scope. */
export function scopeShowsNests(scope: NestScope): boolean {
  return scope !== "unsynced";
}

/**
 * Unsynced folders survive the unscoped and unsynced-only views only, and
 * then only when they match the text query (label or path).
 */
export function visibleUnsynced(
  folders: UnsyncedFolder[],
  scope: NestScope,
  query: string,
): UnsyncedFolder[] {
  if (scope !== "all" && scope !== "unsynced") return [];
  const q = query.trim().toLowerCase();
  if (!q) return folders;
  return folders.filter(
    (f) =>
      f.label.toLowerCase().includes(q) || f.name.toLowerCase().includes(q),
  );
}
