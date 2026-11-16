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
 * server-wide SLACK_WEBHOOK_URL and MSTEAMS_WEBHOOK_URL (super-admin
 * Settings) act as implicit slack/teams connectors for every nest, so the
 * simple one-channel setup needs no rows at all.
 */
import { isIP } from "node:net";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { envValues } from "../workflow/env-routes.js";
import { msTeamsPayload } from "./msteams.js";
import { escapeMrkdwn } from "./slack.js";
import { senderFor } from "./outbound-log.js";
import { postWebhook, resolveNestName, testWebhook } from "./webhook.js";

export type ConnectorChannel = "slack" | "teams" | "webhook";

export interface ConnectorEvent {
  kind: string; // review_requested | review_approved | review_rejected | run_failed | …
  nestId: string;
  message: string; // human sentence, already composed by the caller
  subjectId?: string; // node id / run id the event is about
  actor?: string; // who did it
  /** The run that raised it, for the message log (when it isn't the subject). */
  runId?: string;
}

interface ConnectorRow {
  id: string;
  channel: ConnectorChannel;
  url: string;
  events: string;
  enabled: number;
}

const EVENT_EMOJI: Record<string, string> = {
  mention: ":speech_balloon:",
  review_requested: ":memo:",
  review_approved: ":white_check_mark:",
  review_rejected: ":x:",
  review_escalated: ":alarm_clock:",
  run_failed: ":rotating_light:",
  deletion_requested: ":wastebasket:",
  deletion_deleted: ":wastebasket:",
  deletion_declined: ":no_entry_sign:",
  access_requested: ":key:",
  access_approved: ":key:",
  access_denied: ":no_entry_sign:",
  agent_notify: ":bell:",
};

/** Kinds that go to a nest's OWN connector rows only, never the server-wide
 *  Slack/Teams webhooks: an agent's notification carries text a model wrote
 *  for that nest, and the server-wide channel is shared by every nest. */
const NEST_ONLY_KINDS = new Set(["agent_notify"]);

/** Event kinds review-service ALSO sends through notify.ts's debounced
 *  digest (notifyNestEvent) — i.e. the kinds a server-wide webhook already
 *  receives via that path. See the server-msteams block in dispatchEvent. */
const DIGEST_DELIVERED_KINDS = new Set([
  "review_requested",
  "review_escalated",
  "review_approved",
  "review_rejected",
  "deletion_requested",
  "deletion_deleted",
  "deletion_declined",
]);

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
    // Workflows-app incoming webhooks (the only kind Microsoft still issues)
    // expect the Bot Framework message envelope with an Adaptive Card — plain
    // {text} was an O365-connector shape and those were retired.
    return msTeamsPayload(nestName, `${EVENT_EMOJI[ev.kind] ?? ""} ${ev.message}`.trim());
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

/**
 * SSRF fence for outbound connector targets. The server POSTs these URLs
 * from its own network position, so an editor-supplied URL must not reach
 * loopback, RFC1918/link-local ranges, or the cloud metadata endpoint.
 *
 * Names and addresses are judged separately: a NAME is refused only for the
 * local suffixes below (so `fd-feeds.com` is a name, not an IPv6 prefix); an
 * ADDRESS literal is parsed and judged by range, including IPv4 hidden
 * inside IPv6 (mapped, compatible, NAT64, 6to4). A public DNS name that
 * RESOLVES to a private address is caught where the socket opens
 * (metacognition/net.ts guardedLookup), not here.
 */
export function isForbiddenConnectorHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal"))
    return true;
  const kind = isIP(h);
  if (kind === 4) return isPrivateIPv4(h);
  if (kind === 6) return isPrivateIPv6(h);
  return false;
}

