/**
 * Superadmin message log — one row per message the server sends, written at
 * the send choke points (email.ts, webhook.ts, notification inserts, persona
 * comments). It answers "what did we (and our agents) send, to whom, and did
 * it land?" from one place, GET /admin/messages.
 *
 * Privacy posture:
 *   - Bodies are REDACTED at write time (temp passwords, magic-link and other
 *     token query params, hook/API keys, Bearer tokens, webhook URLs) and
 *     capped at BODY_CAP bytes. A secret never reaches the table, so it can't
 *     leak through the UI, a backup, or a DB dump.
 *   - MESSAGE_LOG_STORE_BODIES=false keeps metadata only.
 *   - Retention is MESSAGE_LOG_RETENTION_DAYS (default 30). The view audit
 *     (message_log_views) is kept VIEW_AUDIT_RETENTION_DAYS (one year) so who
 *     read the log outlives what they read.
 *
 * Writes are best-effort: recordOutbound never throws into a send path. A
 * broken log must never cost a message.
 */
import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { config } from "../config.js";

export type OutboundChannel = "email" | "slack" | "msteams" | "webhook" | "inbox" | "comment";
export type SenderKind = "human" | "persona" | "system";
export type OutboundStatus = "sent" | "failed" | "skipped";

/** Who and what a message is about — optional context callers pass through. */
export interface OutboundContext {
  senderKind?: SenderKind;
  senderId?: string | null;
  nestId?: string | null;
  nodeId?: string | null;
  runId?: string | null;
}

export interface OutboundMessage extends OutboundContext {
  channel: OutboundChannel;
  recipients: string[];
  subject?: string | null;
  body?: string | null;
  status: OutboundStatus;
  providerId?: string | null;
  error?: string | null;
  /** The request left through an egress proxy (HTTPS_PROXY), when known. */
  viaProxy?: boolean | null;
  /** Exact values to scrub from the body (e.g. a temporary password). */
  secrets?: Array<string | null | undefined>;
}

export const BODY_CAP = 4096;
export const VIEW_AUDIT_RETENTION_DAYS = 365;
const PRUNE_EVERY = 200;
let insertsSincePrune = 0;

const R = "[REDACTED]";

// Query params whose value is a credential: magic links (?token=), invite and
// share links, OAuth-style codes and signatures. `#` covers fragments, `;`
// covers HTML-escaped `&amp;` (Slack text is escaped before it is logged).
const SECRET_NAMES =
  "token|t|key|code|secret|sig|signature|password|pwd|access_token|refresh_token|auth|invite_token|share_token|api_key|apikey|client_secret";
const SECRET_PARAM = new RegExp(`([?&#;](?:${SECRET_NAMES})=)[^&#\\s"'<>)]+`, "gi");
// The same names as JSON string values: {"token": "…"}.
const SECRET_JSON = new RegExp(`("(?:${SECRET_NAMES}|authorization)"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*"`, "gi");

