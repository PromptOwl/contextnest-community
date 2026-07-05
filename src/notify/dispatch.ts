/**
 * Connector dispatch — outbound notifications as composable bricks.
 *
 * One engine: a governance/workflow EVENT fires in a nest → every enabled
 * connector whose event list matches gets an HTTP POST, formatted for its
 * channel (slack mrkdwn / teams card / raw webhook JSON). Connector rows are
 * data, not code; their url may be a literal https URL or an "env:KEY"
 * reference into the SAME env store tool nodes use — secrets live in one
 * place, channels are presets, the tools layer stays lego.
 *
 * All delivery is fire-and-forget with a short timeout: an outage or a bad
 * URL must never slow down or fail the action that raised the event. The
 * server-wide SLACK_WEBHOOK_URL (super-admin Settings) acts as an implicit
 * slack connector for every nest, so the simple one-channel setup needs no
 * rows at all.
 */
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { envValues } from "../workflow/env-routes.js";

export type ConnectorChannel = "slack" | "teams" | "webhook";

export interface ConnectorEvent {
  kind: string; // review_requested | review_approved | review_rejected | run_failed | …
  nestId: string;
  message: string; // human sentence, already composed by the caller
  subjectId?: string; // node id / run id the event is about
  actor?: string; // who did it
}

interface ConnectorRow {
  id: string;
  channel: ConnectorChannel;
  url: string;
  events: string;
  enabled: number;
}

/** Slack mrkdwn treats <…> as control sequences (mass-pings, deceptive
 *  links); message text carries user-controlled fragments, so escape. */
function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const EVENT_EMOJI: Record<string, string> = {
  review_requested: ":memo:",
  review_approved: ":white_check_mark:",
  review_rejected: ":x:",
  run_failed: ":rotating_light:",
};

/** Channel presets: same event, three wire formats. */
function formatBody(
  channel: ConnectorChannel,
  nestName: string,
  ev: ConnectorEvent,
): unknown {
  const line = `[${nestName}] ${ev.message}`;
  if (channel === "slack") {
    return { text: escapeMrkdwn(`${EVENT_EMOJI[ev.kind] ?? ""} *[${nestName}]* ${ev.message}`) };
  }
  if (channel === "teams") {
    // Teams incoming webhooks accept simple text or MessageCard; text keeps
    // us schema-proof across the connector migration to Workflows.
    return { text: line };
  }
  // Raw webhook: the whole event, machine-readable — the integration brick.
  return {
    kind: ev.kind,
    nest_id: ev.nestId,
    nest_name: nestName,
    message: ev.message,
    subject_id: ev.subjectId ?? null,
    actor: ev.actor ?? null,
    at: new Date().toISOString(),
  };
}

/** Resolve a connector url: literal https URL or env:KEY via the env store
 *  (nest values over the server floor — exactly like tool credentials). */
async function resolveUrl(nestId: string, raw: string): Promise<string | null> {
  if (raw.startsWith("env:")) {
    const key = raw.slice(4).trim();
    const env = await envValues(nestId);
    const v = env[key];
    return v && /^https:\/\//i.test(v) ? v : null;
  }
  return /^https:\/\//i.test(raw) ? raw : null;
}

const warned = new Set<string>();

async function post(url: string, body: unknown, who: string): Promise<void> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if (!warned.has(who)) {
      warned.add(who);
      console.warn(
        `[connectors] delivery failed for ${who} (muting further warnings):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Fire an event at every matching connector. Callers use `void dispatch(…)`
 * — never await in a request path beyond the row lookups; delivery is
 * backgrounded and failure-proof by construction.
 */
export async function dispatchEvent(ev: ConnectorEvent): Promise<void> {
  const db = getDb();
  let nestName = ev.nestId;
  try {
    const row = (await db.get("SELECT name FROM nests WHERE id = ?", [ev.nestId])) as
      | { name?: string }
      | undefined;
    if (row?.name) nestName = row.name;
  } catch {
    /* cosmetic */
  }

  // Implicit server-wide slack connector (super-admin Settings).
  if (config.SLACK_WEBHOOK_URL) {
    void post(
      config.SLACK_WEBHOOK_URL,
      formatBody("slack", nestName, ev),
      "server-slack",
    );
  }

  let rows: ConnectorRow[] = [];
  try {
    rows = (await db.all(
      "SELECT id, channel, url, events, enabled FROM connectors WHERE nest_id = ? AND enabled = 1",
      [ev.nestId],
    )) as ConnectorRow[];
  } catch {
    return; // table missing (mid-migration) — implicit connector already fired
  }

  for (const r of rows) {
    let kinds: string[] = [];
    try {
      kinds = JSON.parse(r.events);
    } catch {
      /* malformed row — skip */
    }
    if (!kinds.includes("*") && !kinds.includes(ev.kind)) continue;
    const url = await resolveUrl(ev.nestId, r.url);
    if (!url) continue;
    void post(url, formatBody(r.channel, nestName, ev), `connector:${r.id}`);
  }
}
