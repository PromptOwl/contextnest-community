/**
 * Agent wake-up targets (PO-1181, agent team stream S3): the nest-level,
 * admin-only map from an agent @handle to the runner URL an @mention of it is
 * POSTed to.
 *
 * This is the stand-in until agent principals exist. When they do, the target
 * belongs on the agent itself, and the identity work replaces the default
 * resolver in agent-wake.ts (`setAgentWebhookResolver`) — this table then
 * only answers for nests that never moved over.
 *
 * Storage: `agent_webhooks` (migration 086). The URL and the signing secret
 * are both credentials — a runner URL often carries its own token, and the
 * secret is what proves a POST came from this server — so both are stored
 * encrypted (shared/secret-box) and neither is ever echoed back: a list shows
 * the host and a short hash of the URL (`webhookTarget`), and the secret is
 * returned exactly once, by the call that minted it.
 *
 * SSRF: a target must be a public https URL (`isSafeConnectorUrl`, the same
 * fence the notify connectors use) when it is saved, AND again when it is
 * used (agent-wake.ts), and the POST itself goes through the connect-time
 * guarded fetch so a public name that resolves to a private address is
 * refused where the socket opens.
 */
import { randomBytes } from "node:crypto";
import { isBroadcastName } from "../channels/broadcast.js";
import { isIP } from "node:net";
import { getDb } from "../db/client.js";
import { decryptSecret, encryptSecret } from "../shared/secret-box.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { config } from "../config.js";
import { resolveNestAccess } from "../shared/access.js";
import { isSystemUser } from "../auth/systems.js";
import { isSafeConnectorUrl } from "../notify/dispatch.js";
import { webhookTarget } from "../notify/outbound-log.js";
import { isPrivateAddress } from "../metacognition/net.js";
import { tryConsume } from "../shared/rate-limit.js";
import { AppError } from "../shared/errors.js";
import { lastDeliveries, sendAgentTestEvent, type DeliveryView } from "./agent-wake.js";

/** An agent handle as typed after "@": lowercase letters, digits, dot, dash,
 *  underscore. No "@" inside, so an email-shaped name (a person) never
 *  matches a target. */
const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export function parseAgentHandle(raw: unknown): string {
  const h = typeof raw === "string" ? raw.trim().replace(/^@/, "").toLowerCase() : "";
  if (!HANDLE_RE.test(h)) {
    throw new ValidationError(
      "handle is an agent's @name: 1–63 characters, lowercase letters, digits, dots, dashes or underscores.",
    );
  }
  // `@channel` / `@here` reach the nest's people (channels/broadcast.ts) and
  // never wake an agent, so a target under either name could never fire.
  if (isBroadcastName(h)) {
    throw new ValidationError(`"${h}" is reserved for reaching everyone in a channel; it can't be an agent's handle.`);
  }
  return h;
}

/** A target URL that may be saved: public https only (AC-ST-05). */
export function parseAgentWebhookUrl(raw: unknown): string {
  const url = typeof raw === "string" ? raw.trim() : "";
  // The connector fence, plus the agent fence's extra ranges (carrier-grade
  // NAT) for an address literal — the same set the connect-time guard
  // refuses, so a target that could never be delivered is refused up front.
  let literalPrivate = false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    literalPrivate = isIP(host) !== 0 && isPrivateAddress(host);
  } catch {
    /* not a URL — isSafeConnectorUrl refuses it below */
  }
  if (!url || url.length > 2048 || !isSafeConnectorUrl(url) || literalPrivate) {
    throw new ValidationError(
      "url must be a public https:// URL — loopback, private, link-local and metadata addresses are refused. " +
        "To test a runner on your own machine, expose it through a public tunnel (for example cloudflared or ngrok) and save the tunnel's https:// URL.",
    );
  }
  return url;
}

/**
 * The one gate for managing targets, shared by REST (/agent-webhooks) and MCP
 * (context_agent_webhooks): no named system key, then the nest owner or an
 * admin (uncapped standing, like the steward roster); an archived nest reads
 * but doesn't change. Open mode is the owner, as everywhere else.
 */
export async function assertCanManageAgentWebhooks(
  nestId: string,
  userId: string,
  opts: { write: boolean },
): Promise<void> {
  if (await isSystemUser(userId)) {
    throw new ForbiddenError("A system key can't manage this nest's people, settings, publishing, keys or automation.");
  }
  if (config.AUTH_MODE === "open") return;
  const access = await resolveNestAccess(nestId, userId);
  if (access.rawPermission !== "owner" && access.rawPermission !== "admin") {
    throw new ForbiddenError("Only a nest owner or admin can manage agent webhooks.");
  }
  if (opts.write && access.archived) throw new ForbiddenError("This nest is archived, so it is read-only.");
}

export interface AgentWebhookView {
  handle: string;
  /** Host plus a short hash of the URL — never the URL itself. */
  target: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  /** How the most recent wake-up or test POST to this handle ended; null
   *  when nothing has been sent yet (PO-1189, AC-UX-16). */
  last_delivery: DeliveryView | null;
}