/** Ranges no connector or agent may reach (IPv4, dotted quad). */
export function isPrivateIPv4(addr: string): boolean {
  const q = addr.split(".").map(Number);
  if (q.length !== 4 || q.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = q;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && q[2] === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking, often internal
  if (a >= 224) return true; // multicast (224/4), reserved (240/4), broadcast
  return false;
}

/** The eight 16-bit groups of an IPv6 literal, or null if it isn't one. */
export function ipv6Groups(addr: string): number[] | null {
  let a = addr.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isIP(a) !== 6) return null;
  const quad = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (quad) {
    const [b0, b1, b2, b3] = quad.slice(2).map(Number);
    a = `${quad[1]}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const parse = (part: string) => (part ? part.split(":").map((x) => parseInt(x, 16)) : []);
  let groups: number[];
  if (a.includes("::")) {
    const [head, tail] = a.split("::");
    const h = parse(head);
    const t = parse(tail);
    groups = [...h, ...Array(8 - h.length - t.length).fill(0), ...t];
  } else {
    groups = parse(a);
  }
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** The IPv4 address carried inside an IPv6 one (mapped, compatible, NAT64,
 *  6to4), or null. Exported for the agent fence's extra ranges. */
export function embeddedIPv4(addr: string): string | null {
  const g = ipv6Groups(addr);
  if (!g) return null;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6], g[7]); // ::ffff:a.b.c.d
  if (zero(0, 6) && (g[6] !== 0 || g[7] > 1)) return v4(g[6], g[7]); // ::a.b.c.d (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6], g[7]); // NAT64 64:ff9b::/96
  if (g[0] === 0x2002) return v4(g[1], g[2]); // 6to4 2002::/16
  return null;
}

/** Ranges no connector or agent may reach (IPv6 literal). */
export function isPrivateIPv6(addr: string): boolean {
  const g = ipv6Groups(addr);
  if (!g) return true;
  const inner = embeddedIPv4(addr);
  if (inner) return isPrivateIPv4(inner);
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // local-use NAT64 64:ff9b:1::/48
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo: tunnels to an address we can't vet
  return false;
}

/** True for an https URL whose host passes the SSRF fence. */
export function isSafeConnectorUrl(raw: string): boolean {
  if (!/^https:\/\//i.test(raw)) return false;
  try {
    return !isForbiddenConnectorHost(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/** Resolve a connector url: literal https URL or env:KEY via the env store
 *  (nest values over the server floor — exactly like tool credentials).
 *  The SSRF fence applies at DISPATCH time too, so an env-value swap can't
 *  smuggle a private target past creation-time validation. */
async function resolveUrl(nestId: string, raw: string): Promise<string | null> {
  if (raw.startsWith("env:")) {
    const key = raw.slice(4).trim();
    const env = await envValues(nestId);
    const v = env[key];
    return v && isSafeConnectorUrl(v) ? v : null;
  }
  return isSafeConnectorUrl(raw) ? raw : null;
}

/**
 * Could an event of this kind posted for this nest reach anything at all?
 * Callers that RATION dispatches ask first — a rate-limit token spent on a
 * fan-out with nowhere to go bills a no-op. Mirrors dispatchEvent's filters:
 * server-wide webhooks skip digest-delivered kinds, per-nest rows must
 * subscribe to the kind (or "*").
 */
export async function hasAnyConnector(nestId: string, kind: string): Promise<boolean> {
  if (
    (config.SLACK_WEBHOOK_URL || config.MSTEAMS_WEBHOOK_URL) &&
    !DIGEST_DELIVERED_KINDS.has(kind) &&
    !NEST_ONLY_KINDS.has(kind)
  ) {
    return true;
  }
  try {
    const rows = (await getDb().all(
      "SELECT events FROM connectors WHERE nest_id = ? AND enabled = 1",
      [nestId],
    )) as Pick<ConnectorRow, "events">[];
    return rows.some((r) => {
      try {
        const kinds = JSON.parse(r.events) as string[];
        return kinds.includes("*") || kinds.includes(kind);
      } catch {
        return false;
      }
    });
  } catch {
    return false; // table missing (mid-migration) — nothing to deliver to
  }
}

/**
 * Fire an event at every matching connector. Callers use `void dispatch(…)`
 * — never await in a request path beyond the row lookups; delivery is
 * backgrounded and failure-proof by construction.
 */
export async function dispatchEvent(ev: ConnectorEvent): Promise<void> {
  // A sealed personal nest: no server-wide or per-nest connector delivery
  // (re-review R3-H1b).
  {
    const { sealedNest } = await import("../surfaces/sealed.js");
    if (await sealedNest(ev.nestId)) return;
  }
  const db = getDb();
  const nestName = await resolveNestName(ev.nestId);
  // Message-log context: who caused it, and the run when a run is the subject.
  const logCtx = {
    nestId: ev.nestId,
    ...senderFor(ev.actor),
    runId: ev.runId ?? (ev.kind.startsWith("run_") ? (ev.subjectId ?? null) : null),
  };
  const serverWide = !DIGEST_DELIVERED_KINDS.has(ev.kind) && !NEST_ONLY_KINDS.has(ev.kind);

  // Implicit server-wide Slack + Microsoft Teams connectors (super-admin
  // Settings). MSTEAMS_*, never "teams": that name means user groups here.
  //
  // Review events are SKIPPED on both because review-service fires each of them
  // down BOTH paths — dispatchEvent (this file, immediate) AND notifyNestEvent
  // (notify.ts, debounced digest) — and both would land on the same server-wide
  // webhook, posting every review event twice. The digest path wins for those
  // kinds (it collapses bursts into one message); these implicit connectors
  // deliver only the kinds the digest path never sees (run_failed).
  // Per-nest connector rows below are unaffected: they are dispatch-only.
  if (config.SLACK_WEBHOOK_URL && serverWide) {
    void postWebhook(
      config.SLACK_WEBHOOK_URL,
      formatBody("slack", nestName, ev),
      "server-slack",
      logCtx,
    );
  }

  if (config.MSTEAMS_WEBHOOK_URL && serverWide) {
    void postWebhook(
      config.MSTEAMS_WEBHOOK_URL,
      formatBody("teams", nestName, ev),
      "server-msteams",
      logCtx,
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
    void postWebhook(url, formatBody(r.channel, nestName, ev), `connector:${r.id}`, {
      ...logCtx,
      channel: r.channel === "slack" ? "slack" : r.channel === "teams" ? "msteams" : "webhook",
    });
  }
}

/**
 * Send a test message to the server-wide Slack or Teams webhook and report
 * whether it landed — powers the "Send test" button in Settings. Uses the
 * SAVED webhook (so the admin saves first, then tests); reuses formatBody so
 * the test renders in the exact wire format real events do.
 */
export async function sendTestNotification(
  channel: "slack" | "teams",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const url =
    channel === "slack" ? config.SLACK_WEBHOOK_URL : config.MSTEAMS_WEBHOOK_URL;
  const label = channel === "slack" ? "Slack" : "Microsoft Teams";
  if (!url)
    return { ok: false, error: `Save a ${label} webhook URL first, then test.` };
  const ev: ConnectorEvent = {
    kind: "test",
    nestId: "",
    message: "Test notification from ContextNest — your connector is working.",
  };
  return testWebhook(url, formatBody(channel, "ContextNest", ev));
}
