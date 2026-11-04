/**
 * H1 — Hootie's turn context (pure core, src/hootie/turn.ts).
 *
 * One question is one turn. The turn holds what the model may name — the
 * node ids (and boards) the server itself handed this caller this turn — and
 * the effort budget. Everything the model asks a tool to touch is checked
 * against it; nothing a document says can widen it (must-never 4).
 */
import { describe, it, expect } from "vitest";
import {
  TurnContext,
  EFFORT_PRESETS,
  admitNodeId,
  admitNodeRef,
  admitBoard,
  spend,
  stoppedLine,
} from "../src/hootie/turn.js";

function turn(now = () => 0) {
  return new TurnContext({
    nestId: "n1",
    turnId: "t1",
    caller: { userId: "u-priya", email: "priya@acme.com" },
    userText: "what's blocked?",
    budget: EFFORT_PRESETS.standard,
    now,
  });
}

describe("TurnContext — the caller", () => {
  it("is the signed-in person: apiKeyId is always null", () => {
    const t = turn();
    expect(t.caller).toEqual({ userId: "u-priya", email: "priya@acme.com", apiKeyId: null });
    expect(t.userText).toBe("what's blocked?");
    expect(t.turnId).toBe("t1");
  });

  it("defaults to the Standard preset: 2 extra searches, 6 reads, 20 s", () => {
    const t = new TurnContext({ nestId: "n", turnId: "t", caller: { userId: "u", email: "e" }, userText: "q" });
    expect(t.budget).toEqual({ searches: 2, reads: 6, wallClockMs: 20_000 });
    expect(EFFORT_PRESETS).toEqual({
      quick: { searches: 1, reads: 3, wallClockMs: 10_000 },
      standard: { searches: 2, reads: 6, wallClockMs: 20_000 },
      thorough: { searches: 2, reads: 12, wallClockMs: 40_000 },
    });
  });
});

describe("allowNodes — must-never 4 (MN4-a)", () => {
  it("admits only ids the server returned this turn", () => {
    const t = turn();
    t.allowNode("nodes/hub", "Project November Hub");
    expect(admitNodeId(t, "nodes/hub")).toBe("nodes/hub");
    expect(admitNodeId(t, "nodes/secret")).toBeNull();
    expect(admitNodeId(t, "")).toBeNull();
    expect(admitNodeId(t, 42)).toBeNull();
    expect(admitNodeId(t, { id: "nodes/hub" })).toBeNull();
  });

  it("resolves a title only to exactly one allowed node", () => {
    const t = turn();
    t.allowNode("nodes/hub", "Project November Hub");
    t.allowNode("nodes/a/notes", "Notes");
    t.allowNode("nodes/b/notes", "Notes");
    expect(admitNodeRef(t, { title: "project november hub" })).toBe("nodes/hub");
    expect(admitNodeRef(t, { title: "Project November Hub " })).toBe("nodes/hub");
    // Two allowed nodes share the title: ambiguous, refused rather than guessed.
    expect(admitNodeRef(t, { title: "Notes" })).toBeNull();
    // A title nothing returned this turn — even if it exists — is refused.
    expect(admitNodeRef(t, { title: "Zephyr Acquisition Ledger" })).toBeNull();
    expect(admitNodeRef(t, { id: "nodes/a/notes" })).toBe("nodes/a/notes");
    expect(admitNodeRef(t, { id: "nodes/zzz", title: "Project November Hub" })).toBeNull();
    expect(admitNodeRef(t, {})).toBeNull();
    expect(admitNodeRef(t, null)).toBeNull();
  });

  it("knows the title of each allowed id (status lines name only allowed nodes)", () => {
    const t = turn();
    t.allowNode("nodes/hub", "Project November Hub");
    expect(t.allowNodes.get("nodes/hub")).toBe("Project November Hub");
    expect(t.allowNodes.has("nodes/other")).toBe(false);
  });

  it("admits a board by id, or by a name that matches exactly one listed board", () => {
    const t = turn();
    t.allowBoard("b1", "November board");
    t.allowBoard("b2", "Twin");
    t.allowBoard("b3", "Twin");
    expect(admitBoard(t, "b1")).toBe("b1");
    expect(admitBoard(t, "november board")).toBe("b1");
    expect(admitBoard(t, "Twin")).toBeNull();
    expect(admitBoard(t, "b9")).toBeNull();
    expect(admitBoard(t, 7)).toBeNull();
  });
});

describe("budget (§3.12)", () => {
  it("Standard: the 7th read is refused and the turn is exhausted", () => {
    const t = turn();
    for (let i = 0; i < 6; i++) expect(spend(t, "read")).toBe(true);
    expect(t.exhausted).toBe(false);
    expect(spend(t, "read")).toBe(false);
    expect(t.exhausted).toBe(true);
    expect(t.answerOnly).toBe(true);
    expect(t.used).toEqual({ search: 0, read: 6 });
  });

  it("Standard: the 3rd extra search is refused; reads are a separate budget", () => {
    const t = turn();
    expect(spend(t, "search")).toBe(true);
    expect(spend(t, "search")).toBe(true);
    expect(t.exhausted).toBe(false);
    expect(t.answerOnly).toBe(false);
    expect(spend(t, "search")).toBe(false);
    expect(t.exhausted).toBe(true);
    expect(t.used).toEqual({ search: 2, read: 0 });
  });

  it("the wall-clock cap refuses the next call", () => {
    let now = 1_000;
    const t = turn(() => now);
    expect(spend(t, "read")).toBe(true);
    now += 20_001;
    expect(spend(t, "read")).toBe(false);
    expect(t.exhausted).toBe(true);
    expect(t.used.read).toBe(1);
  });

  it("a rejected call puts the turn in answer-only mode", () => {
    const t = turn();
    expect(t.answerOnly).toBe(false);
    t.rejectedCall = true;
    expect(t.answerOnly).toBe(true);
  });

  it("the stopped-looking line is fixed copy with the counts spent", () => {
    const t = turn();
    expect(stoppedLine(t)).toBe("I stopped looking after 0 searches and 0 reads.");
    spend(t, "search");
    spend(t, "read");
    expect(stoppedLine(t)).toBe("I stopped looking after 1 search and 1 read.");
    spend(t, "search");
    spend(t, "read");
    expect(stoppedLine(t)).toBe("I stopped looking after 2 searches and 2 reads.");
  });
});
