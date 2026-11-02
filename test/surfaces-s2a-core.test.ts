/**
 * Surfaces S2a — the pure core (no DB, no network): gate, windows, settings
 * ranges, the judge's output schema and proposal bar, filters, dedup, spend
 * thresholds and the eval metrics. Integration through Slack lives in
 * surfaces-s2a-slack.test.ts.
 */
import { describe, it, expect } from "vitest";
import { gate, meaningfulChars, type GateInput } from "../src/surfaces/core/gate.js";
import { shouldClose, windowKey, segment, WINDOW_MAX_MESSAGES } from "../src/surfaces/core/window.js";
import { applySettingsPatch, DEFAULT_SETTINGS, effectiveTtlHours, SettingsError } from "../src/surfaces/core/settings.js";
import { applyBar, validateVerdict, type BarContext, type JudgeWindowView, type VerdictItem } from "../src/surfaces/core/judge-schema.js";
import { hasDateExpression, leakedShingles, longestVerbatimRun, sensitiveHit } from "../src/surfaces/core/filters.js";
import { findDuplicate, jaccard, titleTokens } from "../src/surfaces/core/dedup.js";
import { spendAllowed, thresholdsCrossed } from "../src/surfaces/core/budget.js";
import { computeMetrics, wilson } from "../src/surfaces/core/eval-metrics.js";

const base: GateInput = {
  duplicate: false,
  binding: { status: "active", capture_ok: true, conversation_kind: "private_channel" },
  message: { subtype: null, bot_id: null, author_id: "U1", text: "We agreed to move Acme to annual billing" },
  ourBotUserId: "UBOT",
  author: "member",
  optedOut: false,
  minMeaningfulChars: 6,
};
const g = (over: Partial<GateInput> & { message?: Partial<GateInput["message"]> } = {}) =>
  gate({ ...base, ...over, message: { ...base.message, ...(over.message ?? {}) } });

describe("gate (§4.2)", () => {
  it("AC-GAT-01: bot/system subtypes, bot_id and our own bot are dropped as bot_or_system", () => {
    for (const subtype of ["channel_join", "bot_message", "channel_topic"]) {
      expect(g({ message: { subtype } })).toEqual({ keep: false, reason: "bot_or_system" });
    }
    expect(g({ message: { bot_id: "B123" } })).toEqual({ keep: false, reason: "bot_or_system" });
    expect(g({ message: { author_id: "UBOT" } })).toEqual({ keep: false, reason: "bot_or_system" });
    expect(g({ author: "bot" })).toEqual({ keep: false, reason: "bot_or_system" });
    for (const subtype of ["thread_broadcast", "file_share", "me_message"]) {
      expect(g({ message: { subtype } }).keep).toBe(true);
    }
  });
  it("AC-GAT-02: external or guest authors drop; unknown status fails closed", () => {
    expect(g({ author: "guest_or_external" })).toEqual({ keep: false, reason: "external_or_guest" });
    expect(g({ author: "unknown" })).toEqual({ keep: false, reason: "external_or_guest" });
  });
  it("AC-GAT-03: emoji/mention/URL-only and short messages drop as too_short; 'Agreed' (6) is kept", () => {
    expect(meaningfulChars(":tada: <@U123> https://example.com/x 🎉👍🏽")).toBe(0);
    expect(g({ message: { text: ":tada: <@U123> <https://example.com|link> 🎉" } })).toEqual({ keep: false, reason: "too_short" });
    expect(g({ message: { text: "ok!! 👍" } })).toEqual({ keep: false, reason: "too_short" });
    expect(meaningfulChars("Agreed")).toBe(6);
    expect(g({ message: { text: "Agreed" } }).keep).toBe(true);
    expect(meaningfulChars("Agreed.")).toBe(6);
  });
  it("AC-GAT-04: no binding, a paused binding or capture_ok=false drops", () => {
    expect(g({ binding: null })).toEqual({ keep: false, reason: "not_enabled" });
    expect(g({ binding: { status: "paused_guard", capture_ok: true } })).toEqual({ keep: false, reason: "paused" });
    expect(g({ binding: { status: "active", capture_ok: false } })).toEqual({ keep: false, reason: "paused" });
  });
  it("AC-GAT-05: a seen event id drops as duplicate before anything else", () => {
    expect(g({ duplicate: true, binding: null })).toEqual({ keep: false, reason: "duplicate" });
  });
  it("AC-GAT-06: an opted-out author drops", () => {
    expect(g({ optedOut: true })).toEqual({ keep: false, reason: "opted_out" });
  });
  it("G7: text over 4,000 chars is truncated, not dropped; explicit asks bypass G6", () => {
    const r = g({ message: { text: "a".repeat(5000) } });
    expect(r.keep && r.text.length).toBe(4000);
    expect(r.keep && r.truncated).toBe(true);
    expect(g({ message: { text: "ok" }, explicitAsk: true }).keep).toBe(true);
  });
});

