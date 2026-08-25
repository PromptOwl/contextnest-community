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

// Current count of inline `inputSchema: {` literals across src/mcp/.
// Lower this as schemas migrate to `@promptowl/contextnest-engine/api`.
//
// Raising it is normally forbidden — new inline schemas are the divergence this guard
// prevents. Raised 40 -> 41 in 1.10.0 for `context_table_query` as a deliberate exception:
// `@promptowl/contextnest-engine/api` has not shipped yet (engine 1.2.1 exports `index`
// only), so inline remains the only way to declare a tool schema here. The new tool follows
// the same pattern as the other 40 rather than introducing drift. Migrate all 41 to the
// engine module once it lands, then ratchet this back down.
//
// Raised 41 -> 42 for `context_delete`, same deliberate exception: engine 1.2.1 DOES define
// context_delete in its operation catalog (dist/api/ — core namespace, alias
// delete_document), but the engine's package.json `exports` map lists only ".", so
// `@promptowl/contextnest-engine/api` is unimportable. The inline schema mirrors that
// descriptor. Unblocking it is a one-line exports-map addition upstream in
// PromptOwl/ContextNest — do that, then migrate all 42 at once.
//
// Raised 42 -> 43 for `context_move`. Different reason: move is NOT in the engine catalog
// at all (the id rewrite spans governance tables the engine doesn't own), so there is no
// upstream descriptor to import. The tool mirrors the existing REST POST /nodes/:id/move.
// If move is ever promoted to a core engine operation, adopt its descriptor here.
//
// Raised 43 -> 46 for the deletion-request trio (`context_request_deletion`,
// `context_deletion_queue`, `context_resolve_deletion`). Same reason as move: deletion
// REQUESTS are not in the engine catalog at all — they live in this repo's governance
// tables (a flag is not a document operation), so there is no upstream descriptor to
// import. They mirror the REST surface 1:1. Mirror the names upstream if the operation is
// ever promoted, then adopt its descriptor here.
// Raised 46 -> 47 for `context_my_drafts`. Same reason as move and the deletion trio: it is
// not an engine operation at all. "Drafts I never submitted" is derived from this repo's
// governance tables (node_versions cross-checked against review_requests) — the engine has
// no notion of a review request, so there is no upstream descriptor to import. It mirrors
// the REST GET /me/drafts 1:1, nest-scoped. Promote it upstream only if review workflow ever
// moves into the engine catalog.
//
// Raised 47 -> 49 in 1.12.0 for the server-level `nest_create` / `context_create` bootstrap
// writes — same exception as `context_table_query`: no importable engine module yet, and the
// tools follow the existing pattern rather than introducing drift.
const BASELINE = 49;

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
