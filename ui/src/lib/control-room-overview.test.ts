/**
 * po-1186 CR2: the Control room's pure logic — the words, the empty-state
 * decisions and the arithmetic the tabs draw with. Named for the ACs they
 * pin; the reconciliation against the real routes is test/control-room-cr2.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  ZERO_TOTALS,
  agentRows,
  channelRows,
  distillationSeries,
  formatDuration,
  overviewIsEmpty,
  overviewTiles,
  pausedAlerts,
  rangeFor,
  reasonBreakdown,
  reasonLine,
  sourceCell,
  sumRows,
  usd,
  whatCell,
  type LedgerEntry,
  type RollupRow,
} from "./control-room-overview";
import { administersAnyNest } from "./administers-nest";

const row = (over: Partial<RollupRow>): RollupRow => ({ ...ZERO_TOTALS, bucket: "2026-11-08", key: "k", label: null, nest_id: "n1", last_at: "2026-11-08T10:00:00.000Z", source: "surfaces", ...over });
const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
  entry_id: "win_1",
  at: "2026-11-08T14:55:00.000Z",
  nest: { id: "n1", label: "Revenue" },
  agent: { node_id: "nodes/agents/listener-revenue", name: "Revenue listener", source: "surfaces" },
  run: { id: "run_1", outcome: "succeeded", cost_usd: 0.004 },
  verdict: { code: "propose", reason_code: "proposed", kinds: ["decision"], message_count: 3 },
  decision: null,
  proposal: { id: "p1", title: "Pipeline review moves to Thursdays", state: "edited", edited: true, counts: {} },
  review: { by: "marcus@larkspur.example", reason: null, at: "2026-11-08T15:32:00.000Z" },
  commit: { node_id: "nodes/decisions/pipeline-review", version: 3 },
  source: { kind: "slack", label: "#revops", url: null },
  redacted: null,
  ...over,
});

describe("trace Reason row (prototype flaw fixed)", () => {
  it("AC-CR-05 (CR2 trace): the Reason row shows the agent's reason, never the verdict repeated", () => {
    const listener = reasonLine(entry({}));
    expect(listener.text).toBe("Agreement worth saving: decision");
    expect(listener.text).not.toBe("Proposed");
    expect(listener.code).toBe("proposed");
    const external = reasonLine(
      entry({
        agent: { node_id: "nodes/agents/cc", name: "Claude Code", source: "external" },
        verdict: { code: "propose", reason_code: "new_decision", kinds: null, message_count: null },
        decision: { verdict: "propose", reason_code: "new_decision", confidence: 0.8, summary: "Moved feature flags to flags/ service", evidence: [] },
      }),
    );
    expect(external).toEqual({ text: "New decision", code: "new_decision", detail: "Moved feature flags to flags/ service" });
    expect(reasonLine(entry({ verdict: { code: "no_op", reason_code: "already_on_record", kinds: [], message_count: 22 }, proposal: null })).text).toBe("Already on record");
    // An agent's own vocabulary is shown readably.
    expect(reasonLine(entry({ verdict: { code: "no_op", reason_code: "ci_already_green", kinds: null, message_count: null } })).text).toBe("Ci already green");
  });
});

describe("AC-CR-07c: private-nest rows", () => {
  it("AC-CR-07c: a redacted row says 'DM · private nest · title hidden', source 'Private', and never the title", () => {
    const e = entry({ redacted: "n1", proposal: { id: "p", state: "approved", edited: false, counts: {} }, source: null, nest: { id: "p", label: "DM · private nest · title hidden" } });
    expect(whatCell(e)).toEqual({ title: "DM · private nest · title hidden", sub: null, redacted: true });
    expect(sourceCell(e)).toMatchObject({ text: "Private", muted: true });
  });
  it("shows the title and kind for a normal proposal, the reason for a no-op, and the ref for an external run", () => {
    expect(whatCell(entry({}))).toEqual({ title: "Pipeline review moves to Thursdays", sub: "decision · 3 messages", redacted: false });
    expect(whatCell(entry({ verdict: { code: "no_op", reason_code: "chatter", kinds: [], message_count: 10 }, proposal: null }))).toEqual({
      title: "Chatter",
      sub: "10 messages reviewed · no text kept",
      redacted: false,
    });
    const ext = entry({ agent: { node_id: "a", name: "Claude Code", source: "external" }, source: { kind: "agent", label: "cc-session-2089e", url: null } });
    expect(sourceCell(ext)).toMatchObject({ text: "cc-session-2089e", mono: true });
    expect(sourceCell(entry({}))).toMatchObject({ text: "revops", channel: true });
  });
});

describe("AC-CR-13: empty states", () => {
  it("AC-CR-13: no listener rows and no binding → the empty state (never zero-filled charts); any binding or row → the dashboard", () => {
    expect(overviewIsEmpty({ totals: ZERO_TOTALS, bindings: [] })).toBe(true);
    expect(overviewIsEmpty({ totals: ZERO_TOTALS, bindings: [{ id: "b", nest_id: "n", conversation_id: "C", status: "removed" }] })).toBe(true);
    expect(overviewIsEmpty({ totals: ZERO_TOTALS, bindings: [{ id: "b", nest_id: "n", conversation_id: "C", status: "active" }] })).toBe(false);
    expect(overviewIsEmpty({ totals: { ...ZERO_TOTALS, entries: 3 }, bindings: [] })).toBe(false);
  });
});

describe("AC-CR-03: tile arithmetic", () => {
  it("AC-CR-03: tiles read the listener totals, the listening channels, the range and the month's budgets", () => {
    const t = overviewTiles({
      surfaces: { ...ZERO_TOTALS, entries: 336, no_op: 286, propose: 50, approved: 41, edited: 10, rejected: 6, expired: 3 },
      activeChannels: 4,
      days: 14,
      budgets: [
        { nest_id: "a", month: "2026-11", cap_micros: 20_000_000, spent_micros: 6_000_000 },
        { nest_id: "b", month: "2026-11", cap_micros: 20_000_000, spent_micros: 5_420_000 },
      ],
    });
    expect(t).toMatchObject({ reviewed: 336, noProposalPct: 85, cardsPerChannelDay: 0.9, saved: 41, edited: 10, rejected: 6, expired: 3, capUsd: 40, month: "2026-11" });
    expect(t.spendUsd).toBeCloseTo(11.42, 6);
    expect(overviewTiles({ surfaces: ZERO_TOTALS, activeChannels: 0, days: 14, budgets: [] })).toMatchObject({ noProposalPct: null, cardsPerChannelDay: null });
  });

  it("zero-fills the distillation days and sums reasons over buckets, largest first", () => {
    const range = rangeFor(3, Date.parse("2026-11-08T15:00:00Z"));
    expect(range.days).toEqual(["2026-11-06", "2026-11-07", "2026-11-08"]);
    const s = distillationSeries([row({ bucket: "2026-11-06", no_op: 4, propose: 1 }), row({ bucket: "2026-11-08", no_op: 2, act: 1 })], range.days);
    expect(s).toMatchObject({ noProposal: [4, 0, 2], proposed: [1, 0, 1] });
    const r = reasonBreakdown([row({ key: "chatter", no_op: 5 }), row({ key: "question_only", no_op: 2, bucket: "2026-11-02" }), row({ key: "chatter", no_op: 3, bucket: "2026-11-02" })]);
    expect(r).toEqual([
      { code: "chatter", label: "Chatter", count: 8 },
      { code: "question_only", label: "Question only", count: 2 },
    ]);
  });

  it("channel precision = approved ÷ decided, DMs and removed bindings left out", () => {
    const rows = channelRows(
      [
        { id: "b1", nest_id: "n", conversation_id: "C1", conversation_name: "acme-renewal", conversation_kind: "private_channel", status: "active", guard_detail: { members_total: 7 } },
        { id: "b2", nest_id: "n", conversation_id: "D1", conversation_kind: "dm", status: "active" },
        { id: "b3", nest_id: "n", conversation_id: "C3", status: "removed" },
      ],
      [row({ key: "b1", entries: 66, no_op: 55, propose: 11, approved: 7, rejected: 2, expired: 0, last_at: "2026-11-08T13:50:00.000Z" }), row({ key: "b1", bucket: "2026-11-02", entries: 4, no_op: 4, last_at: "2026-11-03T10:00:00.000Z" })],
      14,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "acme-renewal", isPrivate: true, members: 7, reviewed: 70, noProposalPct: 84, cardsPerDay: 0.8, precision: 78, lastAt: "2026-11-08T13:50:00.000Z" });
  });

  it("AC-CR-03b: a paused channel's reason is counts only", () => {
    const [a] = pausedAlerts([{ id: "b", nest_id: "n", conversation_id: "C", conversation_name: "onboarding", status: "paused_guard", guard_detail: { readers_total: 312, externals: 1 } }], () => "Company");
    expect(a.reason).toBe(
      "Company is readable by 312 people, 1 person from outside the workspace. Anything saved from here could reach people who were never in the conversation, so listening stopped.",
    );
  });
});

describe("agents and formatting", () => {
  it("agents are listed latest report first, with the latest row's kind", () => {
    const a = agentRows([
      row({ key: "nodes/agents/digest", label: "Renewal risk digest", source: "metacognition", last_at: "2026-11-08T07:00:00.000Z", entries: 10, approved: 3 }),
      row({ key: "nodes/agents/cc", label: "Claude Code", source: "external", last_at: "2026-11-08T15:00:00.000Z", entries: 4, approved: 1, rejected: 1 }),
      row({ key: "nodes/agents/cc", label: "Claude Code", source: "external", bucket: "2026-11-02", last_at: "2026-11-03T15:00:00.000Z", entries: 2 }),
    ]);
    expect(a.map((x) => x.name)).toEqual(["Claude Code", "Renewal risk digest"]);
    expect(a[0]).toMatchObject({ source: "external", approvedPct: 50 });
    expect(a[0].totals.entries).toBe(6);
  });

  it("formats durations, money and sums like the server", () => {
    expect(formatDuration(2 * 3_600_000 + 14 * 60_000)).toBe("2 h 14 m");
    expect(formatDuration(37 * 60_000)).toBe("37 min");
    expect(formatDuration(76 * 3_600_000)).toBe("3 d 4 h");
    expect(usd(0.004)).toBe("$0.004");
    expect(usd(11.42)).toBe("$11.42");
    expect(sumRows([{ cost_usd: 0.1 }, { cost_usd: 0.2 }]).cost_usd).toBe(0.3);
  });

  it("decision 3: a person who owns or administers a nest gets the Control room", () => {
    expect(administersAnyNest([{ permission: "read" }, { permission: "admin" }])).toBe(true);
    expect(administersAnyNest([{ is_owner: true, permission: "read" }])).toBe(true);
    expect(administersAnyNest([{ permission: "write" }])).toBe(false);
    expect(administersAnyNest(undefined)).toBe(false);
  });
});
