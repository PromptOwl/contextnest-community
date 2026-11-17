#!/usr/bin/env node
// Writes the failed vitest tests to $GITHUB_STEP_SUMMARY, so a reviewer sees what broke on
// the run page. Reads the JSON reporter's file (vitest.config.ts). Usage: node vitest-ci-summary.mjs [file]
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { relative } from "node:path";

const file = process.argv[2] ?? "vitest-results.json";
const out = (s) => (process.env.GITHUB_STEP_SUMMARY ? appendFileSync(process.env.GITHUB_STEP_SUMMARY, s) : process.stdout.write(s));
const clean = (s, lines = 20) =>
  s.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => !/node_modules|node:internal|<anonymous>/.test(l))
    .slice(0, lines).join("\n").replaceAll("```", "'''");

if (!existsSync(file)) {
  out(`### ❌ Unit tests\n\nNo \`${file}\`: vitest stopped before it reported. Read the step log.\n`);
  process.exit(0);
}
const r = JSON.parse(readFileSync(file, "utf8"));
const failures = [];
for (const suite of r.testResults ?? []) {
  const path = relative(process.cwd(), suite.name);
  const failed = (suite.assertionResults ?? []).filter((t) => t.status === "failed");
  for (const t of failed) failures.push({ path, name: t.fullName, msg: (t.failureMessages ?? []).join("\n") });
  // A file that fails to load (syntax, import) has no tests, only a suite message.
  if (!failed.length && suite.status === "failed") failures.push({ path, name: "(file failed to load)", msg: suite.message ?? "" });
}

out(`### ${failures.length ? "❌" : "✅"} Unit tests: ${r.numFailedTests ?? 0} failed, ${r.numPassedTests ?? 0} passed\n\n`);
for (const f of failures.slice(0, 30)) {
  out(`<details><summary><code>${f.path}</code> — ${f.name}</summary>\n\n\`\`\`\n${clean(f.msg)}\n\`\`\`\n</details>\n\n`);
}
if (failures.length > 30) out(`…and ${failures.length - 30} more. See the step log.\n`);
