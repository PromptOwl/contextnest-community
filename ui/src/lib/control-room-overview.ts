/**
 * Control room (po-1186 CR2): the pure logic behind the Overview, Decision
 * ledger and Agents tabs. No React, no fetch, no path aliases — so the server
 * test suite can import it and check the figures against the real routes
 * (AC-CR-03) and the UI tests can pin the wording.
 *
 * Every figure here is a count of decision-ledger rows (the CR1 rollups and
 * ledger totals), so the tiles, the channel table, the rollups and the ledger
 * agree for the same range (AC-CR-10, "no numbers that disagree").
 */

// ─── Wire shapes (the subset of the CR1/CR2 responses the page reads) ─────

export interface LedgerTotals {
  entries: number;
  runs: number;
  failed: number;
  no_op: number;
  propose: number;
  act: number;
  escalate: number;
  error: number;
  none: number;
  proposals: number;
  approved: number;
  edited: number;
  rejected: number;
  expired: number;
  pending: number;
  withdrawn: number;
  cost_usd: number;
  tokens: number;
}

export interface RollupRow extends LedgerTotals {
  bucket: string;
  key: string;
  label: string | null;
  nest_id: string | null;
  last_at: string;
  source: string;
}

export interface BindingLite {
  id: string;
  nest_id: string;
  conversation_id: string;
  conversation_name?: string | null;
  conversation_kind?: string | null;
  status: string;
  status_changed_at?: string | null;
  guard_detail?: Partial<{
    readers_total: number;
    readers_absent: number;
    members_total: number;
    members_not_readers: number;
    guests: number;
    externals: number;
  }> | null;
}

export interface BudgetLite {
  nest_id: string;
  month: string;
  cap_micros: number;
  spent_micros: number;
}

export interface LedgerEntry {
  entry_id: string;
  at: string;
  nest: { id: string; label: string };
  agent: { node_id: string | null; name: string | null; source: string };
  run: { id: string; outcome: string | null; cost_usd: number; external_ref?: string | null } | null;
  verdict: { code: string | null; reason_code: string | null; kinds: string[] | null; message_count: number | null };
  decision: { verdict: string | null; reason_code: string | null; confidence: number | null; summary?: string | null; evidence?: Array<{ kind: string; ref: string }> | null } | null;
  proposal: { id: string | null; title?: string | null; state: string | null; edited: boolean; counts: Record<string, number> } | null;
  review: { by?: string | null; reason?: string | null; at: string } | null;
  commit: { node_id?: string | null; version: number | null } | null;
  source?: { kind: string; label: string | null; url: string | null } | null;
  redacted: "n1" | null;
}

export const ZERO_TOTALS: LedgerTotals = {
  entries: 0,
  runs: 0,
  failed: 0,
  no_op: 0,
  propose: 0,
  act: 0,
  escalate: 0,
  error: 0,
  none: 0,
  proposals: 0,
  approved: 0,
  edited: 0,
  rejected: 0,
  expired: 0,
  pending: 0,
  withdrawn: 0,
  cost_usd: 0,
  tokens: 0,
};

const TALLY_KEYS = Object.keys(ZERO_TOTALS) as Array<keyof LedgerTotals>;

/** Add rollup rows into one tally (the same arithmetic as the server's). */
export function sumRows(rows: Array<Partial<LedgerTotals>>): LedgerTotals {
  const t = { ...ZERO_TOTALS };
  for (const r of rows) for (const k of TALLY_KEYS) t[k] += Number(r[k] ?? 0) || 0;
  // Cost is summed in dollars; round away float dust at the micro-dollar.
  t.cost_usd = Math.round(t.cost_usd * 1e6) / 1e6;
  return t;
}

// ─── Words ─────────────────────────────────────────────────────────────────

export const PRIVATE_ROW = "DM · private nest · title hidden";
export const PRIVATE_NEST = "Private nest";

