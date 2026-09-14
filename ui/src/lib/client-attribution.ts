/**
 * Rendering the `client` block a caller attached to a write or a read
 * (CONTEXT_NEST_SPEC §9.4) — which agent, in which session, plus custom keys.
 *
 * Shared by version history (the write that sealed a version) and the activity
 * trace (every call, which is where a read is attributed), so the two read the
 * same way.
 */
export type ClientAttribution = Record<string, string | number | boolean>;

/** "claude-code · s-9f2 · run=7" — agent first, then session, then any custom
 *  keys in the order the caller sent them. */
export function formatClient(client: ClientAttribution): string {
  const { agent, session_id, ...custom } = client;
  return [
    agent,
    session_id,
    ...Object.entries(custom).map(([k, v]) => `${k}=${v}`),
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ");
}
