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
//   (ContextNest#238: promote upstream or confirm Community-only; covers the S2a, S2b and S3 tools below too).
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
//   97->98 context_table_rows (CU-wdqcq06fjy) — twin of POST /nodes/:id/rows; table row ops are Community-only
//   (src/tables), the engine has no table op, so no engine descriptor exists (same as context_table_query).
//   98->99 context_nest_teams — twin of GET/POST/DELETE /nests/:id/teams; Community-only: teams and
//   nests.shared_teams are server state the engine does not model, so there is no engine op to consume.
//   99->100 context_stream (po-1214) — twin of GET /me/stream; the document stream is Community-only
//   (node_versions + node_index across nests, behind EXPERIMENTAL_DOC_STREAM), no engine op exists.
//   100->103 (PO-1185 first-run onboarding, src/mcp/onboarding-tools.ts; Community-only exception, maintainer decision
//   2026-10-24 recorded in docs/prds/api-convergence.md Phase 3). Upstream checked: @promptowl/contextnest-engine 3.5.0
//   (latest) /api has no onboarding or distill op (its markOnboarding is the local CLI registry flag, not an op).
//     context_onboarding — twin of GET /onboarding + /onboarding/connection + /onboarding/distill/:id (one read, `job_id`
//       folds the job progress in; no separate status tool). Per-person welcome state (user_onboarding table) and the
//       distill job row (distill_jobs) are Community server state the engine does not model.
//     context_onboarding_update — twin of POST /onboarding/{dismiss,reopen,nest}. Flips the per-person welcome flag
//       (user_onboarding) and creates the caller's own nest idempotently; the engine has no users or onboarding state.
//     context_distill — twin of POST /onboarding/distill. A server job: SSRF-fenced fetch + model passes + draft writes
//       through Community's createNode governance path (alwaysDraft); fetching URLs and running models are server
//       concerns outside the engine's vault-operation catalog, so there is no op to consume.
//   103->105 context_channels, context_channel_read (PO-1179, src/mcp/channel-tools.ts) — twins of
//   /nests/:id/channels (list/create/archive, timeline/thread). Community-only (a node convention over the
//   comment-thread store) and experimental (EXPERIMENTAL_AGENT_STREAM). Upstream checked:
//   @promptowl/contextnest-engine 3.7.0 (latest) /api has no channel op, so there is no descriptor to import.
//   105->106 context_my_work (PO-1180, src/mcp/my-work-tools.ts) — twin of GET /me/work (reviews,
//   requests, notifications, assigned cards, and the new @mention section); My Work is a Community-only
//   aggregate over this edition's governance tables and the comment_mentions index, so the engine has no
//   operation to import a descriptor from.
//   106->110 public links (PO-1365, src/mcp/public-link-tools.ts; Community-only exception, same maintainer decision
//   2026-10-24, listed in docs/prds/api-convergence.md Phase 3; engine 3.7.0 /api has no public-link op).
//   Upstream checked: @promptowl/contextnest-engine /api has no publish-link op — its `publish` is the version checkpoint,
//   a different thing. A public link is server state (the `publish` and `access_grant` tables and the /p render surface).
//     context_public_link_create — twin of POST /nests/:id/publications. Mints an unguessable /p/<slug> page for one
//       document's approved version under a gate (public, passcode, email, invite); the engine has no hosted pages or gates.
//     context_public_links — twin of GET /nests/:id/publications. Reads the `publish` rows; no engine op lists them.
//     context_public_link_update — twin of PATCH /nests/:id/publications/:id. Sets the per-link `show_invite` flag on a
//       `publish` row (whether the hosted page carries the "Make your own nest" strip); page chrome is not an engine concept.
//     context_public_link_revoke — twin of DELETE /nests/:id/publications/:id. Soft-revokes a `publish` row; separate from
//       the list and create tools so each carries a true read-only / destructive hint (src/mcp/annotations.ts).
//   110->111 context_promote_thread (PO-1181, src/mcp/stream-tools.ts) — twin of
//   POST /nests/:id/threads/:threadId/promote; promoting a comment thread to a decision or task node
//   is Community-only (the comment-thread store is this edition's), so the engine has no operation to
//   import a descriptor from. Artifact cards extend context_channel_read's output, no new tool.
//   111->112 context_agent_webhooks (PO-1181 follow-up, src/mcp/stream-tools.ts) — twin of
//   /nests/:id/agent-webhooks (list/set/delete agent wake-up targets); MCP parity for an admin
//   setting that lives in a Community-only table (agent_webhooks), so no engine op exists.
//   112 (unchanged) agent team stream S4b (PO-1190 / PO-1189): no new tool. `channel`, `since`, `sections`,
//   `summary`, `mention_done` and the "agents" / "mark_read" / "test" actions extend the existing
//   context_comment, context_resolve_comment, context_comments, context_channel_read, context_channels,
//   context_my_work, context_promote_thread and context_agent_webhooks schemas in place. The list-only view of
//   context_channels a read-only key is offered (src/mcp/channel-tools.ts READ_KEY_TOOL_VIEWS) is a subset of
//   that tool's schema, not a new one.
//   112->115 context_message_read, context_message, context_channel_search (PO-1196, src/mcp/message-tools.ts) —
//   twins of the channel message routes (/channels/:name/messages/:id/…, /messages/:id, /channels/search);
//   reactions, edit history, pins, saved items and the LIKE search are Community-only tables over the
//   comment-thread store, behind EXPERIMENTAL_AGENT_STREAM, so the engine has no operation to import a
//   descriptor from. Pins ride on context_channels { action: "pins" } and saved items on context_my_work
//   { sections: ["saved"] } (no new literal for either).
//   115->120 team chat C2 (PO-1197, src/mcp/chat-tools.ts): context_conversations, context_conversation_read,
//   context_channel_members, context_chat_preferences, context_presence — twins of /nests/:id/conversations,
//   the channel membership routes, /me/chat/preferences and /nests/:id/chat/presence; Community-only: conversations are
//   nodes with grants and tags, levels are stream_marks rows, presence is in memory; the engine models none, so no
//   engine op exists. No tool for the SSE stream (an MCP client polls `since`).
const BASELINE = 120;

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