/**
 * Why an agent concluded what it did, in plain words. The listener's codes
 * are fixed; anything else is an agent's own vocabulary and is shown as-is,
 * de-snake-cased. "proposed" says what was found, never repeats the verdict.
 */
const REASON_TEXT: Record<string, string> = {
  chatter: "Chatter",
  question_only: "Question only",
  no_agreement: "No agreement yet",
  already_on_record: "Already on record",
  sensitive: "Sensitive, not proposed",
  proposed: "Agreement worth saving",
  too_small: "Too few messages to judge",
  no_target_folder: "No folder to save into yet",
  no_listener: "No listener on this channel",
  no_model: "No model configured",
  nest_unreadable: "Nest not readable",
  target_not_document: "Target isn't a document",
  new_decision: "New decision",
  duplicate: "Duplicate",
  stale_source: "Source out of date",
  escalated: "Escalated to a person",
  model_timeout: "The model call timed out",
};

export function reasonLabel(code: string | null | undefined): string {
  if (!code) return "No reason given";
  if (REASON_TEXT[code]) return REASON_TEXT[code];
  const s = code.replace(/[_-]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : code;
}

/**
 * The trace's "Reason" row: the agent's actual reason — its code in plain
 * words plus its own one-line summary when it gave one — never the verdict
 * again (the prototype's flaw: "Verdict: Proposed / Reason: Proposed").
 */
export function reasonLine(e: Pick<LedgerEntry, "verdict" | "decision">): { text: string; code: string | null; detail: string | null } {
  const code = e.decision?.reason_code ?? e.verdict.reason_code ?? null;
  let text = reasonLabel(code);
  if (code === "proposed" && e.verdict.kinds?.length) {
    text = `Agreement worth saving: ${e.verdict.kinds.map((k) => k.replace(/_/g, " ")).join(", ")}`;
  }
  const detail = e.decision?.summary ?? null;
  return { text, code, detail };
}

export type BadgeTone = "primary" | "neutral" | "info" | "warning" | "rejected" | "success" | "outline";

export const VERDICT_BADGE: Record<string, [BadgeTone, string]> = {
  no_op: ["neutral", "No proposal"],
  propose: ["primary", "Proposed"],
  act: ["info", "Acted"],
  escalate: ["warning", "Escalated"],
  error: ["rejected", "Failed"],
};

export function verdictBadge(code: string | null | undefined): [BadgeTone, string] {
  return (code && VERDICT_BADGE[code]) || ["outline", "No verdict"];
}

export const STATE_BADGE: Record<string, [BadgeTone, string]> = {
  approved: ["success", "Approved"],
  edited: ["success", "Approved with edits"],
  rejected: ["rejected", "Rejected"],
  expired: ["neutral", "Expired"],
  pending: ["warning", "Waiting for review"],
  withdrawn: ["neutral", "Withdrawn"],
};

export const SOURCE_LABEL: Record<string, string> = {
  surfaces: "Surfaces listener",
  metacognition: "Metacognition",
  external: "External · API",
  runner: "Runner",
};

export const SOURCE_TEXT: Record<string, string> = {
  surfaces: "Listens in bound channels. Runs on this server.",
  metacognition: "Runs on this server on a schedule.",
  external: "Runs outside this server. Reports through the API.",
  runner: "Runs on the workflow runner.",
};

export function sourceLabel(s: string | null | undefined): string {
  return (s && SOURCE_LABEL[s]) || "Agent";
}

// ─── Formatting ────────────────────────────────────────────────────────────

export function usd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  return "$" + n.toFixed(n !== 0 && Math.abs(n) < 1 ? 3 : 2);
}

export function pct(a: number, b: number): number | null {
  return b > 0 ? Math.round((a / b) * 100) : null;
}

/** "2 h 14 m", "37 min", "3 d 4 h". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} m`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

const SHORT_DAY: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", timeZone: "UTC" };

/** "Nov 8" from "2026-11-08". UTC, like the rollup buckets. */
export function fmtDay(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", SHORT_DAY) : day;
}

