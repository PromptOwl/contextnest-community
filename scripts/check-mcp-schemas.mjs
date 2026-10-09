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
//
// Raised 49 -> 52 for the comment write tools (`context_comment`,
// `context_resolve_comment`) and the server-level `context_comments` mirror
// (CU-wdqcq01uqn). Same reason as move, the deletion trio and my_drafts: comments are NOT an
// engine operation and are not meant to be — they are deliberately outside the engine's
// version/hash chain (see the header of src/governance/comment-service.ts), which makes them
// a community-edition governance concern like context_approve and context_stewards. The
// upstream catalog was checked and carries no comment/annotation operation to import. They
// mirror the REST annotation routes 1:1.
//
// Raised 52 -> 56 for server-level write tools (`context_update`, `context_delete`,
// `context_move`, `context_submit_review`) on the /mcp endpoint (CU-wdqcq02cxu). These are
// nest-parameterized mirrors of the existing per-nest tools — same schemas with an added
// `nest` argument. This is community-edition MCP wiring, not new engine operations. The
// per-nest tools already exist inline (same baseline exception), and these server-level
// variants enable cross-nest workflows without multiple MCP connections. Authorization is
// handled per-call by the same handleToolCall gates the per-nest endpoint uses.
//
// Lowered 56 -> 45: the server-level /mcp tools now derive from the per-nest
// definitions (plus a `nest` arg) instead of keeping hand-written copies.
//
// Raised 45 -> 48 for the access-request trio (`context_request_access`,
// `context_access_requests`, `context_resolve_access_request`, CU-wdqcq041jn). Same reason
// as the deletion trio: access requests are not an engine operation — they live in this
// repo's governance tables and grant through its share/collaborator paths, so there is no
// upstream descriptor to import. They mirror the REST /access-requests routes 1:1; the
// server-level `context_request_access` derives from the per-nest definition (no new
// literal). Promotion is tracked upstream in PromptOwl/ContextNest#167 — adopt the
// descriptors and lower this by 3 if it lands there.
//
// Raised 48 -> 51 for `context_boards`, `context_board_items` and `context_bulk_update`
// (board List view + bulk edit). Same reason as the access-request trio: saved boards are
// this repo's own table and a bulk edit is a loop over the existing governed update — none
// is an engine operation, so there is no upstream descriptor to import. They mirror REST
// GET /boards, GET /boards/:id/items and POST /nodes/bulk-update 1:1; the server-level
// variants derive from these definitions (no new literal).
const BASELINE = 51;

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