describe("windows (§4.5)", () => {
  const S = { quiet_minutes: 20, window_max_age_hours: 6 };
  const t0 = Date.parse("2026-10-30T09:00:00Z");
  it("windowKey: a reply keys on its thread, a top-level message on the channel burst", () => {
    expect(windowKey({ ts: "2.0", thread_ts: "1.0" })).toBe("1.0");
    expect(windowKey({ ts: "1.0", thread_ts: "1.0" })).toBe("channel");
    expect(windowKey({ ts: "1.0" })).toBe("channel");
  });
  it("AC-WIN-01: quiet after quiet_minutes", () => {
    const w = { opened_at: t0, last_message_at: t0, message_count: 3, char_count: 100 };
    expect(shouldClose(w, t0 + 19 * 60_000, S)).toBeNull();
    expect(shouldClose(w, t0 + 20 * 60_000, S)).toBe("quiet");
  });
  it("AC-WIN-02: 40 messages or 12,000 chars closes with size", () => {
    expect(shouldClose({ opened_at: t0, last_message_at: t0, message_count: WINDOW_MAX_MESSAGES, char_count: 10 }, t0, S)).toBe("size");
    expect(shouldClose({ opened_at: t0, last_message_at: t0, message_count: 39, char_count: 12_000 }, t0, S)).toBe("size");
    expect(shouldClose({ opened_at: t0, last_message_at: t0, message_count: 39, char_count: 11_999 }, t0, S)).toBeNull();
  });
  it("AC-WIN-03: a window open for 6h with continuous activity closes with age", () => {
    const now = t0 + 6 * 3600_000;
    expect(shouldClose({ opened_at: t0, last_message_at: now - 60_000, message_count: 30, char_count: 900 }, now, S)).toBe("age");
  });
  it("AC-EVL-03 (segmenter): a raw stream is cut by the production rules", () => {
    const m = (id: string, at: number, thread_ts: string | null = null) => ({ id, ts: `${at / 1000}`, thread_ts, at, author: "U1", text: "hello there friends" });
    const ws = segment(
      [m("a", t0), m("b", t0 + 5 * 60_000), m("c", t0 + 60 * 60_000), m("r1", t0 + 61 * 60_000, "x"), m("r2", t0 + 62 * 60_000, "x")],
      S,
    );
    expect(ws.map((w) => w.messages.map((x) => x.id))).toEqual([["a", "b"], ["c"], ["r1", "r2"]]);
    expect(ws[0].close_reason).toBe("quiet");
  });
});

describe("settings ranges (§4.1)", () => {
  it("AC-BUF-02: buffer_ttl_hours 48 is refused; 24 is the ceiling", () => {
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { buffer_ttl_hours: 48 })).toThrow(SettingsError);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { buffer_ttl_hours: 24 }).buffer_ttl_hours).toBe(24);
    expect(effectiveTtlHours({ ...DEFAULT_SETTINGS, buffer_ttl_hours: 99 })).toBe(24);
  });
  it("AC-WIN-07: quiet_minutes 3, or window_max_age_hours ≥ buffer_ttl_hours, is refused", () => {
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { quiet_minutes: 3 })).toThrow(SettingsError);
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { buffer_ttl_hours: 6 })).toThrow(SettingsError);
    expect(() => applySettingsPatch({ ...DEFAULT_SETTINGS, buffer_ttl_hours: 12 }, { window_max_age_hours: 12 })).toThrow(SettingsError);
    expect(() => applySettingsPatch(DEFAULT_SETTINGS, { quiet_minutes: "20" })).toThrow(SettingsError);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { quiet_minutes: 5 }).quiet_minutes).toBe(5);
  });
});

// ─── judge schema + bar ──────────────────────────────────────────────────────