/** "Nov 8, 2:55 PM" in the reader's time zone. */
export function fmtWhen(iso: string, tz?: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(tz ? { timeZone: tz } : {}) });
}

// ─── Range ─────────────────────────────────────────────────────────────────

export const RANGES = [7, 14, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];
const DAY_MS = 86_400_000;

/** The last `days` UTC days, today included: from the start of the first day to now. */
export function rangeFor(days: number, nowMs = Date.now()): { from: string; to: string; days: string[] } {
  const today = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00.000Z`);
  const start = today - (days - 1) * DAY_MS;
  const list: string[] = [];
  for (let d = start; d <= today; d += DAY_MS) list.push(new Date(d).toISOString().slice(0, 10));
  // `to` is exclusive on the server (at < to): one ms past now keeps a row stamped "now".
  return { from: new Date(start).toISOString(), to: new Date(nowMs + 1).toISOString(), days: list };
}

// ─── Overview ──────────────────────────────────────────────────────────────

export interface OverviewTiles {
  /** Judged listener windows in the range. */
  reviewed: number;
  /** % of them that ended with no proposal. */
  noProposalPct: number | null;
  /** Proposal cards per listening channel per day (target ≤ 1). */
  cardsPerChannelDay: number | null;
  /** Items a named person approved (with or without edits). */
  saved: number;
  edited: number;
  rejected: number;
  expired: number;
  spendUsd: number;
  capUsd: number;
  month: string | null;
}

/** The four tiles, from the listener-only totals (`source=surfaces`), the channel count and this month's budgets. */
export function overviewTiles(o: { surfaces: LedgerTotals; activeChannels: number; days: number; budgets: BudgetLite[] }): OverviewTiles {
  const t = o.surfaces;
  const month = o.budgets[0]?.month ?? null;
  return {
    reviewed: t.entries,
    noProposalPct: pct(t.no_op, t.entries),
    cardsPerChannelDay: o.activeChannels > 0 && o.days > 0 ? Math.round((t.propose / o.activeChannels / o.days) * 10) / 10 : null,
    saved: t.approved,
    edited: t.edited,
    rejected: t.rejected,
    expired: t.expired,
    spendUsd: o.budgets.reduce((s, b) => s + Number(b.spent_micros || 0), 0) / 1e6,
    capUsd: o.budgets.reduce((s, b) => s + Number(b.cap_micros || 0), 0) / 1e6,
    month,
  };
}

/** "November" from "2026-11". */
export function monthName(month: string | null): string {
  if (!month) return "this month";
  const d = new Date(`${month}-15T12:00:00Z`);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" }) : month;
}

/** Listener windows per day, no proposal vs proposed, zero-filled across the range. */
export function distillationSeries(dayRows: RollupRow[], days: string[]): { days: string[]; noProposal: number[]; proposed: number[]; failed: number[] } {
  const by = new Map<string, LedgerTotals>();
  for (const r of dayRows) by.set(r.bucket, sumRows([by.get(r.bucket) ?? ZERO_TOTALS, r]));
  return {
    days,
    noProposal: days.map((d) => by.get(d)?.no_op ?? 0),
    proposed: days.map((d) => (by.get(d)?.propose ?? 0) + (by.get(d)?.act ?? 0)),
    failed: days.map((d) => by.get(d)?.error ?? 0),
  };
}

/** Why windows ended with no proposal: rollup rows by=reason (verdict=no_op), summed over buckets, largest first. */
export function reasonBreakdown(reasonRows: RollupRow[]): Array<{ code: string; label: string; count: number }> {
  const m = new Map<string, number>();
  for (const r of reasonRows) m.set(r.key, (m.get(r.key) ?? 0) + Number(r.no_op || 0));
  return [...m.entries()]
    .filter(([, n]) => n > 0)
    .map(([code, count]) => ({ code, label: reasonLabel(code === "(none)" ? null : code), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export interface ChannelRow {
  bindingId: string;
  nestId: string;
  name: string;
  isPrivate: boolean;
  members: number | null;
  status: string;
  reviewed: number;
  noProposalPct: number | null;
  cardsPerDay: number;
  /** Approved ÷ decided (approved + rejected + expired). Under 60% is flagged. */
  precision: number | null;
  lastAt: string | null;
}

/** The channel table: one row per bound channel (not DMs, not removed), with its ledger counts for the range. */
export function channelRows(bindings: BindingLite[], bindingRows: RollupRow[], days: number): ChannelRow[] {
  const per = new Map<string, { t: LedgerTotals; last: string | null }>();
  for (const r of bindingRows) {
    const cur = per.get(r.key) ?? { t: { ...ZERO_TOTALS }, last: null };
    cur.t = sumRows([cur.t, r]);
    if (!cur.last || r.last_at > cur.last) cur.last = r.last_at;
    per.set(r.key, cur);
  }
  return bindings
    .filter((b) => b.status !== "removed" && b.conversation_kind !== "dm")
    .map((b) => {
      const s = per.get(b.id);
      const t = s?.t ?? ZERO_TOTALS;
      const decided = t.approved + t.rejected + t.expired;
      return {
        bindingId: b.id,
        nestId: b.nest_id,
        name: (b.conversation_name ?? "").replace(/^#/, "") || b.conversation_id,
        isPrivate: b.conversation_kind === "private_channel" || b.conversation_kind === "mpim",
        members: b.guard_detail?.members_total ?? null,
        status: b.status,
        reviewed: t.entries,
        noProposalPct: pct(t.no_op, t.entries),
        cardsPerDay: days > 0 ? Math.round((t.propose / days) * 10) / 10 : 0,
        precision: pct(t.approved, decided),
        lastAt: s?.last ?? null,
      };
    })
    .sort((a, b) => (a.status === b.status ? b.reviewed - a.reviewed || a.name.localeCompare(b.name) : a.status === "active" ? -1 : 1));
}

export const LOW_PRECISION = 60;

export interface PausedAlert {
  bindingId: string;
  channel: string;
  nestId: string;
  /** The reason, in counts only (never names). */
  reason: string;
}

/** A channel the guard paused: what changed, in counts. */
export function pausedAlerts(bindings: BindingLite[], nestName: (id: string) => string): PausedAlert[] {
  return bindings
    .filter((b) => b.status === "paused_guard" && b.conversation_kind !== "dm")
    .map((b) => {
      const d = b.guard_detail ?? {};
      const nest = nestName(b.nest_id);
      const parts: string[] = [];
      if (d.readers_total != null) parts.push(`${nest} is readable by ${d.readers_total} ${d.readers_total === 1 ? "person" : "people"}`);
      if (d.members_not_readers && !d.guests && !d.externals) parts.push(`${d.members_not_readers} ${d.members_not_readers === 1 ? "member" : "members"} of the channel can't read it`);
      if (d.guests) parts.push(`${d.guests} ${d.guests === 1 ? "guest" : "guests"} in the channel`);
      if (d.externals) parts.push(`${d.externals} ${d.externals === 1 ? "person" : "people"} from outside the workspace`);
      const reason = parts.length
        ? `${parts.join(", ")}. Anything saved from here could reach people who were never in the conversation, so listening stopped.`
        : "Who can read the nest no longer matches who is in the channel, so listening stopped.";
      return { bindingId: b.id, channel: (b.conversation_name ?? "").replace(/^#/, "") || b.conversation_id, nestId: b.nest_id, reason };
    });
}

