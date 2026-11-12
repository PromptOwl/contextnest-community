/**
 * Who wrote a version, as two names: the human who is accountable for it
 * (`editedBy`) and the agent that made the call (`client.agent`, spec §9.4).
 * OMP v0.2 §4.1 keeps these as separate provenance entries, and so does every
 * surface here: the human always comes first, and the agent never stands in
 * for the human.
 *
 * Pure, so the Compare dropdown, Version History and the document byline read
 * the same way and are tested without component infrastructure.
 */
import type { ClientAttribution } from "./client-attribution";
import { displayNameFor } from "./person-name";

export interface VersionAuthorLike {
  editedBy?: string | null;
  editedBySystem?: string | null;
  client?: ClientAttribution | null;
}

/** The agent a version's write named, or null when it named none. */
export function versionAgent(v: { client?: ClientAttribution | null }): string | null {
  const agent = v.client?.agent;
  if (agent === undefined || agent === null) return null;
  const s = String(agent).trim();
  return s ? s : null;
}

/** "misha via mkt-amplifier" for the Compare dropdown. The human is the
 *  system account's name or the email's local part, as before; with no agent
 *  this is exactly the old label. */
export function versionAuthorShort(v: VersionAuthorLike): string | null {
  const human = v.editedBySystem || v.editedBy?.split("@")[0] || null;
  const agent = versionAgent(v);
  if (human && agent) return `${human} via ${agent}`;
  if (agent) return `via ${agent}`;
  return human;
}

/** Hover text for a client block: every key, labelled, agent first. The
 *  session and custom keys live here so the row itself stays readable. */
export function clientTitle(client: ClientAttribution | null | undefined): string | undefined {
  if (!client) return undefined;
  const { agent, session_id, ...custom } = client;
  const parts = [
    agent !== undefined && agent !== "" ? `agent: ${agent}` : null,
    session_id !== undefined && session_id !== "" ? `session: ${session_id}` : null,
    ...Object.entries(custom).map(([k, val]) => `${k}: ${val}`),
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ") : undefined;
}

/** The latest version's attribution, as the node detail serves it. */
export interface LastEdit {
  version?: number;
  edited_by: string;
  edited_by_system?: string | null;
  edited_at?: string;
  client?: ClientAttribution | null;
}

/** The two names for the document byline: the human by display name (or the
 *  system account's name), then the agent. Null when there is no human to
 *  name — the byline then does not render. */
export function lastEditParts(
  last: LastEdit | null | undefined,
  people: Array<{ email: string; name?: string | null }> = [],
): { human: string; agent: string | null } | null {
  if (!last || !last.edited_by) return null;
  const human = last.edited_by_system || displayNameFor(last.edited_by, people);
  return { human, agent: versionAgent(last) };
}

/**
 * What a Documents row and a "Recently edited" item show about the last
 * edit: when, and who as one string — "<human> via <agent>", the human
 * first (po-1213). `at` falls back to the document's updated_at; `editor`
 * is null when the read withheld `last_edit` (a public reader, a headless
 * key), so nobody is named. Null when there is nothing to show at all.
 */
export function rowLastEdit(
  node: { updated_at?: string | null; last_edit?: LastEdit | null },
  people: Array<{ email: string; name?: string | null }> = [],
): { at: string | null; editor: string | null } | null {
  const parts = lastEditParts(node.last_edit, people);
  const at = node.last_edit?.edited_at || node.updated_at || null;
  if (!at && !parts) return null;
  return { at, editor: parts ? (parts.agent ? `${parts.human} via ${parts.agent}` : parts.human) : null };
}
