#!/usr/bin/env node
/**
 * Divergence guard for MCP tool schemas.
 *
 * Part of the API convergence effort (docs/prds/api-convergence.md, Phase 3) and the
 * "Engine & CLI Sync Discipline" rule in CLAUDE.md.
 *
 * MCP tool schemas are meant to import from `@promptowl/contextnest-engine/api` once that
 * module ships — not be hand-written inline in this repo. This guard ratchets the number of
 * inline `inputSchema: { ... }` object literals under src/mcp/ so no NEW ones can be added
 * while Phase 2 migration is pending, and nudges the baseline down as they are removed.
 *
 * Pure Node, no dependencies.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const MCP_DIR = join(REPO_ROOT, 'src', 'mcp');

// Count of inline `inputSchema: {` literals in src/mcp/. Lower as schemas move to
// `@promptowl/contextnest-engine/api`. Raising is forbidden except for tools with no engine
// descriptor to import — each raise below names the tools and why. Tools mirror REST 1:1;
// server-level /mcp variants derive from per-nest definitions (no new literal).
//
// Engine module not importable yet (adopt descriptors once it is):
//   40->41 context_table_query; 41->42 context_delete; 47->49 nest_create/context_create bootstrap.
//   Repo governance tables, not engine ops (promote upstream, then adopt + lower):
//   42->43 context_move; 43->46 deletion-request trio; 46->47 context_my_drafts;
//   49->52 comment tools (CU-wdqcq01uqn); 45->48 access-request trio (CU-wdqcq041jn, ContextNest#167);
//   48->51 task-relation trio (edges table); 51->55 custom-field defs (ContextNest#178);
//   52->56 server-level write tools (CU-wdqcq02cxu), then 56->45 once they derived from per-nest.
//   55->58 boards + bulk update; 58->59 context_task_log; 59->61 headless + systems (CU-wdqcq0538g);
//   61->63 instructions history/update (CU-wdqcq05mty; instructions_revisions table);
//   63->68 metacognition list/suggest/configure/run/remove (CU-wdqcq05rqq; metacognition_agents table).
//   Repo upload routes, not engine ops (asset store + /nodes/pdf + /nodes/office):
//   68->69 context_upload (community-nest-upload-files-over-mcp-without-handling-binaries).
//   69->70 context_set_visibility (twin of PATCH /nests/:id/visibility; Community-only: nest visibility is
//   server state the engine does not model, so there is no engine op to consume).
//   70->83 Surfaces S1 (src/mcp/surfaces-tools.ts): context_surfaces_status, bindings_list, binding_preview/create/update/
//   delete/recheck/resume, links_list, link_revoke/unblock, link_reviews_list, link_review_decide — REST twins of /surfaces/*;
//   Community-only tables (surface_bindings, surface_identity_links) the engine does not model, so no engine op exists
//   (ContextNest#238: promote upstream or confirm Community-only; covers the S2a and S2b tools below too).
//   83->87 Surfaces S2a (src/mcp/surfaces-tools.ts): context_surfaces_slack_install_create, settings_get, settings_update,
//   windows_list — REST twins of POST /surfaces/slack/installs, GET/PATCH /surfaces/settings, GET /surfaces/windows; Community-only
//   tables (surface_installs, surface_settings, surface_windows) the engine does not model, so no engine op exists.
//   87->93 Surfaces S2b (src/mcp/surfaces-tools.ts): context_surfaces_proposals_list, my_pending, commits_list, budget_get,
//   budget_update, disconnect — REST twins of GET /surfaces/proposals, /pending, /commits, GET/PATCH /surfaces/nests/:id/budget,
//   DELETE /surfaces/installs/:id; Community-only tables (surface_proposals, surface_commits, surface_nest_budgets) the engine
//   does not model, so no engine op exists.
//   93->94 Surfaces S2b round 4: context_surfaces_binding_invite — twin of POST /surfaces/bindings/:id/invite (/nest invite);
//   Community-only binding state the engine does not model.
//   94->97 Surfaces S3 (src/mcp/surfaces-tools.ts): context_surfaces_seed_apply, seed_list, seed_status — twins of
//   POST /surfaces/seeds/apply, GET /surfaces/seeds, GET /surfaces/seeds/status; Community-only seed state
//   (surface_seed_applications, surface_seed_items) the engine does not model, so no engine op exists.
const BASELINE = 97;

const INLINE_SCHEMA = /inputSchema:\s*\{/g;

/** @param {string} dir @returns {string[]} */
function collectTsFiles(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

let total = 0;
/** @type {Array<{file: string, count: number}>} */
const perFile = [];
for (const file of collectTsFiles(MCP_DIR)) {
  const matches = readFileSync(file, 'utf8').match(INLINE_SCHEMA);
  const count = matches ? matches.length : 0;
  if (count > 0) {
    perFile.push({ file: relative(REPO_ROOT, file), count });
    total += count;
  }
}

perFile.sort((a, b) => b.count - a.count);
for (const { file, count } of perFile) {
  console.log(`  ${count.toString().padStart(3)}  ${file}`);
}
console.log(`\ninline \`inputSchema: {\` literals in src/mcp/: ${total} (baseline ${BASELINE})`);

if (total > BASELINE) {
  console.error(
    `\n✗ ${total - BASELINE} new inline MCP schema(s) added.\n` +
    `  MCP tool schemas must import from @promptowl/contextnest-engine/api, not be\n` +
    `  hand-written inline. See CLAUDE.md "Engine & CLI Sync Discipline" and\n` +
    `  docs/prds/api-convergence.md. If this is intentional convergence work, do it\n` +
    `  upstream in PromptOwl/ContextNest first.`,
  );
  process.exit(1);
}

if (total < BASELINE) {
  console.error(
    `\n✗ Inline schema count dropped to ${total}. Nice — now lower BASELINE to ${total}\n` +
    `  in scripts/check-mcp-schemas.mjs so the ratchet holds the new floor.`,
  );
  process.exit(1);
}

console.log('✓ No new inline MCP schemas.');