export interface AgentRow {
  /** nest id + agent node id: one agent document per nest. */
  id: string;
  nodeId: string;
  nestId: string | null;
  name: string;
  source: string;
  totals: LedgerTotals;
  approvedPct: number | null;
  lastAt: string;
}

/** Agents that wrote ledger rows in the range, latest report first. */
export function agentRows(agentRollups: RollupRow[]): AgentRow[] {
  const m = new Map<string, AgentRow>();
  for (const r of agentRollups) {
    const id = `${r.nest_id ?? ""}\u0000${r.key}`;
    const cur = m.get(id);
    if (!cur) {
      m.set(id, {
        id,
        nodeId: r.key,
        nestId: r.nest_id,
        name: r.label || r.key.split("/").pop() || r.key,
        source: r.source,
        totals: sumRows([r]),
        approvedPct: null,
        lastAt: r.last_at,
      });
    } else {
      cur.totals = sumRows([cur.totals, r]);
      if (r.last_at > cur.lastAt) (cur.lastAt = r.last_at), (cur.source = r.source);
    }
  }
  const out = [...m.values()];
  for (const a of out) a.approvedPct = pct(a.totals.approved, a.totals.approved + a.totals.rejected + a.totals.expired);
  return out.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : a.name.localeCompare(b.name)));
}

