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
import { isIP } from "node:net";
import { getDb } from "../db/client.js";
import { decryptSecret, encryptSecret } from "../shared/secret-box.js";
import { NotFoundError, ValidationError } from "../shared/errors.js";
import { isSafeConnectorUrl } from "../notify/dispatch.js";
import { webhookTarget } from "../notify/outbound-log.js";
import { isPrivateAddress } from "../metacognition/net.js";

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
      "url must be a public https:// URL — loopback, private, link-local and metadata addresses are refused.",
    );
  }
  return url;
}

export interface AgentWebhookView {
  handle: string;
  /** Host plus a short hash of the URL — never the URL itself. */
  target: string;
  created_by: string;
  created_at: string;
  updated_at: string;
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

async function toView(r: Row): Promise<AgentWebhookView> {
  let target = "webhook";
  try {
    target = webhookTarget(await decryptSecret(r.url_enc));
  } catch {
    /* unreadable row — show the placeholder */
  }
  return { handle: r.handle, target, created_by: r.created_by, created_at: r.created_at, updated_at: r.updated_at };
}

export async function listAgentWebhooks(nestId: string): Promise<AgentWebhookView[]> {
  const rows = (await getDb().all(
    "SELECT * FROM agent_webhooks WHERE nest_id = ? ORDER BY handle",
    [nestId],
  )) as Row[];
  return Promise.all(rows.map(toView));
}

function mintSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

/**
 * Save (create or replace) the target for a handle. A new target, or
 * `rotate: true`, mints a fresh signing secret and returns it — the only time
 * it is ever shown. Replacing just the URL keeps the secret the runner has.
 */
export async function putAgentWebhook(
  nestId: string,
  rawHandle: unknown,
  input: { url: unknown; rotate?: unknown },
  actorEmail: string,
): Promise<{ webhook: AgentWebhookView; secret?: string }> {
  const handle = parseAgentHandle(rawHandle);
  const url = parseAgentWebhookUrl(input.url);
  const db = getDb();
  const now = new Date().toISOString();
  const existing = (await db.get("SELECT * FROM agent_webhooks WHERE nest_id = ? AND handle = ?", [nestId, handle])) as
    | Row
    | undefined;
  let secret: string | undefined;
  if (!existing) {
    secret = mintSecret();
    await db.run(
      `INSERT INTO agent_webhooks (nest_id, handle, url_enc, secret_enc, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [nestId, handle, await encryptSecret(url), await encryptSecret(secret), actorEmail, now, now],
    );
  } else {
    if (input.rotate === true) secret = mintSecret();
    await db.run(
      "UPDATE agent_webhooks SET url_enc = ?, secret_enc = ?, updated_at = ? WHERE nest_id = ? AND handle = ?",
      [await encryptSecret(url), secret ? await encryptSecret(secret) : existing.secret_enc, now, nestId, handle],
    );
  }
  const row = (await db.get("SELECT * FROM agent_webhooks WHERE nest_id = ? AND handle = ?", [nestId, handle])) as Row;
  return { webhook: await toView(row), ...(secret ? { secret } : {}) };
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
