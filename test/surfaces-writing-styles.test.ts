/**
 * The writing-style set (real-model run: npm run eval:surfaces -- --dataset
 * test/fixtures/surfaces-eval/writing-styles.json). Here, with no model: the
 * deterministic rules must not lose a message over how it is written, and must
 * stop the ones that may never be saved.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildWindows, parseDataset } from "../src/surfaces/eval/harness.js";
import { meaningfulChars } from "../src/surfaces/core/gate.js";
import { categoryHit, sensitiveHit } from "../src/surfaces/core/filters.js";
import { assess } from "../src/surfaces/core/judge-repair.js";

const set = parseDataset(readFileSync("test/fixtures/surfaces-eval/writing-styles.json", "utf8"));

/** The bundled starter's never-propose words, as a seeded listener has them. */
const STARTER_TERMS = [...readFileSync("seeds/generic-team/seed.md", "utf8").matchAll(/category: ([\w-]+), terms: \[([^\]]+)\]/g)].flatMap((m) => [m[1], ...m[2].split(",").map((t) => t.trim())]);
const stopped = (text: string) => !!sensitiveHit(text) || categoryHit(text, STARTER_TERMS);

describe("writing styles", () => {
  it("has the whole range: at least 30 messages, kept and not kept, asked for and not", () => {
    expect(set.streams.length).toBeGreaterThanOrEqual(30);
    const labels = set.streams.map((s) => s.labels[0]);
    for (const l of ["keep", "not_keep"]) expect(labels.filter((x) => x.label === l).length).toBeGreaterThan(5);
    expect(labels.some((l) => l.forced)).toBe(true);
    expect(labels.some((l) => !l.forced)).toBe(true);
  });
  for (const s of set.streams) {
    const label = s.labels[0];
    const text = s.messages.map((m) => m.text).join("\n");
    it(`${s.id}: one conversation; ${label.must_never ? "stopped as sensitive" : "never stopped by a word filter"}`, () => {
      expect(buildWindows(s)).toHaveLength(1);
      expect(STARTER_TERMS.length).toBeGreaterThan(20);
      expect(stopped(text)).toBe(!!label.must_never);
      // A conversation worth keeping is never "too short to judge".
      if (label.label === "keep" && !label.forced) expect(s.messages.reduce((n, m) => n + meaningfulChars(m.text), 0)).toBeGreaterThanOrEqual(40);
    });
  }
  it("an answer that copies any of these messages whole is sent back to be reworded, or passes: never lost, never hard-blocked", () => {
    for (const s of set.streams.filter((x) => x.labels[0].label === "keep")) {
      const messages = s.messages.map((m, i) => ({ id: `m${i + 1}`, author_display: m.author, text: m.text }));
      const v = { verdict: "propose", reason_code: "proposed", ask_signature: null, items: [{ kind: "decision", op: "new", target_folder: "decisions/", target_node_id: null, title: "A note", summary: "A note.", body: s.messages.map((m) => m.text).join("\n"), owner: "The platform team", due_date: null, evidence_message_ids: ["m1"], why: "Said here.", confidence: 0.9, sensitive: false, conflict: null }] };
      const a = assess(v as never, { forced: true, threshold: 0.7, window: { forced: true, messages, mentions: [] }, otherNodeTexts: () => [], folderExists: () => true, neverPropose: STARTER_TERMS });
      expect(a.hard, s.id).toBe(false);
      expect(a.problems, s.id).toHaveLength(1);
    }
  });
});
