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
 * Only values the transport actually reports — an API key's label is what the
 * operator named that client, and `Mcp-Session-Id` is the client's own session
 * header. Nothing is synthesized: where the transport knows nothing the field
 * stays absent, because a reader cannot tell a made-up value from a real one.
 *
 * CONTEXTNEST_NO_ATTRIBUTION=1 turns derivation off, matching the upstream MCP
 * server's opt-out. What is derived lands in an append-only history, so consent
 * has to be available before the first write. It never strips a `client` a
 * caller sent explicitly — that is the caller's own record to make.
 */
export function derivedClient(c: Context<any>): ClientMetadata {
  if (process.env.CONTEXTNEST_NO_ATTRIBUTION === "1") return {};
  const agent = process.env.CONTEXTNEST_AGENT || c.get("apiKeyLabel") || "";
  const session =
    process.env.CONTEXTNEST_SESSION_ID || c.req.header("Mcp-Session-Id") || "";
  return {
    // Truncated to the engine's bound, not rejected: a derived value must never
    // be the reason an otherwise valid call fails validation.
    ...(agent ? { agent: agent.slice(0, CLIENT_METADATA_MAX_VALUE_LENGTH) } : {}),
    ...(session ? { session_id: session.slice(0, CLIENT_METADATA_MAX_VALUE_LENGTH) } : {}),
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
): ClientMetadata | undefined {
  const client = mergeClient(derivedClient(c), parseClientMetadata(supplied));
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
