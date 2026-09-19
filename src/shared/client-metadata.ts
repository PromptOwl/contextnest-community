/**
 * `client` — caller attribution (CONTEXT_NEST_SPEC §9.4), bound to this
 * server's transports.
 *
 * The FIELD is the engine's: `clientField`, `clientMetadataSchema` and its
 * bounds come from `@promptowl/contextnest-engine/api` and are never restated
 * here — one definition of what `client` accepts, shared by the CLI, the
 * upstream MCP server and this edition.
 *
 * What lives here is only what a binding owns and the engine cannot know:
 * what THIS transport can report about its caller (§9.4.2), and how this
 * server stores the block on its own version rows and activity trace.
 */
import {
  clientField,
  clientMetadataSchema,
  CLIENT_METADATA_MAX_VALUE_LENGTH,
  type ClientMetadata,
} from "@promptowl/contextnest-engine/api";
import type { Context } from "hono";
import { z } from "zod";
import { ValidationError } from "./errors.js";

export type { ClientMetadata } from "@promptowl/contextnest-engine/api";

/**
 * The `client` field as advertised on this server's MCP tool schemas.
 *
 * Re-declared rather than spread from the engine's `clientField` for ONE
 * reason: the engine builds its descriptors with zod 3 and this server's MCP
 * SDK builds tool shapes with zod 4, which refuses a mixed-version shape
 * ("Mixed Zod versions detected in object shape"). The engine's own
 * description rides along, and the schema below is advertisement only — every
 * call is validated against `clientMetadataSchema` itself in
 * `parseClientMetadata`, so the bounds stay the engine's. It also matches how
 * this repo's shape builders already declare every other non-scalar argument.
 *
 * Delete it and spread `clientField` directly once the engine ships on zod 4.
 */
export const clientToolField = {
  client: z.any().optional().describe(clientField.client.description ?? ""),
};

/**
 * Trim a derived value to the engine's bound without leaving half a character.
 *
 * The bound is in UTF-16 code units (zod's `.max` counts `String.length`), so
 * the slice has to come first — trimming by code point could still exceed it,
 * and an over-long derived value must never be the reason a call fails. What a
 * plain slice can do is cut between a surrogate pair, storing a lone surrogate
 * in an append-only audit record; drop that trailing half instead.
 */
function boundedValue(raw: string): string {
  const cut = raw.slice(0, CLIENT_METADATA_MAX_VALUE_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  // High surrogate with nothing after it: its pair was cut off.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Drop a `client` with nothing in it. "Not attributed" and "attributed to
 *  nobody" are different claims, and only the first one is ever true — so an
 *  empty object is stored as absence, not as `{}` (§9.4.2). */
function orAbsent(value: ClientMetadata): ClientMetadata | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

/** Validate against the engine's schema, raising this repo's error type. */
export function parseClientMetadata(raw: unknown): ClientMetadata | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parsed = clientMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
    throw new ValidationError(`Invalid client metadata — ${detail}`);
  }
  return orAbsent(parsed.data as ClientMetadata);
}

/** Transport defaults UNDER what the caller sent, merged per KEY (§9.4.2): a
 *  caller naming its agent but no session keeps its agent and gains a session. */
export function mergeClient(
  derived: ClientMetadata | undefined,
  supplied: ClientMetadata | undefined,
): ClientMetadata | undefined {
  return orAbsent({ ...derived, ...supplied });
}

/**
 * What this server's transport can honestly say about the caller (§9.4.2).
 *
 * Precedence per KEY is caller > env > connection, and `connection` is what the
 * protocol itself reported — on MCP, the `initialize` handshake's
 * `clientInfo.name` and the transport's session id (see `connectionClient`).
 * Behind those sits the one thing every credentialed request carries: the label
 * the operator gave the API key, which is what they named that client.
 *
 * Nothing is synthesized. Where the transport knows nothing the field stays
 * absent, because a reader cannot tell a made-up value from a real one — which
 * is why a REST call with no session concept records no `session_id` rather
 * than a placeholder.
 *
 * CONTEXTNEST_NO_ATTRIBUTION=1 turns derivation off, matching the upstream MCP
 * server's opt-out. What is derived lands in an append-only history, so consent
 * has to be available before the first write. It never strips a `client` a
 * caller sent explicitly — that is the caller's own record to make.
 */
export function derivedClient(
  c: Context<any>,
  connection?: ClientMetadata,
): ClientMetadata {
  if (process.env.CONTEXTNEST_NO_ATTRIBUTION === "1") return {};
  const agent =
    process.env.CONTEXTNEST_AGENT || connection?.agent || c.get("apiKeyLabel") || "";
  const session =
    process.env.CONTEXTNEST_SESSION_ID ||
    connection?.session_id ||
    c.req.header("Mcp-Session-Id") ||
    "";
  return {
    // Truncated to the engine's bound, not rejected: a derived value must never
    // be the reason an otherwise valid call fails validation.
    ...(agent ? { agent: boundedValue(String(agent)) } : {}),
    ...(session ? { session_id: boundedValue(String(session)) } : {}),
  };
}

/**
 * The MCP binding's own two facts (§9.4.2): the agent name the client gave in
 * its `initialize` handshake, and the session the transport is running.
 *
 * Read at CALL time, not when the server is built — the handshake completes
 * inside `transport.handleRequest`, so a value captured earlier is always
 * undefined. On a stateless connection (this server's default) neither may be
 * known, and then nothing is recorded from here: `clientInfo` belongs to a
 * handshake this request may not have carried, and inventing a session id for a
 * connection that has none is exactly what §9.4.2 forbids.
 *
 * `clientInfo.name` is the client's self-report, the same trust level as a
 * caller-supplied `agent` — which is why neither is ever used to authorize.
 */
export function connectionClient(server: {
  server: { getClientVersion(): { name?: string } | undefined; transport?: { sessionId?: string } };
}): ClientMetadata {
  const name = server.server.getClientVersion()?.name;
  const sessionId = server.server.transport?.sessionId;
  return {
    ...(name ? { agent: name } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

/**
 * Caller `client` merged with the transport's defaults, validated, and stashed
 * on the request so the activity-trace middleware records the same block the
 * write does. Throws ValidationError on a payload outside the engine's bounds.
 */
export function attributeRequest(
  c: Context<any>,
  supplied: unknown,
  connection?: ClientMetadata,
): ClientMetadata | undefined {
  const client = mergeClient(
    derivedClient(c, connection),
    parseClientMetadata(supplied),
  );
  if (client) c.set("clientMetadata", client);
  return client;
}

export function serializeClient(value: ClientMetadata | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}

/** Read a stored `client_json` column back. A corrupt row reads as "not
 *  attributed" rather than failing the history it annotates. */
export function deserializeClient(raw: unknown): ClientMetadata | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? orAbsent(parsed as ClientMetadata)
      : undefined;
  } catch {
    return undefined;
  }
}
