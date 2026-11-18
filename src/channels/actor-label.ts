/**
 * Who a channel message is from, as a timeline shows it (PO-1179, AC-CH-06).
 *
 * Today every write is authored by a human login, and an agent is only the
 * `client.agent` label the transport recorded beside it (the API key's label,
 * the MCP `initialize` clientInfo.name, or what the caller sent; see
 * shared/client-metadata.ts). So a message written by an agent reads
 * "grok, on behalf of alice@acme.com", and one typed in the browser reads as
 * the person alone.
 *
 * This is the ONE seam for that display. Agent principals (separate work) will
 * replace the body of this function with a lookup of the agent behind the
 * write; callers already treat it as async and pass everything it may need, so
 * nothing else changes when it does.
 *
 * `agent` is self-reported and never authorizes anything: the human is always
 * named, because the human is who the write is attributed to.
 */
import type { ClientMetadata } from "../shared/client-metadata.js";

export interface ActorInput {
  /** The login the write is attributed to (the comment's `author`). */
  email: string;
  /** The caller attribution stored with the message, when there is any. */
  client?: ClientMetadata | null;
}

export interface ActorLabel {
  /** The person the write is attributed to. */
  human: string;
  /** The agent that wrote on their behalf, or null for the person themselves. */
  agent: string | null;
  /** Display text: "<agent>, on behalf of <human>", or "<human>". */
  label: string;
}

export async function resolveActorLabel(input: ActorInput): Promise<ActorLabel> {
  const human = input.email;
  const raw = input.client?.agent;
  const agent = typeof raw === "string" && raw.trim() ? raw.trim() : null;
  return {
    human,
    agent,
    label: agent ? `${agent}, on behalf of ${human}` : human,
  };
}