// Hosts whose URL path IS the credential (incoming webhooks). The tail stops
// at an escaped `&gt;`/`&lt;`/`&quot;` so the hash matches the real URL.
const WEBHOOK_URL =
  /https?:\/\/(hooks\.slack\.com|[a-z0-9.-]*\.webhook\.office\.com|[a-z0-9.-]*\.logic\.azure\.com|discord(?:app)?\.com\/api\/webhooks)(?:[^\s"'<>)&]|&(?!gt;|lt;|quot;))*/gi;

/**
 * Scrub credentials out of a message body. Pure; exported for tests.
 * Order matters: exact secrets first (a temp password could look like
 * anything), then URL-shaped secrets, then token shapes.
 */
export function redact(text: string, secrets: Array<string | null | undefined> = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join(R);
  }
  out = out.replace(WEBHOOK_URL, (url) => webhookTarget(url));
  out = out.replace(SECRET_PARAM, `$1${R}`);
  out = out.replace(SECRET_JSON, `$1${R}"`);
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${R}`);
  // Basic credentials are base64: an upper-case, digit or +/= past the first
  // char spares prose ("Basic setup", "Basic Configuration").
  out = out.replace(/\b(?:Basic|basic|BASIC)\s+(?=\S[a-z]*[A-Z0-9+/=])[A-Za-z0-9+/]{8,}={0,2}/g, `Basic ${R}`);
  out = out.replace(/\bcnst_[A-Za-z0-9_-]+/g, `cnst_${R}`);
  out = out.replace(/\bhk_[A-Za-z0-9_-]+/g, `hk_${R}`);
  // Common provider key shapes that could ride in a feed or MCP echo.
  out = out.replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, `$1-${R}`);
  out = out.replace(/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, `xox-${R}`);
  out = out.replace(/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/g, `$1_${R}`);
  out = out.replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, `$1${R}`);
  return out;
}

/**
 * A webhook URL is a bearer credential: anyone holding it can post. Keep the
 * host (useful: which Slack/Teams) plus a short sha256 of the full URL (lets an
 * admin tell two webhooks apart or match one they hold), never the path.
 */
export function webhookTarget(url: string): string {
  let host = "webhook";
  try {
    host = new URL(url).host;
  } catch {
    /* not a URL — hash only */
  }
  const digest = createHash("sha256").update(url).digest("hex").slice(0, 12);
  return `${host}#${digest}`;
}

/**
 * Would a plain fetch to `url` leave through the egress proxy? Mirrors the
 * standard HTTPS_PROXY / HTTP_PROXY / NO_PROXY convention (comma list, `*`,
 * host or `.suffix`, optional :port). Informational only — recorded on the
 * row so an operator behind a corporate proxy can see which path a delivery
 * took; it never changes how anything is sent.
 */
export function viaProxy(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const proxy =
    u.protocol === "https:"
      ? env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
      : env.HTTP_PROXY || env.http_proxy;
  if (!proxy) return false;
  const host = u.hostname.toLowerCase();
  const noProxy = (env.NO_PROXY || env.no_proxy || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  for (const entry of noProxy) {
    if (entry === "*") return false;
    const name = entry.replace(/:\d+$/, "").replace(/^\*?\./, ".");
    if (name.startsWith(".") ? host.endsWith(name) || host === name.slice(1) : host === name) return false;
  }
  return true;
}

function cap(s: string): string {
  if (Buffer.byteLength(s, "utf8") <= BODY_CAP) return s;
  // Trim by bytes without splitting a multi-byte character.
  const buf = Buffer.from(s, "utf8").subarray(0, BODY_CAP);
  return `${buf.toString("utf8").replace(/�$/, "")}\n…[truncated]`;
}

function clean(value: string | null | undefined, secrets: OutboundMessage["secrets"]): string | null {
  return value ? cap(redact(value, secrets)) : null;
}

/** Record one outbound message. Never throws. */
export async function recordOutbound(m: OutboundMessage): Promise<void> {
  try {
    const db = getDb();
    const body = config.MESSAGE_LOG_STORE_BODIES ? clean(m.body, m.secrets) : null;
    await db.run(
      `INSERT INTO outbound_messages
         (id, channel, sender_kind, sender_id, recipients_json, subject, body_redacted,
          status, provider_id, error, nest_id, node_id, run_id, via_proxy, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid(),
        m.channel,
        m.senderKind ?? "system",
        m.senderId ?? null,
        JSON.stringify(m.recipients.map((r) => redact(r, m.secrets))),
        clean(m.subject, m.secrets),
        body,
        m.status,
        m.providerId ?? null,
        m.error ? cap(redact(m.error, m.secrets)) : null,
        m.nestId ?? null,
        m.nodeId ?? null,
        m.runId ?? null,
        m.viaProxy == null ? null : m.viaProxy ? 1 : 0,
        new Date().toISOString(),
      ],
    );
    if (++insertsSincePrune >= PRUNE_EVERY) {
      insertsSincePrune = 0;
      await pruneMessageLog();
    }
  } catch {
    /* the log must never break a send */
  }
}

/**
 * Drop rows past retention. Read per prune so an admin-settings change takes
 * effect live. MESSAGE_LOG_RETENTION_DAYS=0 keeps messages forever.
 */
export async function pruneMessageLog(now = Date.now()): Promise<void> {
  const db = getDb();
  const days = config.MESSAGE_LOG_RETENTION_DAYS;
  if (days > 0) {
    await db.run("DELETE FROM outbound_messages WHERE created_at < ?", [
      new Date(now - days * 86_400_000).toISOString(),
    ]);
  }
  await db.run("DELETE FROM message_log_views WHERE at < ?", [
    new Date(now - VIEW_AUDIT_RETENTION_DAYS * 86_400_000).toISOString(),
  ]);
}

/**
 * Classify a sender address: metacognition personas and access keys are
 * service identities with RFC 2606 `.invalid` addresses; no sender is the
 * system itself.
 */
export function senderFor(email: string | null | undefined): Pick<OutboundContext, "senderKind" | "senderId"> {
  if (!email) return { senderKind: "system", senderId: null };
  return { senderKind: /\.invalid$/i.test(email.trim()) ? "persona" : "human", senderId: email };
}
