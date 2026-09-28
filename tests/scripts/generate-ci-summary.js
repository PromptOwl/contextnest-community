// @ts-check
/**
 * Parses Playwright JSON results and writes a styled Markdown CI dashboard
 * to $GITHUB_STEP_SUMMARY (visible directly in the GitHub Actions run tab).
 *
 * Ported from TheOwl's tests/scripts/generate-ci-summary.js (CommonJS there;
 * this repo is ESM). Run automatically by contextnest-community-tests.yml
 * after the test step.
 */

import fs from 'fs';
import path from 'path';

const RESULTS_FILE = path.join(process.cwd(), 'tests/test-results/results.json');
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY;

function write(content) {
  if (SUMMARY_FILE) {
    try {
      fs.appendFileSync(SUMMARY_FILE, content);
    } catch (err) {
      console.error(`Failed to write to step summary: ${err.message}`);
      process.exit(1);
    }
  } else {
    process.stdout.write(content);
  }
}

// ── Progress bar (Unicode blocks) ────────────────────────────────────────────
function progressBar(rate, width = 24) {
  const numRate = parseFloat(rate);
  if (isNaN(numRate)) return '`' + '░'.repeat(width) + '`';
  const filled = Math.round((numRate / 100) * width);
  const empty  = width - filled;
  return '`' + '█'.repeat(filled) + '░'.repeat(empty) + '`';
}

function truncateMessage(msg, maxLength = 700) {
  if (!msg) return '';
  const str = String(msg);
  return str.length > maxLength ? str.slice(0, maxLength - 3) + '...' : str;
}