const win: JudgeWindowView = {
  forced: false,
  messages: [
    { id: "m1", author_display: "Dana", text: "Should we move the Acme renewal to annual billing?" },
    { id: "m2", author_display: "Sam", text: "Yes, agreed. Let's do annual billing for Acme starting next quarter, Dana owns it by Friday." },
  ],
  mentions: ["Priya"],
};
const nest = { nodeIds: new Set(["nodes/customers/acme", "nodes/decisions/billing"]), folders: ["/", "inbox/", "decisions/", "people/", "customers/"] };
const item = (over: Partial<VerdictItem> = {}): VerdictItem => ({
  kind: "decision",
  op: "new",
  target_folder: "decisions/",
  target_node_id: null,
  title: "Acme renewal moves to annual billing",
  summary: "The team agreed to switch the Acme renewal to annual billing.",
  body: "Decision: the Acme renewal switches to annual billing starting next quarter.",
  owner: null,
  due_date: null,
  evidence_message_ids: ["m2"],
  why: "An agreed decision",
  confidence: 0.86,
  sensitive: false,
  conflict: null,
  ...over,
});
const verdict = (items: VerdictItem[], over: Record<string, unknown> = {}) => ({
  verdict: items.length ? "propose" : "no_op",
  reason_code: items.length ? "proposed" : "chatter",
  items,
  ask_signature: null,
  ...over,
});
const bar = (over: Partial<BarContext> = {}): BarContext => ({
  forced: false,
  threshold: 0.7,
  window: win,
  otherNodeTexts: () => [],
  folderExists: () => true,
  peopleFolders: ["people/"],
  duplicate: null,
  ...over,
});

describe("judge output schema (§4.6)", () => {
  it("accepts a valid verdict and a valid no_op", () => {
    expect(validateVerdict(verdict([item()]), win, nest).ok).toBe(true);
    expect(validateVerdict(verdict([]), win, nest).ok).toBe(true);
  });
  it("AC-JDG-02: title 81 chars, 4 items, foreign evidence id, target outside the nest, edit without target → error", () => {
    const bad = [
      verdict([item({ title: "x".repeat(81) })]),
      verdict([item(), item(), item(), item()]),
      verdict([item({ evidence_message_ids: ["m9"] })]),
      verdict([item({ op: "edit", kind: "correction", target_node_id: "nodes/elsewhere/x" })]),
      verdict([item({ op: "edit", kind: "correction", target_node_id: null })]),
      verdict([item({ kind: "correction", op: "new" })]),
      verdict([], { verdict: "propose" }),
      verdict([item()], { verdict: "no_op" }),
      verdict([item({ target_folder: "agents/" })]),
      { verdict: "maybe", reason_code: "chatter", items: [], ask_signature: null },
      null,
    ];
    for (const b of bad) expect(validateVerdict(b, win, nest).ok).toBe(false);
  });
  it("forced windows need ≥ 1 item unless sensitive", () => {
    const forced = { ...win, forced: true };
    expect(validateVerdict(verdict([]), forced, nest).ok).toBe(false);
    expect(validateVerdict(verdict([], { reason_code: "sensitive" }), forced, nest).ok).toBe(true);
  });
});

