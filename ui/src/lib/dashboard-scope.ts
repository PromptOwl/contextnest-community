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
 * The scope the dashboard opens on: everything I can read. A first screen of
 * only "My nests" hid the org nests a team actually works in. Strangers' nests
 * stay legible rather than hidden — every card says whose it is (see
 * nestRelation), which is the "clearly distinguish" option CU-wdqcq02qzc
 * allowed. (CU-wdqcq05m8z, replacing the CU-wdqcq02mek default)
 */
export const DEFAULT_NEST_SCOPE: NestScope = "all";

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

/**
 * Whose nest a card is, for the label it carries: one I own, one someone
 * shared with me, or one I can only read because of its visibility tier
 * (org/public) — nobody invited me, so it must never read as "Shared by".
 */
export type NestRelation = "owned" | "shared" | "discovered";

export function nestRelation(n: ScopedNest): NestRelation {
  if (n.discovered) return "discovered";
  return nestOwned(n) ? "owned" : "shared";
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
      // Shared WITH me — someone granted it. A discovered nest is one I can
      // only read because of its visibility tier, which nobody chose to share
      // with me; listing it here would put every other customer's org nest in
      // a scope that reads as a personal invitation. (CU-wdqcq02mek)
      return !nestOwned(n) && !n.discovered;
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
 * Unsynced folders appear only in the "Unsynced folders only" view, and then
 * only when they match the text query (label or path). They aren't nests, so
 * the nest list (every other scope) never shows or counts them.
 */
export function visibleUnsynced(
  folders: UnsyncedFolder[],
  scope: NestScope,
  query: string,
): UnsyncedFolder[] {
  if (scope !== "unsynced") return [];
  const q = query.trim().toLowerCase();
  if (!q) return folders;
  return folders.filter(
    (f) =>
      f.label.toLowerCase().includes(q) || f.name.toLowerCase().includes(q),
  );
}

/**
 * The scope to open on, given the one remembered from last visit. Every scope
 * is remembered, broad ones included — the cards carry whose-nest labels, so
 * reopening on All/Organization/Public no longer passes strangers' nests off
 * as your own. Anything unrecognised falls back to the default.
 * (CU-wdqcq05m8z)
 */
const NEST_SCOPES: NestScope[] = [
  "all",
  "mine",
  "owned",
  "shared",
  "org",
  "public",
  "synced",
  "unsynced",
];
export function restoredNestScope(saved: string | null): NestScope {
  return NEST_SCOPES.includes(saved as NestScope) ? (saved as NestScope) : DEFAULT_NEST_SCOPE;
}