function escapeMarkdown(text) {
  return String(text).replace(/([*_`[\]|\\])/g, '\\$1');
}

// ── Guard: no results file ────────────────────────────────────────────────────
if (!fs.existsSync(RESULTS_FILE)) {
  write([
    '> [!WARNING]',
    '> **No test results file found.** Tests may not have run or results were not saved.',
    '',
  ].join('\n'));
  process.exit(0);
}

let data, stats;
try {
  data  = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  stats = data.stats || {};
} catch (err) {
  write([
    '> [!WARNING]',
    `> **Failed to parse test results:** ${err.message}`,
    '',
  ].join('\n'));
  process.exit(0);
}

// ── Top-level counters ────────────────────────────────────────────────────────
const passed        = stats.expected   || 0;
const failed        = stats.unexpected || 0;
const flaky         = stats.flaky      || 0;
const skipped       = stats.skipped    || 0;
const total         = passed + failed + flaky + skipped;
const durationSec   = ((stats.duration || 0) / 1000).toFixed(1);
const passRate      = total > 0 ? (((passed + flaky) / total) * 100).toFixed(1) : '0.0';

const statusIcon  = failed > 0 ? '🔴' : flaky > 0 ? '🟡' : '🟢';
const statusLabel = failed > 0 ? 'FAILED' : flaky > 0 ? 'FLAKY' : 'PASSED';
const statusLine  = failed > 0
  ? `**${failed}** test${failed !== 1 ? 's' : ''} failed out of **${total}**`
  : flaky > 0
  ? `All tests passed — **${flaky}** were flaky`
  : `All **${total}** tests passed`;

// ── Walk test tree ────────────────────────────────────────────────────────────
const failedTests         = [];
const flakyTests          = [];
const skippedTests        = [];
const slowestPassingTests = [];

function walk(node, parents = []) {
  for (const spec of (node.specs || [])) {
    const fullTitle = [...parents, spec.title].filter(Boolean).join(' › ');

    for (const test of (spec.tests || [])) {
      const results = test.results || [];
      if (results.length === 0) continue;
      const lastResult = results[results.length - 1];
      const totalMs    = results.reduce((sum, r) => sum + (r.duration || 0), 0);

      if (test.status === 'unexpected') {
        const errors = lastResult.errors || [];
        failedTests.push({
          title:    fullTitle,
          project:  test.projectName || '',
          duration: ((lastResult.duration || 0) / 1000).toFixed(1),
          error:    truncateMessage(errors[0]?.message || 'No error message'),
        });
      } else if (test.status === 'flaky') {
        flakyTests.push({
          title:    fullTitle,
          project:  test.projectName || '',
          attempts: results.length,
          duration: ((lastResult.duration || 0) / 1000).toFixed(1),
        });
      } else if (test.status === 'skipped') {
        skippedTests.push({
          title:   fullTitle,
          project: test.projectName || '',
        });
      } else if (test.status === 'expected') {
        slowestPassingTests.push({ title: fullTitle, project: test.projectName || '', totalMs });
      }
    }
  }

  for (const child of (node.suites || [])) {
    walk(child, [...parents, node.title].filter(Boolean));
  }
}

for (const suite of (Array.isArray(data.suites) ? data.suites : [])) {
  walk(suite, []);
}

const topSlowest = slowestPassingTests
  .sort((a, b) => b.totalMs - a.totalMs)
  .slice(0, 5);

// ── Environment info ──────────────────────────────────────────────────────────
const testUrl = process.env.TEST_URL           || 'N/A';
const project = process.env.PLAYWRIGHT_PROJECT || 'test-suite';
const repo    = process.env.GITHUB_REPOSITORY  || '';
const runId   = process.env.GITHUB_RUN_ID      || '';
const sha     = (process.env.GITHUB_SHA || '').slice(0, 7) || 'N/A';
const actor   = process.env.GITHUB_ACTOR       || 'N/A';
const branch  = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || 'N/A';
const runUrl  = repo && runId ? `https://github.com/${repo}/actions/runs/${runId}` : null;

// ── Build Markdown ────────────────────────────────────────────────────────────
let md = '';

// ── Hero header ──────────────────────────────────────────────────────────────
md += `# ${statusIcon} Playwright — ${statusLabel}\n`;
md += `${statusLine} &nbsp;·&nbsp; ⏱ ${durationSec}s &nbsp;·&nbsp; 🌿 \`${branch}\`\n\n`;

// ── Stats cards row ───────────────────────────────────────────────────────────
md += `## 📊 Results\n\n`;
md += `| ✅ Passed | ❌ Failed | ⚠️ Flaky | ⏭️ Skipped | 📋 Total |\n`;
md += `|:---------:|:---------:|:--------:|:----------:|:--------:|\n`;
md += `| **${passed}** | **${failed}** | **${flaky}** | **${skipped}** | **${total}** |\n\n`;

// ── Pass rate bar ─────────────────────────────────────────────────────────────
md += `**Pass Rate &nbsp;** ${progressBar(passRate)} &nbsp; **${passRate}%**\n\n`;

// ── Failed tests ──────────────────────────────────────────────────────────────
if (failedTests.length > 0) {
  md += `---\n\n`;
  md += `## ❌ Failed Tests &nbsp; <sub>${failedTests.length} test${failedTests.length !== 1 ? 's' : ''}</sub>\n\n`;
  for (const t of failedTests) {
    const projectTag = t.project ? `&nbsp;\`${t.project}\`` : '';
    md += `<details>\n`;
    md += `<summary><b>🔴 ${escapeMarkdown(t.title)}</b>${projectTag} &nbsp; <sub>${t.duration}s</sub></summary>\n\n`;
    md += `\`\`\`\n${t.error.replace(/`{3}/g, '\\`\\`\\`')}\n\`\`\`\n\n`;
    md += `</details>\n\n`;
  }
}

// ── Flaky tests ───────────────────────────────────────────────────────────────
if (flakyTests.length > 0) {
  md += `---\n\n`;
  md += `## ⚠️ Flaky Tests &nbsp; <sub>${flakyTests.length} test${flakyTests.length !== 1 ? 's' : ''}</sub>\n\n`;
  md += `> [!NOTE]\n`;
  md += `> These tests **failed on first attempt but passed on retry.** Intermittent failures can mask real issues — investigate soon.\n\n`;
  md += `| Test | Project | Attempts | Duration |\n`;
  md += `|------|---------|:--------:|:--------:|\n`;
  for (const t of flakyTests) {
    md += `| ${escapeMarkdown(t.title)} | \`${t.project || '—'}\` | ${t.attempts} | ${t.duration}s |\n`;
  }
  md += '\n';
}

// ── Skipped tests ─────────────────────────────────────────────────────────────
if (skippedTests.length > 0) {
  md += `---\n\n`;
  md += `<details>\n`;
  md += `<summary><b>⏭️ Skipped Tests</b> &nbsp; <sub>${skippedTests.length} test${skippedTests.length !== 1 ? 's' : ''}</sub></summary>\n\n`;
  md += `| Test | Project |\n`;
  md += `|------|--------|\n`;
  for (const t of skippedTests) {
    md += `| ${escapeMarkdown(t.title)} | \`${t.project || '—'}\` |\n`;
  }
  md += '\n</details>\n\n';
}

// ── Slowest passing tests ─────────────────────────────────────────────────────
if (topSlowest.length > 0) {
  md += `---\n\n`;
  md += `<details>\n`;
  md += `<summary><b>🐢 Slowest Passing Tests</b> &nbsp; <sub>top ${topSlowest.length}</sub></summary>\n\n`;
  md += `| # | Test | Project | Duration |\n`;
  md += `|:-:|------|---------|:--------:|\n`;
  topSlowest.forEach((t, i) => {
    md += `| ${i + 1} | ${escapeMarkdown(t.title)} | \`${t.project || '—'}\` | ${(t.totalMs / 1000).toFixed(1)}s |\n`;
  });
  md += '\n</details>\n\n';
}

// ── Run info footer ───────────────────────────────────────────────────────────
md += `---\n\n`;
md += `<sub>\n\n`;
md += `🌐 **${testUrl}** &nbsp;·&nbsp; `;
md += `🎯 project: \`${project}\` &nbsp;·&nbsp; `;
md += `📦 commit: \`${sha}\` &nbsp;·&nbsp; `;
md += `👤 ${actor}`;
if (runUrl) md += ` &nbsp;·&nbsp; [🔗 View full run](${runUrl})`;
md += `\n\n</sub>\n`;

write(md);

if (SUMMARY_FILE) {
  console.log('✅ CI dashboard written to GitHub Actions step summary');
}
