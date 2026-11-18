/**
 * Memory snowball (team chat C6, PO-1199) — the shared text pieces: how a
 * message is quoted into a node body, and who to credit.
 *
 * The thread id is data (`source_thread`, the discussed-in edge), never body
 * text, the same rule promote follows. Names are display names resolved the
 * way the timeline shows them (channels/message-meta.ts), and the proposer
 * label comes from the one actor seam (channels/actor-label.ts): a person,
 * or "<agent>, on behalf of <person>" when the caller declared an agent.
 */
import type { ClientMetadata } from "../shared/client-metadata.js";
import { deserializeClient } from "../shared/client-metadata.js";
import { displayNames, namedActor } from "../channels/message-meta.js";
import type { ActorLabel } from "../channels/actor-label.js";
import { readableTime } from "../stream/promote.js";

export interface SourceMessage {
  id: string;
  author: string;
  body: string;
  created_at: string;
  client_json: string | null;
}

/** Most messages a body quotes (the rest are counted, not copied). */
export const MAX_QUOTED = 200;

export function quote(text: string): string {
  return String(text ?? "")
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

/** The caller as the proposer: display name, and the declared agent if any. */
export async function proposerLabel(email: string, client: ClientMetadata | undefined): Promise<ActorLabel> {
  const names = await displayNames([email]);
  return (await namedActor(email, client, names)).actor;
}

/** Messages quoted one by one with who wrote them and when. */
export async function quotedMessages(messages: SourceMessage[]): Promise<string> {
  const names = await displayNames(messages.map((m) => m.author));
  const quoted: string[] = [];
  for (const m of messages.slice(0, MAX_QUOTED)) {
    const who = (await namedActor(m.author, deserializeClient(m.client_json), names)).actor;
    quoted.push(`> **${who.label}** · ${readableTime(m.created_at)}\n${quote(m.body)}`);
  }
  const more = messages.length > MAX_QUOTED ? `\n\n…and ${messages.length - MAX_QUOTED} more message(s) in the thread.` : "";
  return `${quoted.join("\n\n") || "_The thread has no messages._"}${more}`;
}

/** "9 Nov 2026" from a stored time. */
export function readableDate(stored: string): string {
  return readableTime(stored).replace(/,.*$/, "");
}

export function nodeUrl(nestId: string, nodeId: string): string {
  return `/nest/${encodeURIComponent(nestId)}?doc=${encodeURIComponent(nodeId)}`;
}