describe("proposal bar (§4.6)", () => {
  it("AC-JDG-03: confidence 0.69 is blocked organically, waived when forced", () => {
    expect(applyBar(item({ confidence: 0.69 }), bar())).toEqual({ pass: false, reason: "low_confidence" });
    expect(applyBar(item({ confidence: 0.69 }), bar({ forced: true })).pass).toBe(true);
  });
  it("AC-JDG-04: sensitive flag or lexicon (salary, diagnosis, PIP, credential) blocks, forced or not", () => {
    expect(applyBar(item({ sensitive: true }), bar()).pass).toBe(false);
    for (const t of [
      "Dana's salary goes to 140k",
      "His diagnosis came back",
      "Putting Sam on a PIP",
      "key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      "password: hunter2",
    ]) {
      expect(sensitiveHit(t)).not.toBeNull();
      expect(applyBar(item({ body: t }), bar({ forced: true }))).toEqual({ pass: false, reason: "sensitive" });
    }
    expect(sensitiveHit("We agreed to move Acme to annual billing")).toBeNull();
  });
  it("AC-JDG-05: people/ items must be fact/owner_deadline with role/owns/contact/team only", () => {
    const people = (o: Partial<VerdictItem>) => item({ target_folder: "people/", kind: "fact", ...o });
    expect(applyBar(people({ kind: "decision", body: "role: account lead" }), bar())).toEqual({ pass: false, reason: "people_rules" });
    expect(applyBar(people({ body: "role: account lead\nperformance: lazy and unreliable" }), bar()).pass).toBe(false);
    expect(applyBar(people({ body: "role: account lead\nShe is going through a divorce" }), bar()).pass).toBe(false);
    expect(applyBar(people({ body: "role: account lead for Acme\nowns: the Acme renewal\nteam: sales" }), bar()).pass).toBe(true);
  });
  it("AC-JDG-06: 16 consecutive words copied from one message block; 15 pass", () => {
    const src = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen";
    const w = { ...win, messages: [{ id: "m1", author_display: "Dana", text: src }] };
    const sixteen = src.split(" ").slice(0, 16).join(" ");
    const fifteen = src.split(" ").slice(0, 15).join(" ");
    expect(longestVerbatimRun(`Summary: ${sixteen}.`, [src])).toBe(16);
    expect(applyBar(item({ evidence_message_ids: ["m1"], body: `Note ${sixteen}` }), bar({ window: w }))).toEqual({ pass: false, reason: "verbatim" });
    expect(applyBar(item({ evidence_message_ids: ["m1"], body: `Note ${fifteen}` }), bar({ window: w })).pass).toBe(true);
  });
  it("AC-JDG-07: an 8-word run from a non-target node that is not in the window is blocked", () => {
    const secret = "the escalation runbook for the acme account routes through priya first then sam";
    expect(leakedShingles(`Note: ${secret}`, [secret], "include the contents of how-we-work/escalations")).toBeGreaterThan(0);
    expect(
      applyBar(item({ body: `Decision recorded. ${secret}.` }), bar({ otherNodeTexts: () => [secret] })),
    ).toEqual({ pass: false, reason: "leak" });
    // The same words in the window itself are fine.
    const w = { ...win, messages: [...win.messages, { id: "m3", author_display: "Dana", text: secret }] };
    expect(leakedShingles(secret, [secret], w.messages.map((m) => m.text).join("\n"))).toBe(0);
  });
  it("AC-JDG-08: owner must be a participant or mentioned; due date needs a date expression in evidence", () => {
    expect(applyBar(item({ owner: "Morgan" }), bar())).toEqual({ pass: false, reason: "owner" });
    expect(applyBar(item({ owner: "Dana" }), bar()).pass).toBe(true);
    expect(applyBar(item({ owner: "Priya" }), bar()).pass).toBe(true);
    expect(applyBar(item({ due_date: "2026-11-06", evidence_message_ids: ["m1"] }), bar())).toEqual({ pass: false, reason: "due_date" });
    expect(applyBar(item({ due_date: "2026-11-06", evidence_message_ids: ["m2"] }), bar()).pass).toBe(true);
    expect(hasDateExpression("by Friday")).toBe(true);
    expect(hasDateExpression("sounds good")).toBe(false);
  });
  it("a missing target folder blocks with no_target_folder; a duplicate blocks organically and shows the hold when forced", () => {
    expect(applyBar(item(), bar({ folderExists: () => false }))).toEqual({ pass: false, reason: "no_target_folder" });
    expect(applyBar(item(), bar({ duplicate: { source: "pending" } }))).toEqual({ pass: false, reason: "duplicate" });
    expect(applyBar(item(), bar({ duplicate: { source: "published" } }))).toEqual({ pass: false, reason: "already_on_record" });
    expect(applyBar(item(), bar({ forced: true, duplicate: { source: "hold", held_on: "2026-10-27" } }))).toEqual({
      pass: true,
      previously_held_on: "2026-10-27",
    });
  });
});

