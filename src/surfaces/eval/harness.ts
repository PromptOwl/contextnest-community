/**
 * The judgement eval harness (PRD §8): dataset format, window building with
 * the PRODUCTION segmenter (core/window.ts, default settings — never pre-cut
 * windows), metric computation and the gate verdict. The judge is injected:
 * the real-model job (`npm run eval:surfaces`) passes eval/real-judge.ts;
 * unit tests pass a script.
 *
 * Dataset (`surfaces-eval/v1`, JSON): { format, split, streams: [ { id,
 * channel, messages: [{id, ts, thread_ts?, author, text}], labels: [{
 * first_message_id, label: keep|not_keep, clear_keep?, must_never?, forced?,
 * conflict?: "true"|"paraphrase" }] } ] }. Labels name a window by its first
 * message; labellers segment with the same code. Synthetic or our own
 * workspace only — never customer messages (§8.1).
 */
import { segment, type SegmentedWindow, type StreamMessage } from "../core/window.js";
import { DEFAULT_SETTINGS } from "../core/settings.js";
import { computeMetrics, missedTargets, TARGETS, type EvalWindowResult } from "../core/eval-metrics.js";

export interface DatasetLabel {
  first_message_id: string;
  label: "keep" | "not_keep";
  clear_keep?: boolean;
  must_never?: boolean;
  forced?: boolean;
  conflict?: "true" | "paraphrase" | null;
}
export interface DatasetStream {
  id: string;
  channel?: string;
  messages: Array<{ id: string; ts: string; thread_ts?: string | null; author: string; text: string }>;
  labels: DatasetLabel[];
}
export interface Dataset {
  format: "surfaces-eval/v1";
  split?: string;
  streams: DatasetStream[];
}

export function parseDataset(text: string): Dataset {
  const d = JSON.parse(text) as Record<string, unknown>;
  if (d.format !== "surfaces-eval/v1") throw new Error("dataset format must be surfaces-eval/v1");
  if ("windows" in d || !Array.isArray(d.streams)) throw new Error("the dataset must hold raw streams (no pre-cut windows): windows are cut by the production segmenter");
  for (const s of d.streams as DatasetStream[]) {
    if (!s || typeof s.id !== "string" || !Array.isArray(s.messages) || !Array.isArray(s.labels)) throw new Error("every stream needs id, messages and labels");
    for (const m of s.messages) if (typeof m.id !== "string" || typeof m.ts !== "string" || typeof m.text !== "string") throw new Error(`stream ${s.id}: malformed message`);
  }
  return d as unknown as Dataset;
}

export function buildWindows(stream: DatasetStream): SegmentedWindow[] {
  const msgs: StreamMessage[] = stream.messages.map((m) => ({ ...m, thread_ts: m.thread_ts ?? null, at: Math.round(Number(m.ts) * 1000) }));
  return segment(msgs, DEFAULT_SETTINGS);
}

export interface EvalWindow {
  id: string;
  stream: string;
  messages: StreamMessage[];
  label: DatasetLabel;
  forced: boolean;
}

export interface JudgeOutcome {
  predicted: "propose" | "no_op";
  items: number;
  conflict_proposed?: boolean;
  cost_micros?: number;
  /** Proposed items, for the labellers' faithfulness pass. */
  proposals?: unknown[];
}

export async function runEval(opts: {
  dataset: Dataset;
  judge: (w: EvalWindow) => Promise<JudgeOutcome>;
  model: { id: string; version: string };
  promptVersion: string;
  /** Faithfulness labels: supported items per window id, or "all_supported" (unit tests only). Absent → faithfulness null (gate fails). */
  itemLabels?: "all_supported" | Record<string, number>;
  windowsPerDay?: number;
}) {
  const rows: EvalWindowResult[] = [];
  const forLabelling: Array<{ window: string; proposals: unknown[] }> = [];
  for (const s of opts.dataset.streams) {
    const labels = new Map(s.labels.map((l) => [l.first_message_id, l]));
    for (const w of buildWindows(s)) {
      const first = w.messages[0].id;
      const label = labels.get(first);
      if (!label) throw new Error(`stream ${s.id}: no label for the window starting at ${first}`);
      const ew: EvalWindow = { id: `${s.id}:${first}`, stream: s.id, messages: w.messages, label, forced: !!label.forced };
      const out = await opts.judge(ew);
      const supported =
        opts.itemLabels === "all_supported" ? out.items : opts.itemLabels && ew.id in opts.itemLabels ? opts.itemLabels[ew.id] : undefined;
      rows.push({
        id: ew.id,
        label: label.label,
        clear_keep: !!label.clear_keep,
        must_never: !!label.must_never,
        forced: !!label.forced,
        conflict: label.conflict ?? null,
        predicted: out.predicted,
        proposed_items: out.items,
        supported_items: out.predicted === "propose" ? supported : 0,
        conflict_proposed: !!out.conflict_proposed,
        cost_micros: out.cost_micros ?? 0,
      });
      if (out.predicted === "propose" && out.proposals) forLabelling.push({ window: ew.id, proposals: out.proposals });
    }
  }
  const metrics = computeMetrics(rows, { windowsPerDay: opts.windowsPerDay });
  const failed = missedTargets(metrics);
  return {
    format: "surfaces-eval-report/v1",
    generated_at: new Date().toISOString(),
    model: opts.model,
    prompt_version: opts.promptVersion,
    windows: rows.length,
    metrics,
    targets: TARGETS,
    failed,
    passed: failed.length === 0,
    items_for_labelling: forLabelling,
  };
}

export type EvalReport = Awaited<ReturnType<typeof runEval>>;

export function exitCodeFor(report: Pick<EvalReport, "passed">): number {
  return report.passed ? 0 : 1;
}
