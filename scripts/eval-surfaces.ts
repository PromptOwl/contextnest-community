/**
 * npm run eval:surfaces -- --dataset <path> [--out report.json] [--labels faithfulness.json] [--snapshot nest.json]
 *
 * Runs the Surfaces judgement eval (PRD §8) against the REAL pinned model
 * (credential from the environment: ANTHROPIC_API_KEY [+ ANTHROPIC_BASE_URL],
 * or the PromptOwl gateway via SURFACES_EVAL_GATEWAY_URL/KEY), writes the JSON
 * report and exits non-zero if any §8.3 target is missed. Run it in Docker,
 * with the sealed test split mounted at run time.
 */
import { readFileSync, writeFileSync } from "fs";
import { parseDataset, runEval, exitCodeFor } from "../src/surfaces/eval/harness.js";
import { realJudge } from "../src/surfaces/eval/real-judge.js";
import { PROMPT_VERSION } from "../src/surfaces/services/judge-service.js";
import type { ModelCredential } from "../src/shared/model-credential.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const datasetPath = arg("dataset");
  if (!datasetPath) throw new Error("--dataset <path> is required");
  const apiKey = process.env.SURFACES_EVAL_GATEWAY_KEY || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("No model credential: set ANTHROPIC_API_KEY or SURFACES_EVAL_GATEWAY_KEY");
  const credential = {
    apiKey,
    baseUrl: process.env.SURFACES_EVAL_GATEWAY_URL || process.env.ANTHROPIC_BASE_URL || null,
    source: process.env.SURFACES_EVAL_GATEWAY_KEY ? "promptowl" : "own",
  } as unknown as ModelCredential;
  const model = process.env.SURFACES_JUDGE_MODEL || "claude-sonnet-5";
  const labelsPath = arg("labels");
  const snapshotPath = arg("snapshot");
  const report = await runEval({
    dataset: parseDataset(readFileSync(datasetPath, "utf8")),
    judge: realJudge({
      credential,
      model,
      folders: (process.env.SURFACES_EVAL_FOLDERS || "/,inbox/").split(","),
      snapshot: snapshotPath ? JSON.parse(readFileSync(snapshotPath, "utf8")) : [],
    }),
    model: { id: model, version: process.env.SURFACES_JUDGE_MODEL_VERSION || "pinned" },
    promptVersion: PROMPT_VERSION,
    itemLabels: labelsPath ? JSON.parse(readFileSync(labelsPath, "utf8")) : undefined,
    windowsPerDay: Number(process.env.SURFACES_EVAL_W) || undefined,
  });
  const out = JSON.stringify(report, null, 2);
  const outPath = arg("out");
  if (outPath) writeFileSync(outPath, out);
  else process.stdout.write(`${out}\n`);
  process.exitCode = exitCodeFor(report);
}

main().catch((err) => {
  console.error(`[eval:surfaces] ${err instanceof Error ? err.message : err}`);
  process.exitCode = 2;
});
