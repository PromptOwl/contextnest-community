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
  | "mine"
  | "owned"
  | "shared"
  | "org"
  | "public"
  | "synced"
  | "unsynced";

/**
 * The scope the dashboard opens on. "My nests" — owned or shared with me —
 * rather than everything I can read: on a shared server every customer's
 * org/public nest is readable, and a first screen full of strangers' nests
 * is noise at best and a leak of who else is here at worst. Discovery stays
 * one select away (Organization / Public / All). (CU-wdqcq02mek)
 */
export const DEFAULT_NEST_SCOPE: NestScope = "mine";

/** The shape of a nest row the scope rule needs — a subset of the list
 *  response so callers can pass the raw row. */
export interface ScopedNest {
  is_owner?: boolean;
  permission?: string | null;
  visibility?: string | null;
  /** Reachable through visibility alone — no membership (the dashboard's
   *  listPublicNests extras). */
  discovered?: boolean;
}

export function nestOwned(n: ScopedNest): boolean {
  return n.is_owner ?? (n.permission ?? "owner") === "owner";
}

/** Does this registered nest belong in the scope? The text query is applied
 *  separately; this is the access rule only. */
export function nestInScope(n: ScopedNest, scope: NestScope): boolean {
  switch (scope) {
    case "mine":
      return !n.discovered;
    case "owned":
      return nestOwned(n);
    case "shared":
      return !nestOwned(n);
    case "org":
      return n.visibility === "org";
    case "public":
      return n.visibility === "public";
    default:
      return true;
  }
}

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
