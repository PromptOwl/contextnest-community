/**
 * Decisions behind the API-only access panel (CU-wdqcq0314u), kept free of
 * React so they are unit-tested (test/headless-ui-logic.test.ts). The server
 * enforces every one of these; the panel only says so before the round trip.
 */

export const MAX_KEY_LABEL = 80;

/** Why the "Publish API-only" switch can't be turned on right now, or null.
 *  Turning it off is always allowed. Mirrors PUT /nests/:id/headless. */
export function headlessToggleBlockReason(
  visibility: string | undefined,
  currentlyEnabled: boolean,
): string | null {
  if (currentlyEnabled) return null;
  if (visibility && visibility !== "private") {
    return `This nest is ${visibility === "org" ? "open to your organization" : "public"}. Make it private first — an API-only nest is readable only with a key.`;
  }
  return null;
}

/** Client-side check for a new key's label, matching the server's rule. */
export function validateKeyLabel(raw: string): string | null {
  const label = raw.trim();
  if (!label) return "Give the key a name — who it's for (e.g. the buyer).";
  if (label.length > MAX_KEY_LABEL) return `Keep the name to ${MAX_KEY_LABEL} characters or fewer.`;
  return null;
}

/** "Never used" or "Last used <date>" for a key row. Server timestamps are
 *  UTC 'YYYY-MM-DD HH:MM:SS'. */
export function keyLastUsedLabel(lastUsedAt: string | null): string {
  if (!lastUsedAt) return "Never used";
  const d = new Date(lastUsedAt.replace(" ", "T") + "Z");
  return `Last used ${Number.isNaN(d.getTime()) ? lastUsedAt : d.toLocaleDateString()}`;
}

/** What to hand a buyer alongside a new key: the per-nest MCP URL and the
 *  two ctx commands that connect to it. */
export function connectSnippet(origin: string, nestId: string, apiKey: string): string {
  const url = `${origin.replace(/\/+$/, "")}/nests/${nestId}/mcp`;
  return [
    `export NEST_KEY=${apiKey}`,
    `ctx vault add my-nest --url ${url} --bearer-env NEST_KEY`,
    `ctx search "your question" --vault my-nest`,
  ].join("\n");
}
