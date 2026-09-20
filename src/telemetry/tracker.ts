import { createHash, randomUUID } from "crypto";
import { hostname } from "os";
import { config } from "../config.js";
import { getDb } from "../db/client.js";

// Deterministic batch_id from sorted event ids — same pending set across
// retries yields the same id, letting TheOwl dedupe meter rows via its
// partial unique index on (licenseKeyId, batchId, event, occurredAt).
// See TheOwl PR #981.
export function computeBatchId(ids: number[]): string {
  const key = ids.slice().sort((a, b) => a - b).join(",");
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/**
 * Record a telemetry event. Events are stored locally and batched to PromptOwl.
 * No document content is ever sent — only usage stats and event types.
 */
export async function trackEvent(
  event: string,
  data?: Record<string, unknown>,
): Promise<void> {
  if (!config.TELEMETRY_ENABLED) return;

  try {
    const db = getDb();
    await db.run(
      "INSERT INTO telemetry_events (event, data_json) VALUES (?, ?)",
      [event, data ? JSON.stringify(data) : null],
    );
  } catch {
    // Telemetry should never break the server
  }
}

type FlushEvent = {
  id: number;
  event: string;
  data: Record<string, unknown> | null;
  at: string;
};

/**
 * Stable, anonymous id for this install — same value across restarts, derived
 * from the license key (or the hostname when there isn't one). Used as the
 * PostHog distinct_id for events that carry no user.
 */
function serverId(): string {
  const seed = config.PROMPTOWL_KEY || hostname();
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

/**
 * Deterministic per-event uuid so a re-flushed batch (PromptOwl 5xx keeps the
 * events pending) dedupes in PostHog instead of double-counting — the same
 * reason the PromptOwl payload carries batch_id.
 */
function eventUuid(id: number): string {
  const h = createHash("sha256").update(`${serverId()}:${id}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Mirror the flushed batch to PostHog, plus one heartbeat carrying install
 * size so a quiet server still reports in. Same TELEMETRY_ENABLED switch as
 * everything else; no POSTHOG_KEY = off, which is the default.
 *
 * Only the event name and its stats properties go out — no document content,
 * and no email: PostHog gets the pseudonymous userId, the address is resolved
 * for PromptOwl's meter rows alone. Returns whether the batch was accepted.
 */
async function sendToPostHog(
  events: FlushEvent[],
  stats: { users: number; nests: number },
): Promise<boolean> {
  if (!config.POSTHOG_KEY) return false;

  const sid = serverId();
  const batch = events.map((e) => {
    const { userEmail: _email, ...props } = e.data ?? {};
    return {
      event: e.event,
      distinct_id:
        typeof e.data?.userId === "string" && e.data.userId
          ? e.data.userId
          : sid,
      timestamp: e.at,
      uuid: eventUuid(e.id),
      properties: { ...props, server_id: sid },
    };
  });
  batch.push({
    event: "server.heartbeat",
    distinct_id: sid,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    properties: { ...stats, server_id: sid },
  });

  const url = `${config.POSTHOG_HOST.replace(/\/$/, "")}/batch/`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: config.POSTHOG_KEY, batch }),
    });
    console.log(
      `[telemetry] posthog ${url} events=${batch.length} -> ${res.status}`,
    );
    return res.ok;
  } catch (err) {
    console.error("[telemetry] posthog send failed:", err);
    return false;
  }
}

/**
 * Flush pending telemetry events to PromptOwl and, when a project key is set,
 * to PostHog. Called on a timer from the main loop.
 */
export async function flushTelemetry(): Promise<void> {
  if (!config.TELEMETRY_ENABLED) return;
  if (!config.PROMPTOWL_KEY && !config.POSTHOG_KEY) return;

  const db = getDb();

  // Gather server stats
  const userCount =
    ((await db.get("SELECT COUNT(*) as c FROM users")) as { c: number })?.c ||
    0;
  const nestCount =
    ((await db.get("SELECT COUNT(*) as c FROM nests")) as { c: number })?.c ||
    0;

  // Gather unsent events (limit batch size)
  const events = await db
    .all(
      "SELECT id, event, data_json, created_at FROM telemetry_events WHERE sent = 0 ORDER BY id LIMIT 100",
    ) as Array<{
    id: number;
    event: string;
    data_json: string | null;
    created_at: string;
  }>;

  if (events.length === 0 && userCount === 0) {
    console.log("[telemetry] skip flush: no events and no users");
    return;
  }

  const emailCache = new Map<string, string | null>();
  const resolveEmail = async (userId: unknown): Promise<string | null> => {
    if (typeof userId !== "string" || !userId) return null;
    if (emailCache.has(userId)) return emailCache.get(userId) ?? null;
    const row = await db
      .get("SELECT email FROM users WHERE id = ?", [userId]) as { email?: string } | undefined;
    const email = row?.email ?? null;
    emailCache.set(userId, email);
    return email;
  };

  // Stats-only flushes (no events) carry no meter rows, so no batch_id —
  // otherwise sha256("") would brand every heartbeat with the same constant id.
  const batchId =
    events.length > 0 ? computeBatchId(events.map((e) => e.id)) : null;

  const eventPayload = await Promise.all(
    events.map(async (e) => {
      const data = e.data_json
        ? (JSON.parse(e.data_json) as Record<string, unknown>)
        : null;
      if (data && data.userId && !data.userEmail) {
        const email = await resolveEmail(data.userId);
        if (email) data.userEmail = email;
      }
      return {
        event: e.event,
        data,
        at: e.created_at,
      };
    }),
  );

  const stats = { users: userCount, nests: nestCount };
  const posthogOk = await sendToPostHog(
    eventPayload.map((e, i) => ({ ...e, id: events[i].id })),
    stats,
  );

  const markSent = async (): Promise<void> => {
    if (events.length === 0) return;
    const ids = events.map((e) => e.id);
    await db.run(
      `UPDATE telemetry_events SET sent = 1 WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids,
    );
    console.log(`[telemetry] marked ${ids.length} events as sent`);
  };

  if (!config.PROMPTOWL_KEY) {
    // PostHog was the only sink, so retire the batch here — otherwise
    // telemetry_events grows forever on an unlicensed server.
    if (posthogOk) await markSent();
    return;
  }

  const payload = {
    server_key: config.PROMPTOWL_KEY,
    batch_id: batchId,
    timestamp: new Date().toISOString(),
    stats,
    events: eventPayload,
  };

  const promptowlUrl = config.PROMPTOWL_API_URL.replace(/\/$/, "");
  const url = `${promptowlUrl}/api/telemetry/ingest`;
  console.log(
    `[telemetry] POST ${url} events=${events.length} users=${userCount} nests=${nestCount}`,
  );
  console.log("[telemetry] payload:", JSON.stringify(payload, null, 2));

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: config.PROMPTOWL_FETCH_HEADERS,
      body: JSON.stringify(payload),
    });

    console.log(`[telemetry] response: ${res.status} ${res.statusText}`);

    if (res.ok) await markSent();
  } catch (err) {
    console.error("[telemetry] flush failed:", err);
  }
}

let telemetryTimer: ReturnType<typeof setInterval> | null = null;

export function startTelemetryLoop(): void {
  if (!config.TELEMETRY_ENABLED) return;

  // Initial flush after 30s
  setTimeout(() => flushTelemetry(), 30_000);

  // Then periodic
  telemetryTimer = setInterval(
    () => flushTelemetry(),
    config.TELEMETRY_INTERVAL_MS,
  );
}

export function stopTelemetryLoop(): void {
  if (telemetryTimer) {
    clearInterval(telemetryTimer);
    telemetryTimer = null;
  }
}
