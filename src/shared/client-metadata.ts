/**
 * `client` — caller attribution on reads and writes (CONTEXT_NEST_SPEC §9.4).
 *
 * `edited_by` names a PERSON (or a service account) and a read names nobody at
 * all, so neither answers "which agent, in which session" for a vault serving
 * several agents. Every REST write and every MCP tool call here accepts an
 * optional `client` object that does:
 *
 * ```json
 * { "title": "API Design", "content": "…",
 *   "client": { "agent": "claude-code", "session_id": "s-9f2" } }
 * ```
 *
 * Where it lands in this edition:
 *
 *  - a write that creates a version row records it on that row, so version
 *    history answers "which agent wrote v7" (`node_versions.client_json`);
 *  - every MCP tool call and every traced REST request records it on the
 *    activity trace (`api_events.client_json`) — this server's access trace,
 *    which is what gives READS attribution too.
 *
 * Three rules from the spec are load-bearing and MUST NOT be relaxed here:
 *
 *  1. It is a LABEL, never an identity claim. Nothing authenticates it and no
 *     access check ever reads it — authorization is stewardship + the
 *     authenticated user, as before.
 *  2. It is never an input to a hash. The engine's chain covers content and
 *     authoring facts; a history written before this field existed keeps
 *     verifying byte-for-byte.
 *  3. It is BOUNDED, because an untrusted caller writes it into an append-only
 *     audit trail. Scalars only, values ≤512 chars, ≤16 custom keys.
 *
 * Everything about it is optional — the object and each field within it. An
 * unattributed call is a valid call; nothing here may reject one.
 *
 * Distinct from `metadata`, which is frontmatter: `metadata` describes the
 * DOCUMENT, `client` describes the CALL that touched it.
 *
 * Mirrors `clientMetadataSchema` in the engine (PromptOwl/ContextNest,
 * `packages/engine/src/schemas.ts`) key for key and bound for bound. It is
 * defined here only because the published engine does not export
 * `@promptowl/contextnest-engine/api` yet — import it from there and delete
 * this schema once it ships, rather than letting the two drift.
 */
import { z } from "zod";
import type { Context } from "hono";
import { ValidationError } from "./errors.js";

/** Keys the spec reserves; everything else a caller sends is custom. */
export const CLIENT_RESERVED_KEYS = ["agent", "session_id"] as const;
/** How many CUSTOM keys a caller may attach beyond the reserved two. */
export const CLIENT_MAX_CUSTOM_KEYS = 16;
/** Longest string value accepted for any key. */
export const CLIENT_MAX_VALUE_LENGTH = 512;

export interface ClientMetadata {
  /** Name of the calling agent, e.g. "claude-code". */
  agent?: string;
  /** Identifier of the calling session, opaque to this server. */
  session_id?: string;
  /** Custom keys, recorded verbatim. */
  [key: string]: string | number | boolean | undefined;
}

const scalar = z.union([
  z.string().max(CLIENT_MAX_VALUE_LENGTH),
  z.number(),
  z.boolean(),
]);

export const clientMetadataSchema = z
  .object({
    agent: z.string().min(1).max(CLIENT_MAX_VALUE_LENGTH).optional(),
    session_id: z.string().min(1).max(CLIENT_MAX_VALUE_LENGTH).optional(),
  })
  .catchall(scalar)
  .superRefine((value, ctx) => {
    const reserved = new Set<string>(CLIENT_RESERVED_KEYS);
    const custom = Object.keys(value).filter((k) => !reserved.has(k));
    if (custom.length > CLIENT_MAX_CUSTOM_KEYS) {
      ctx.addIssue({
        code: "custom",
        message: `client accepts at most ${CLIENT_MAX_CUSTOM_KEYS} custom keys, got ${custom.length}`,
      });
    }
    // Refuse a near-miss on a reserved key. `sessionId` is a legal custom key
    // and WOULD be recorded — just not in the slot version history reads from,
    // so the write looks attributed and isn't. That is the one failure an open
    // catchall cannot catch by itself, and the caller never sees it happen.
    for (const key of custom) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      const collision = CLIENT_RESERVED_KEYS.find(
        (r) => r.replace(/[^a-z0-9]/g, "") === normalized,
      );
      if (collision) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `client key "${key}" looks like the reserved key "${collision}" — use "${collision}" exactly, or rename it`,
        });
      }
    }
  });

export const CLIENT_FIELD_DESCRIPTION =
  "Caller metadata recorded with this call: `agent` (name of the calling agent), " +
  "`session_id` (its session), plus any custom scalar keys. A write that creates " +
  "a version records it on that version; every call records it on the activity " +
  "trace. Optional, never authenticated, never used to authorize — describes the " +
  "CALL, unlike `metadata`, which describes the document.";

/** The `client` field as advertised on every MCP tool's input schema. */
export const clientField = clientMetadataSchema
  .optional()
  .describe(CLIENT_FIELD_DESCRIPTION);

/** Drop a `client` with nothing in it. "Not attributed" and "attributed to
 *  nobody" are different claims, and only the first one is ever true — so an
 *  empty object is stored as absence, not as `{}`. */
function orAbsent(value: ClientMetadata): ClientMetadata | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}

/**
 * Validate caller-supplied `client`. Throws ValidationError on a payload that
 * breaks the bounds; returns undefined when there is nothing to record.
 */
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

/**
 * Merge what the transport knows UNDER what the caller sent — per KEY, not per
 * object (§9.4.2). A caller that names its agent but no session keeps its agent
 * and still gains a session id.
 */
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
 * CONTEXTNEST_NO_ATTRIBUTION=1 turns derivation off entirely. That is a real
 * opt-out, not a tidiness knob: what is derived here lands in an append-only
 * history, so consent has to be available before the first write. It never
 * strips a `client` a caller sent explicitly — that is the caller's own record
 * to make.
 */
export function derivedClient(c: Context<any>): ClientMetadata {
  if (process.env.CONTEXTNEST_NO_ATTRIBUTION === "1") return {};
  const agent = process.env.CONTEXTNEST_AGENT || c.get("apiKeyLabel") || "";
  const session =
    process.env.CONTEXTNEST_SESSION_ID || c.req.header("Mcp-Session-Id") || "";
  return {
    // Truncated, not rejected: a derived value must never be the reason an
    // otherwise valid call fails validation.
    ...(agent ? { agent: agent.slice(0, CLIENT_MAX_VALUE_LENGTH) } : {}),
    ...(session
      ? { session_id: session.slice(0, CLIENT_MAX_VALUE_LENGTH) }
      : {}),
  };
}

/**
 * Caller `client` merged with the transport's defaults, validated, and stashed
 * on the request so the activity-trace middleware records the same block the
 * write does. Throws ValidationError on a payload that breaks the bounds.
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
