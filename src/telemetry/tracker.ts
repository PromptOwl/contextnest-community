import { config } from "../config.js";
import { getDb } from "../db/client.js";

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

  if (events.length === 0 && userCount === 0) return;

  const payload = {
    server_key: config.PROMPTOWL_KEY,
    timestamp: new Date().toISOString(),
    stats: { users: userCount, nests: nestCount },
    events: events.map((e) => ({
      event: e.event,
      data: e.data_json ? JSON.parse(e.data_json) : null,
      at: e.created_at,
    })),
  };

  try {
    const promptowlUrl = config.PROMPTOWL_API_URL.replace(/\/$/, "");
    const res = await fetch(`${promptowlUrl}/api/telemetry/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (res.ok && events.length > 0) {
      const ids = events.map((e) => e.id);
      db.prepare(
        `UPDATE telemetry_events SET sent = 1 WHERE id IN (${ids.map(() => "?").join(",")})`,
      ).run(...ids);
    }
  } catch {
    // Silently fail — telemetry is best-effort
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