describe("dedup (§4.9)", () => {
  it("AC-DED-01: 'Acme renewal moves…' vs 'Acme renewal moving…' is a duplicate (Jaccard ≥ 0.6, same kind)", () => {
    const a = titleTokens("Acme renewal moves to annual billing");
    const b = titleTokens("Acme renewal moving to annual billing!");
    expect(jaccard(a, b)).toBeGreaterThanOrEqual(0.6);
    const hit = findDuplicate({ kind: "decision", op: "new", title: "Acme renewal moving to annual billing", target_node_id: null }, [
      { source: "pending", kind: "decision", title_tokens: a },
    ]);
    expect(hit?.source).toBe("pending");
    expect(findDuplicate({ kind: "fact", op: "new", title: "Acme renewal moving to annual billing", target_node_id: null }, [{ source: "pending", kind: "decision", title_tokens: a }])).toBeNull();
  });
  it("AC-DED-02: a live hold suppresses; an expired one is not a candidate", () => {
    const tokens = titleTokens("Acme renewal moves to annual billing");
    expect(findDuplicate({ kind: "decision", op: "new", title: "Acme renewal moves to annual billing", target_node_id: null }, [{ source: "hold", kind: "decision", title_tokens: tokens, held_on: "2026-10-27" }])?.held_on).toBe("2026-10-27");
    expect(findDuplicate({ kind: "decision", op: "new", title: "Acme renewal moves to annual billing", target_node_id: null }, [])).toBeNull();
  });
  it("AC-DED-03: a pending edit on node X suppresses another edit on X", () => {
    const hit = findDuplicate({ kind: "correction", op: "edit", title: "Totally different words", target_node_id: "nodes/customers/acme" }, [
      { source: "pending", kind: "correction", op: "edit", target_node_id: "nodes/customers/acme", title_tokens: ["x"] },
    ]);
    expect(hit).not.toBeNull();
  });
  it("AC-DED-04: a published title in the target folder matches as already on record", () => {
    const hit = findDuplicate({ kind: "decision", op: "new", title: "Acme moves to annual billing", target_node_id: null }, [
      { source: "published", kind: null, title_tokens: titleTokens("Acme moves to annual billing") },
    ]);
    expect(hit?.source).toBe("published");
  });
});

describe("spend (§4.8)", () => {
  it("AC-JDG-10: organic stops at 90% of the cap, forced at 100%", () => {
    const cap = 50_000_000;
    expect(spendAllowed({ cap, spent: 44_000_000, reserved: 0, estimate: 1_000_000, forced: false })).toBe(true);
    expect(spendAllowed({ cap, spent: 44_000_000, reserved: 500_000, estimate: 1_000_000, forced: false })).toBe(false);
    expect(spendAllowed({ cap, spent: 48_000_000, reserved: 0, estimate: 1_000_000, forced: true })).toBe(true);
    expect(spendAllowed({ cap, spent: 49_500_000, reserved: 0, estimate: 1_000_000, forced: true })).toBe(false);
  });
  it("AC-JDG-11: each threshold is reported once when crossed", () => {
    expect(thresholdsCrossed(80, 91, 100)).toEqual([90]);
    expect(thresholdsCrossed(91, 101, 100)).toEqual([100]);
    expect(thresholdsCrossed(80, 120, 100)).toEqual([90, 100]);
    expect(thresholdsCrossed(91, 95, 100)).toEqual([]);
  });
});

describe("eval metrics (§8.3)", () => {
  it("AC-EVL-02 (math): Wilson interval and the realistic-prevalence precision", () => {
    const w = wilson(80, 100);
    expect(w.lo).toBeCloseTo(0.711, 2);
    expect(w.hi).toBeCloseTo(0.866, 2);
    const rows = [
      ...Array.from({ length: 70 }, (_, i) => ({ id: `k${i}`, label: "keep" as const, clear_keep: true, predicted: "propose" as const, proposed_items: 1, supported_items: 1 })),
      ...Array.from({ length: 30 }, (_, i) => ({ id: `kn${i}`, label: "keep" as const, clear_keep: true, predicted: "no_op" as const })),
      ...Array.from({ length: 5 }, (_, i) => ({ id: `fp${i}`, label: "not_keep" as const, predicted: "propose" as const, proposed_items: 1 })),
      ...Array.from({ length: 895 }, (_, i) => ({ id: `n${i}`, label: "not_keep" as const, predicted: "no_op" as const })),
    ];
    const m = computeMetrics(rows, { windowsPerDay: 8 });
    expect(m.recall).toBeCloseTo(0.7, 5);
    expect(m.fpr).toBeCloseTo(5 / 900, 5);
    const pi = 0.04;
    expect(m.precision_at.pi_04).toBeCloseTo((pi * 0.7) / (pi * 0.7 + (1 - pi) * (5 / 900)), 5);
    expect(m.cards_per_channel_per_day).toBeCloseTo(8 * (pi * 0.7 + (1 - pi) * (5 / 900)), 5);
    expect(m.precision_raw_wilson.lo).toBeGreaterThan(0);
    expect(m.faithfulness).toBe(1);
  });
});