/** Rollup table rows, newest bucket first, then by label. */
export function rollupTable(rows: RollupRow[]): RollupRow[] {
  return [...rows].sort((a, b) => (a.bucket === b.bucket ? (a.label ?? a.key).localeCompare(b.label ?? b.key) : a.bucket < b.bucket ? 1 : -1));
}

// ─── Ledger rows ───────────────────────────────────────────────────────────

/**
 * A row's title: the listener's proposal title; for any other agent its own
 * one-line summary (a review's "title" there is only the document id).
 */
export function rowTitle(e: LedgerEntry): string | null {
  if (e.agent.source === "surfaces") return e.proposal?.title ?? null;
  return e.decision?.summary ?? (e.proposal?.title ? e.proposal.title.replace(/^nodes\//, "") : null);
}

/** What the ledger's "What" cell says. A private-nest row says only that it is private (N1). */
export function whatCell(e: LedgerEntry): { title: string; sub: string | null; redacted: boolean } {
  if (e.redacted === "n1") return { title: PRIVATE_ROW, sub: null, redacted: true };
  const msgs = e.verdict.message_count;
  const code = e.verdict.code;
  if (code === "error") return { title: "Run failed", sub: reasonLabel(e.verdict.reason_code), redacted: false };
  const title = rowTitle(e);
  if (code === "no_op" || !title) {
    const sub = msgs != null ? `${msgs} ${msgs === 1 ? "message" : "messages"} reviewed · no text kept` : e.decision?.summary ?? null;
    return { title: reasonLabel(e.decision?.reason_code ?? e.verdict.reason_code), sub, redacted: false };
  }
  const kind = e.verdict.kinds?.[0]?.replace(/_/g, " ");
  const tail = msgs != null ? `${msgs} ${msgs === 1 ? "message" : "messages"}` : null;
  return { title, sub: [kind, tail].filter(Boolean).join(" · ") || null, redacted: false };
}

/** The ledger's "Source" cell. */
export function sourceCell(e: LedgerEntry): { text: string; mono: boolean; channel: boolean; muted: boolean } {
  if (e.redacted === "n1") return { text: "Private", mono: false, channel: false, muted: true };
  if (e.agent.source === "surfaces") {
    const label = e.source?.label ?? null;
    return label ? { text: label.replace(/^#/, ""), mono: false, channel: true, muted: false } : { text: "Channel", mono: false, channel: false, muted: true };
  }
  if (e.agent.source === "external") {
    const ref = e.source?.label ?? e.run?.external_ref ?? null;
    return ref ? { text: ref, mono: true, channel: false, muted: false } : { text: "API", mono: false, channel: false, muted: true };
  }
  return { text: e.agent.source === "metacognition" ? "Scheduled" : "Runner", mono: false, channel: false, muted: true };
}

export type VerdictFilter = "all" | "propose" | "no_op" | "error";

// ─── Empty states (AC-CR-13) ───────────────────────────────────────────────

/** Nothing to chart: no listener activity and no channel bound — show the empty state, never zero-filled charts. */
export function overviewIsEmpty(o: { totals: LedgerTotals; bindings: BindingLite[] }): boolean {
  return o.totals.entries === 0 && !o.bindings.some((b) => b.status !== "removed");
}
