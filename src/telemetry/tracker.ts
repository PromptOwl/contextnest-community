import { createHash } from "crypto";
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
export function trackEvent(
  event: string,
  data?: Record<string, unknown>,
): void {
  if (!config.TELEMETRY_ENABLED) return;

  try {
    const db = getDb();
    db.prepare(
      "INSERT INTO telemetry_events (event, data_json) VALUES (?, ?)",
    ).run(event, data ? JSON.stringify(data) : null);
  } catch {
    // Telemetry should never break the server
  }
}

/**
 * Flush pending telemetry events to PromptOwl.
 * Called on a timer from the main loop.
 */
export async function flushTelemetry(): Promise<void> {
  if (!config.TELEMETRY_ENABLED || !config.PROMPTOWL_KEY) return;

  const db = getDb();

  // Gather server stats
  const userCount =
    (db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number })?.c ||
    0;
  const nestCount =
    (db.prepare("SELECT COUNT(*) as c FROM nests").get() as { c: number })?.c ||
    0;

  // Gather unsent events (limit batch size)
  const events = db
    .prepare(
      "SELECT id, event, data_json, created_at FROM telemetry_events WHERE sent = 0 ORDER BY id LIMIT 100",
    )
    .all() as Array<{
    id: number;
    event: string;
    data_json: string | null;
    created_at: string;
  }>;

  if (events.length === 0 && userCount === 0) {
    console.log("[telemetry] skip flush: no events and no users");
    return;
  }

  const emailStmt = db.prepare("SELECT email FROM users WHERE id = ?");
  const emailCache = new Map<string, string | null>();
  const resolveEmail = (userId: unknown): string | null => {
    if (typeof userId !== "string" || !userId) return null;
    if (emailCache.has(userId)) return emailCache.get(userId) ?? null;
    const row = emailStmt.get(userId) as { email?: string } | undefined;
    const email = row?.email ?? null;
    emailCache.set(userId, email);
    return email;
  };

  const batchId = computeBatchId(events.map((e) => e.id));

  const payload = {
    server_key: config.PROMPTOWL_KEY,
    batch_id: batchId,
    timestamp: new Date().toISOString(),
    stats: { users: userCount, nests: nestCount },
    events: events.map((e) => {
      const data = e.data_json
        ? (JSON.parse(e.data_json) as Record<string, unknown>)
        : null;
      if (data && data.userId && !data.userEmail) {
        const email = resolveEmail(data.userId);
        if (email) data.userEmail = email;
      }
      return {
        event: e.event,
        data,
        at: e.created_at,
      };
    }),
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    console.log(`[telemetry] response: ${res.status} ${res.statusText}`);

    if (res.ok && events.length > 0) {
      const ids = events.map((e) => e.id);
      db.prepare(
        `UPDATE telemetry_events SET sent = 1 WHERE id IN (${ids.map(() => "?").join(",")})`,
      ).run(...ids);
      console.log(`[telemetry] marked ${ids.length} events as sent`);
    }
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
