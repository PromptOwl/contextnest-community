/**
 * What an API key can reach, in words — and the request that mints one.
 *
 * Two kinds of key (server: src/auth/nest-scope-guard.ts):
 *  - all nests (user-level): every nest you can see, plus the server-level MCP
 *    endpoint and account routes such as managing keys.
 *  - one nest: that nest only. Anywhere else the server answers 403. It can't
 *    create, rotate or revoke keys, and never reaches admin routes.
 */

/** Scope-picker value for a user-level key. */
export const ALL_NESTS = "__all__";

/** Mirrors MAX_LABEL_LENGTH in src/auth/keys.ts. */
const MAX_LABEL_LENGTH = 60;

export type KeyScope =
  | { kind: "all"; label: string }
  | { kind: "nest"; label: string; nestId: string };

export function keyScope(
  key: { nest_id: string | null },
  nests: ReadonlyArray<{ id: string; name?: string | null }> | undefined,
): KeyScope {
  if (!key.nest_id) return { kind: "all", label: "All your nests" };
  const name = nests?.find((n) => n.id === key.nest_id)?.name;
  return {
    kind: "nest",
    // A nest you no longer see (deleted, or unshared) still leaves the key
    // nest-only — say so rather than dropping the badge.
    label: `Nest: ${name || `${key.nest_id} (not in your list)`}`,
    nestId: key.nest_id,
  };
}

/** Body for POST /auth/keys. `scope` is ALL_NESTS or a nest id. */
export function createKeyRequest(
  label: string,
  scope: string,
): { label: string; nest_id?: string } {
  const trimmed = label.trim();
  return scope === ALL_NESTS ? { label: trimmed } : { label: trimmed, nest_id: scope };
}

/** A default name for a key minted from a nest's Connect dialog, unique among
 *  the caller's key names (the server refuses duplicates, case-insensitively). */
export function nestOnlyKeyLabel(
  nestName: string,
  taken: ReadonlyArray<string | null | undefined>,
): string {
  const used = new Set(taken.map((t) => (t ?? "").trim().toLowerCase()));
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? " only" : ` only ${i}`;
    const base = nestName.trim().slice(0, MAX_LABEL_LENGTH - suffix.length);
    const candidate = `${base}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export type KeyScopeFilter = "any" | "all" | "nest";
export type KeySort = "newest" | "name" | "last_used";

/** The API keys page's list controls: text search over name, prefix and
 *  scope label, a scope filter, then a sort. Never mutates `keys`. */
export function filterSortKeys<
  K extends { label: string | null; key_prefix: string; nest_id: string | null; created_at: string; last_used_at: string | null },
>(
  keys: ReadonlyArray<K>,
  nests: ReadonlyArray<{ id: string; name?: string | null }> | undefined,
  opts: { query: string; scope: KeyScopeFilter; sort: KeySort },
): K[] {
  const q = opts.query.trim().toLowerCase();
  const out = keys.filter((k) => {
    const reach = keyScope(k, nests);
    if (opts.scope !== "any" && reach.kind !== opts.scope) return false;
    return !q || [k.label ?? "", k.key_prefix, reach.label].some((s) => s.toLowerCase().includes(q));
  });
  // ISO strings compare chronologically; a never-used key sorts last.
  if (opts.sort === "name") out.sort((a, b) => (a.label ?? "").localeCompare(b.label ?? ""));
  else if (opts.sort === "last_used") out.sort((a, b) => (b.last_used_at ?? "").localeCompare(a.last_used_at ?? ""));
  else out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return out;
}