interface Row {
  nest_id: string;
  handle: string;
  url_enc: string;
  secret_enc: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

async function toView(r: Row, deliveries: Map<string, DeliveryView>): Promise<AgentWebhookView> {
  let target = "webhook";
  try {
    target = webhookTarget(await decryptSecret(r.url_enc));
  } catch {
    /* unreadable row — show the placeholder */
  }
  return {
    handle: r.handle,
    target,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    last_delivery: deliveries.get(r.handle) ?? null,
  };
}

export async function listAgentWebhooks(nestId: string): Promise<AgentWebhookView[]> {
  const rows = (await getDb().all(
    "SELECT * FROM agent_webhooks WHERE nest_id = ? ORDER BY handle",
    [nestId],
  )) as Row[];
  const deliveries = await lastDeliveries(nestId);
  return Promise.all(rows.map((r) => toView(r, deliveries)));
}

/** One handle's row as the panel shows it, or null. */
export async function getAgentWebhook(nestId: string, rawHandle: unknown): Promise<AgentWebhookView | null> {
  const handle = parseAgentHandle(rawHandle);
  return (await listAgentWebhooks(nestId)).find((w) => w.handle === handle) ?? null;
}

function mintSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

/**
 * Save (create or replace) the target for a handle. A new target, or
 * `rotate: true`, mints a fresh signing secret and returns it — the only time
 * it is ever shown. Replacing just the URL keeps the secret the runner has.
 * `url` may be left out for a handle that already has one (rotate from the
 * row, PO-1189): the stored URL is kept, never sent back to be retyped.
 */
export async function putAgentWebhook(
  nestId: string,
  rawHandle: unknown,
  input: { url: unknown; rotate?: unknown },
  actorEmail: string,
): Promise<{ webhook: AgentWebhookView; secret?: string }> {
  const handle = parseAgentHandle(rawHandle);
  const db = getDb();
  const now = new Date().toISOString();
  const existing = (await db.get("SELECT * FROM agent_webhooks WHERE nest_id = ? AND handle = ?", [nestId, handle])) as
    | Row
    | undefined;
  const keepUrl = !!existing && (input.url === undefined || input.url === null || input.url === "");
  const url = keepUrl ? null : parseAgentWebhookUrl(input.url);
  let secret: string | undefined;
  if (!existing) {
    secret = mintSecret();
    await db.run(
      `INSERT INTO agent_webhooks (nest_id, handle, url_enc, secret_enc, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [nestId, handle, await encryptSecret(url!), await encryptSecret(secret), actorEmail, now, now],
    );
  } else {
    if (input.rotate === true) secret = mintSecret();
    await db.run(
      "UPDATE agent_webhooks SET url_enc = ?, secret_enc = ?, updated_at = ? WHERE nest_id = ? AND handle = ?",
      [
        url ? await encryptSecret(url) : existing.url_enc,
        secret ? await encryptSecret(secret) : existing.secret_enc,
        now,
        nestId,
        handle,
      ],
    );
  }
  return { webhook: (await getAgentWebhook(nestId, handle))!, ...(secret ? { secret } : {}) };
}

export async function deleteAgentWebhook(nestId: string, rawHandle: unknown): Promise<void> {
  const handle = parseAgentHandle(rawHandle);
  const res = await getDb().run("DELETE FROM agent_webhooks WHERE nest_id = ? AND handle = ?", [nestId, handle]);
  if (!res.changes) throw new NotFoundError("No webhook for that agent");
}

/** The stored target for a handle, decrypted, or null. Server-side only. */
export async function storedAgentWebhook(
  nestId: string,
  handle: string,
): Promise<{ url: string; secret: string } | null> {
  const row = (await getDb().get("SELECT * FROM agent_webhooks WHERE nest_id = ? AND handle = ?", [nestId, handle])) as
    | Row
    | undefined;
  if (!row) return null;
  try {
    return { url: await decryptSecret(row.url_enc), secret: await decryptSecret(row.secret_enc) };
  } catch (err) {
    console.error("[agent-wake] unreadable webhook row", nestId, handle, err);
    return null;
  }
}

/** Test events one handle, and one nest, may send per minute. */
export const TEST_EVENTS_PER_HANDLE = 5;
export const TEST_EVENTS_PER_NEST = 20;

/**
 * "Send test event" (PO-1189, AC-UX-16): one signed `agent.test` POST to the
 * handle's saved target, and how it went. NotFound when the handle has no
 * target. Rate limited per handle and per nest, so the button can't be used
 * to hammer whatever URL was saved; the target is never taken from the
 * request, and nothing the target answers is returned.
 */
export async function testAgentWebhook(
  nestId: string,
  rawHandle: unknown,
  actorEmail: string,
): Promise<{ ok: boolean; delivery: DeliveryView; webhook: AgentWebhookView | null }> {
  const handle = parseAgentHandle(rawHandle);
  const exists = await getDb().get("SELECT 1 AS ok FROM agent_webhooks WHERE nest_id = ? AND handle = ?", [nestId, handle]);
  if (!exists) throw new NotFoundError("No webhook for that agent");
  if (
    !tryConsume(`agent-webhook-test:${nestId}:${handle}`, { max: TEST_EVENTS_PER_HANDLE, windowMs: 60_000 }) ||
    !tryConsume(`agent-webhook-test:${nestId}`, { max: TEST_EVENTS_PER_NEST, windowMs: 60_000 })
  ) {
    throw new AppError(429, "Too many test events. Wait a minute and try again.");
  }
  const delivery = await sendAgentTestEvent(nestId, handle, actorEmail);
  if (!delivery) throw new NotFoundError("No webhook for that agent");
  return { ok: delivery.status === "ok", delivery, webhook: await getAgentWebhook(nestId, handle) };
}
