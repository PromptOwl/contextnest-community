/**
 * Surfaces S2a — the judgement eval harness (PRD §8; AC-EVL-02/03). The
 * runner the real-model job uses (`npm run eval:surfaces`) is exercised here
 * with a scripted judge: no model, no network.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { buildWindows, exitCodeFor, parseDataset, runEval } from "../src/surfaces/eval/harness.js";
import { segment } from "../src/surfaces/core/window.js";
import { DEFAULT_SETTINGS } from "../src/surfaces/core/settings.js";

const raw = readFileSync(join(process.cwd(), "test", "fixtures", "surfaces-eval", "dev-sample.json"), "utf8");

describe("eval harness", () => {
  it("AC-EVL-03: windows are cut from raw streams by the production segmenter, never pre-cut", () => {
    const ds = parseDataset(raw);
    for (const s of ds.streams) {
      const ours = buildWindows(s).map((w: any) => w.messages.map((m: any) => m.id));
      const prod = segment(
        s.messages.map((m: any) => ({ ...m, at: Math.round(Number(m.ts) * 1000) })),
        DEFAULT_SETTINGS,
      ).map((w) => w.messages.map((m) => m.id));
      expect(ours).toEqual(prod);
    }
    expect(buildWindows(ds.streams[0]).length).toBe(6);
    expect(() => parseDataset(JSON.stringify({ format: "surfaces-eval/v1", windows: [{ messages: [] }] }))).toThrow(/raw streams/i);
  });

  it("AC-EVL-02: the report carries every §8 metric, Wilson bounds, model/prompt ids and cost per 1,000; exit 0 only when every target is met", async () => {
    const ds = parseDataset(raw);
    // A perfect judge: proposes exactly on keep windows; every item supported.
    const perfect = async (w: any) => ({
      predicted: w.label.label === "keep" ? ("propose" as const) : ("no_op" as const),
      items: w.label.label === "keep" ? 1 : 0,
      conflict_proposed: w.label.conflict === "true",
      cost_micros: 1200,
    });
    const report = await runEval({
      dataset: ds,
      judge: perfect,
      model: { id: "claude-sonnet-5", version: "2026-09" },
      promptVersion: "surfaces-judge-v1",
      itemLabels: "all_supported",
    });
    for (const k of [
      "recall",
      "fpr",
      "precision_at",
      "precision_raw",
      "precision_raw_wilson",
      "explicit_recall",
      "faithfulness",
      "must_never_proposals",
      "conflict_precision",
      "cards_per_channel_per_day",
      "cost_per_1000_windows",
    ]) {
      expect(report.metrics, k).toHaveProperty(k);
    }
    expect(report.metrics.precision_at).toHaveProperty("pi_02");
    expect(report.metrics.precision_at).toHaveProperty("pi_04");
    expect(report.metrics.precision_at).toHaveProperty("pi_06");
    expect(report.metrics.precision_raw_wilson).toHaveProperty("lo");
    expect(report.model).toEqual({ id: "claude-sonnet-5", version: "2026-09" });
    expect(report.prompt_version).toBe("surfaces-judge-v1");
    expect(report.metrics.cost_per_1000_windows).toBeCloseTo(1200 * 1000, 0);
    expect(report.windows).toBe(26);
    expect(report.passed).toBe(true);
    expect(exitCodeFor(report)).toBe(0);

    // A firehose: proposes on everything — must-never and precision fail.
    const firehose = await runEval({
      dataset: ds,
      judge: async () => ({ predicted: "propose" as const, items: 1, cost_micros: 1200 }),
      model: { id: "m", version: "v" },
      promptVersion: "p",
      itemLabels: "all_supported",
    });
    expect(firehose.metrics.must_never_proposals).toBeGreaterThan(0);
    expect(firehose.passed).toBe(false);
    expect(firehose.failed).toContain("must_never");
    expect(exitCodeFor(firehose)).not.toBe(0);

    // Silence can't pass: the recall floor fails it.
    const silent = await runEval({ dataset: ds, judge: async () => ({ predicted: "no_op" as const, items: 0, cost_micros: 0 }), model: { id: "m", version: "v" }, promptVersion: "p", itemLabels: "all_supported" });
    expect(silent.failed).toContain("recall");
    expect(exitCodeFor(silent)).not.toBe(0);

    // Without faithfulness labels the gate can't pass.
    const unlabelled = await runEval({ dataset: ds, judge: perfect, model: { id: "m", version: "v" }, promptVersion: "p" });
    expect(unlabelled.metrics.faithfulness).toBeNull();
    expect(exitCodeFor(unlabelled)).not.toBe(0);
  });

  it("AC-EVL-02: `npm run eval:surfaces` is wired to the runner", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.scripts["eval:surfaces"]).toMatch(/scripts\/eval-surfaces\.ts/);
    const script = readFileSync(join(process.cwd(), "scripts", "eval-surfaces.ts"), "utf8");
    expect(script).toMatch(/runEval/);
    expect(script).toMatch(/exitCodeFor/);
  });
});
