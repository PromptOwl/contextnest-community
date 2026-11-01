/**
 * Proposals from a judged window (PRD §4.7), the S2a part.
 *
 *  - The proposal row and one item row per passing item (state `creating`)
 *    are written BEFORE any draft exists, so the draft is hidden from its
 *    first moment (security round 2, M1c). Each item then goes through the
 *    metacognition propose helpers (proposeNewDraft / proposeEditDraft →
 *    submitForReview) with the listener as proposer, and becomes `pending`;
 *    a failed one becomes `dropped`.
 *  - The draft carries provenance — surface, conversation, time range and a
 *    permalink — never copied thread text.
 *  - Items of one window are ONE surface_proposals row (one card).
 *  - Every proposal is created `held`; S2b's routing-service posts it
 *    (explicit asks at once, organic ones through budgets and the queue;
 *    S2b's card-service does the posting). What a card may say when
 *    the room holds non-readers is decided here, at judge time, while the
 *    window text still exists (H1).
 *  - Withdraw is a SYSTEM action (M2): the review is cancelled by
 *    compare-and-set as `system:surfaces`, the draft discarded as its
 *    recorded submitter, and only then is the item `withdrawn` (title
 *    purged, no 7-day hold). Until both succeed the item stays `pending` —
 *    i.e. hidden — and the purge sweep retries it; a failure alerts admins
 *    with counts only.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../../db/client.js";
import { proposeEditDraft, proposeNewDraft, type ToolContext } from "../../metacognition/tools.js";
import { withdrawReviewAsSystem } from "../../governance/review-service.js";
import { discardDraft, derivedNodeId } from "../../nodes/service.js";
import { engineCache } from "../../nodes/engine.js";
import { DocumentNotFoundError } from "@promptowl/contextnest-engine";
import { titleTokens } from "../core/dedup.js";
import { ROOT_FOLDER, isPlainDocumentType, type VerdictItem } from "../core/judge-schema.js";
import { fixedCardText } from "../core/card-text.js";
import { getConnector } from "../registry.js";
import type { BindingRow } from "./binding-service.js";
import { installRef, type InstallRow } from "./install-store.js";
import { recordNotice } from "./notices.js";
import type { WindowRow } from "./window-service.js";

export const PROPOSAL_TTL_MS = 7 * 24 * 3600_000;
export const DRAFT_SUMMARY = "A draft is waiting for a reviewer in the nest.";

export interface CreatedProposal {
  proposalId: string;
  items: Array<{ id: string; kind: string; title: string; nodeId: string; reviewId: string; heldOn: string | null; folder: string }>;
  dropped: string[];
}

/** Tests only. */
export const proposalTestHooks: {
  failWithdraw?: boolean;
  beforeDrafts?: () => Promise<void> | void;
  afterDraft?: (nodeId: string) => Promise<void> | void;
} = {};

const iso = (ms: number) => new Date(ms).toISOString();

function rangeUtc(tss: string[]): string {
  const ms = tss.map((t) => Number(t.split(".")[0]) * 1000).filter((n) => Number.isFinite(n) && n > 0);
  if (!ms.length) return "";
  const f = (n: number) => new Date(n).toISOString().slice(0, 16).replace("T", " ");
  const lo = Math.min(...ms);
  const hi = Math.max(...ms);
  return lo === hi ? `${f(lo)} UTC` : `${f(lo)}–${f(hi).slice(11)} UTC`;
}

export async function createProposal(input: {
  window: WindowRow;
  binding: BindingRow;
  install: InstallRow;
  ctx: ToolContext;
  items: Array<{ item: VerdictItem; heldOn: string | null }>;
  rows: Map<string, { id: string; ts: string }>;
  folders: string[];
  nowMs: number;
}): Promise<CreatedProposal> {
  const { binding, install, ctx, nowMs } = input;
  const connector = getConnector(install.surface);
  const out: CreatedProposal = { proposalId: uuid(), items: [], dropped: [] };
  const forced = !!input.window.forced;
  const nest = (await getDb().get("SELECT name FROM nests WHERE id = ?", [binding.nest_id])) as { name?: string } | undefined;
  // When the room holds non-readers the card says only this (round 3, N1).
  const safe = fixedCardText(
    input.items.map(({ item }) => ({ kind: item.kind, op: item.op })),
    nest?.name ?? "the nest",
  );

  // 1. Reserve each new item's EXACT id — one no node and no other proposal
  //    holds, so a hide row can never cover an existing document (round 3,
  //    N3) — then write the rows that hide the drafts, before any draft
  //    exists (M1c).
  const reservedIds = new Map<VerdictItem, string>();
  for (const { item } of input.items) {
    if (item.op === "edit") continue;
    const folder = item.target_folder === ROOT_FOLDER ? "" : item.target_folder.replace(/\/$/, "");
    const id = await reserveNodeId(binding.nest_id, folder, item.title, new Set(reservedIds.values()));
    if (id) reservedIds.set(item, id);
  }
  const pre: Array<{ rowId: string; item: VerdictItem; heldOn: string | null; folder: string; expectedId: string | null }> = [];
  await getDb().transaction(async (tx) => {
    await tx.run(
      `INSERT INTO surface_proposals (id, window_id, binding_id, nest_id, card_kind, state, forced, persona_email, card_title, card_summary, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?, ?, ?)`,
      [
        out.proposalId,
        input.window.id,
        binding.id,
        binding.nest_id,
        input.items.length > 1 ? "merged" : "single",
        forced ? 1 : 0,
        ctx.agent.persona.email,
        safe.title,
        safe.summary,
        iso(nowMs + PROPOSAL_TTL_MS),
        iso(nowMs),
        iso(nowMs),
      ],
    );
    for (const { item, heldOn } of input.items) {
      const rowId = uuid();
      const folder = item.target_folder === ROOT_FOLDER ? "" : item.target_folder.replace(/\/$/, "");
      const expectedId = item.op === "edit" ? item.target_node_id : (reservedIds.get(item) ?? null);
      await tx.run(
        `INSERT INTO surface_proposal_items (id, proposal_id, nest_id, node_id, item_kind, op, target_folder, target_node_id, title, title_tokens,
           confidence, state, previously_held_on, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?)`,
        [rowId, out.proposalId, binding.nest_id, expectedId, item.kind, item.op, item.target_folder, item.target_node_id, item.title, JSON.stringify(titleTokens(item.title)), item.confidence, heldOn, iso(nowMs), iso(nowMs)],
      );
      pre.push({ rowId, item, heldOn, folder, expectedId });
    }
  });
  await proposalTestHooks.beforeDrafts?.();

  // 2. The drafts, each through submitForReview with the listener as proposer.
  for (const p of pre) {
    const { item } = p;
    const evidence = item.evidence_message_ids.map((id) => input.rows.get(id)).filter((r): r is { id: string; ts: string } => !!r);
    let link: string | null = null;
    if (connector?.permalink && evidence[0]) link = await connector.permalink(installRef(install), binding.conversation_id, evidence[0].id).catch(() => null);
    const where = binding.conversation_name ? `#${binding.conversation_name.replace(/^#/, "")}` : "a conversation";
    const provenance = [`Source: ${install.surface === "slack" ? "Slack" : install.surface} · ${where} · ${rangeUtc(evidence.map((e) => e.ts))}`, link]
      .filter(Boolean)
      .join(" · ");
    const content = `${item.body.trim()}\n\n---\n_${provenance}_\n`;
    const note = `${item.why || "Proposed from a conversation"} (from ${install.surface})`;
    // Server-side, whatever the verdict schema said: an edit may only
    // target a plain document (security N6).
    if (item.op === "edit" && item.target_node_id && !(await editTargetIsDocument(binding.nest_id, item.target_node_id))) {
      out.dropped.push("target_not_document");
      await getDb().run("UPDATE surface_proposal_items SET state = 'dropped', title = NULL, updated_at = ? WHERE id = ? AND state = 'creating'", [iso(Date.now()), p.rowId]);
      continue;
    }
    let r;
    try {
      r =
        item.op === "edit" && item.target_node_id
          ? await proposeEditDraft(ctx, { id: item.target_node_id, content, note }, { bypassHold: forced })
          : p.expectedId
            ? await proposeNewDraft(ctx, { folder: p.folder, title: item.title, content, note }, { id: p.expectedId, bypassHold: forced })
            : { ok: false as const, message: "no free id" };
    } catch {
      r = { ok: false as const, message: "error" };
    }
    if (!r.ok) {
      out.dropped.push("propose_failed");
      await getDb().run("UPDATE surface_proposal_items SET state = 'dropped', title = NULL, updated_at = ? WHERE id = ? AND state = 'creating'", [iso(Date.now()), p.rowId]);
      continue;
    }
    await proposalTestHooks.afterDraft?.(r.nodeId);
    // node_id first (still hidden as `creating`), then pending.
    await getDb().run("UPDATE surface_proposal_items SET node_id = ?, review_id = ?, version = ?, state = 'pending', updated_at = ? WHERE id = ? AND state = 'creating'", [
      r.nodeId,
      r.reviewId,
      r.version,
      iso(Date.now()),
      p.rowId,
    ]);
    out.items.push({ id: p.rowId, kind: item.kind, title: item.title, nodeId: r.nodeId, reviewId: r.reviewId, heldOn: p.heldOn, folder: item.target_folder });
  }
  if (!out.items.length) await getDb().run("UPDATE surface_proposals SET state = 'withdrawn', updated_at = ? WHERE id = ?", [iso(Date.now()), out.proposalId]);
  return out;
}

/**
 * The exact id a new proposal will be created at: the slug createNode
 * derives (`derivedNodeId`), or `document-N` for a title with no ASCII —
 * then `-2`, `-3`, … until neither an existing document nor another live
 * proposal holds it. null when none is free (the item is dropped).
 */
export async function reserveNodeId(nestId: string, folder: string, title: string, taken: Set<string> = new Set()): Promise<string | null> {
  const prefix = folder ? `nodes/${folder}/` : "nodes/";
  const derived = derivedNodeId(title, folder);
  const { storage } = await engineCache.get(nestId);
  const exists = async (id: string) => {
    try {
      await storage.readDocument(id);
      return true;
    } catch (err) {
      if (err instanceof DocumentNotFoundError) return false;
      return true; // unreadable: treat as taken (never hide something we can't see)
    }
  };
  const held = async (id: string) =>
    taken.has(id) ||
    !!(await getDb().get("SELECT 1 AS x FROM surface_proposal_items WHERE nest_id = ? AND node_id = ? AND state IN ('creating', 'pending')", [nestId, id])) ||
    !!(await getDb().get("SELECT 1 AS x FROM node_versions WHERE nest_id = ? AND node_id = ? LIMIT 1", [nestId, id]));
  const candidates = derived ? [derived, ...Array.from({ length: 49 }, (_, i) => `${derived}-${i + 2}`)] : Array.from({ length: 200 }, (_, i) => `${prefix}document-${i + 1}`);
  for (const id of candidates) {
    if (!(await held(id)) && !(await exists(id))) return id;
  }
  return null;
}

/** Does this id name an existing plain document (no frontmatter type, or "document")? Unreadable → no. */
export async function editTargetIsDocument(nestId: string, nodeId: string): Promise<boolean> {
  try {
    const { storage } = await engineCache.get(nestId);
    const doc = await storage.readDocument(nodeId);
    return isPlainDocumentType(doc.frontmatter?.type as string | undefined);
  } catch {
    return false;
  }
}

/**
 * Withdraw every pending item of a proposal (system path, M2). Returns how
 * many were fully withdrawn; anything that couldn't be stays pending (and
 * hidden) for the sweep to retry.
 */
export async function withdrawProposalItems(proposalId: string, reason = "binding_stopped"): Promise<number> {
  const db = getDb();
  const p = (await db.get("SELECT id, nest_id, binding_id FROM surface_proposals WHERE id = ?", [proposalId])) as
    | { id: string; nest_id: string; binding_id: string }
    | undefined;
  if (!p) return 0;
  const items = (await db.all("SELECT * FROM surface_proposal_items WHERE proposal_id = ? AND state IN ('creating', 'pending')", [proposalId])) as Array<{
    id: string;
    state: string;
    review_id: string | null;
    node_id: string | null;
    op: string;
  }>;
  let done = 0;
  let failed = 0;
  for (const it of items) {
    if (it.state === "creating") continue; // its creator finishes or drops it; the sweep comes back
    try {
      if (proposalTestHooks.failWithdraw) throw new Error("injected withdraw failure");
      if (it.review_id) {
        const w = await withdrawReviewAsSystem({ nestId: p.nest_id, reviewId: it.review_id, reason });
        const author = w?.requestedBy ?? ((await db.get("SELECT requested_by FROM review_requests WHERE id = ?", [it.review_id])) as { requested_by?: string } | undefined)?.requested_by;
        const review = (await db.get("SELECT status FROM review_requests WHERE id = ?", [it.review_id])) as { status?: string } | undefined;
        if (review?.status === "pending") throw new Error("review still pending");
        if (review?.status === "approved") {
          // A person approved it first: it's theirs now, not ours to withdraw.
          await db.run("UPDATE surface_proposal_items SET state = 'approved', updated_at = ? WHERE id = ? AND state = 'pending'", [iso(Date.now()), it.id]);
          continue;
        }
        if (it.node_id && author) await discardDraftIfOurs(p.nest_id, it.node_id, author);
      }
      const r = await db.run(
        "UPDATE surface_proposal_items SET state = 'withdrawn', title = NULL, title_tokens = '[]', reason = ?, decided_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
        [reason, iso(Date.now()), iso(Date.now()), it.id],
      );
      if (r.changes) done++;
    } catch {
      failed++;
    }
  }
  // One alert per proposal, however many sweeps retry it (round 3, N5).
  const firstAlert = failed
    ? (await db.run("UPDATE surface_proposals SET withdraw_alerted = 1 WHERE id = ? AND withdraw_alerted = 0", [proposalId])).changes > 0
    : false;
  if (firstAlert) {
    await recordNotice({
      kind: "withdraw_failed",
      audience: "admins",
      bindingId: p.binding_id,
      nestId: p.nest_id,
      detail: { items: failed },
      subject: "Nest couldn't withdraw some proposals yet",
      text: `${failed} proposal(s) from a conversation that stopped capturing couldn't be withdrawn yet. They stay hidden from readers, and Nest retries automatically.`,
    }).catch(() => "");
  }
  const left = (await db.get("SELECT COUNT(*) AS n FROM surface_proposal_items WHERE proposal_id = ? AND state IN ('creating', 'pending')", [proposalId])) as { n: number | string };
  if (Number(left.n) === 0) {
    await db.run("UPDATE surface_proposals SET state = 'withdrawn', updated_at = ? WHERE id = ? AND state IN ('queued', 'held', 'posted')", [iso(Date.now()), proposalId]);
  }
  return done;
}

/** Discard the draft only while it is still the submitter's own head (never a person's later edit).
 *  Shared with S2b's reject/expire purge (draft-purge.ts). */
export async function discardDraftIfOurs(nestId: string, nodeId: string, author: string): Promise<void> {
  const head = (await getDb().get("SELECT version, author FROM node_versions WHERE nest_id = ? AND node_id = ? ORDER BY version DESC LIMIT 1", [nestId, nodeId])) as
    | { version: number; author: string }
    | undefined;
  if (!head || String(head.author).toLowerCase() !== author.toLowerCase()) return;
  await discardDraft(nestId, nodeId, author, { expectHead: head.version });
}

export async function withdrawForBinding(bindingId: string): Promise<number> {
  const rows = (await getDb().all(
    "SELECT DISTINCT p.id FROM surface_proposals p JOIN surface_proposal_items i ON i.proposal_id = p.id WHERE p.binding_id = ? AND i.state IN ('creating', 'pending')",
    [bindingId],
  )) as Array<{ id: string }>;
  let n = 0;
  for (const r of rows) n += await withdrawProposalItems(r.id);
  return n;
}

/** Items left `creating` longer than this are resolved by the sweep (round 3, N3). */
export const STALE_CREATING_MS = 10 * 60_000;

/**
 * Resolve `creating` rows a crash left behind: adopt the pending review the
 * draft got (by node id and proposer), else drop the row — discarding a
 * draft still authored solely by the proposer. Never left hiding forever.
 */
export async function resolveStaleCreating(nowMs = Date.now()): Promise<number> {
  const db = getDb();
  const rows = (await db.all(
    `SELECT i.id, i.nest_id, i.node_id, i.review_id, p.persona_email FROM surface_proposal_items i JOIN surface_proposals p ON p.id = i.proposal_id
      WHERE i.state = 'creating' AND i.updated_at <= ?`,
    [iso(nowMs - STALE_CREATING_MS)],
  )) as Array<{ id: string; nest_id: string; node_id: string | null; review_id: string | null; persona_email: string | null }>;
  let n = 0;
  for (const r of rows) {
    let reviewId = r.review_id;
    if (!reviewId && r.node_id && r.persona_email) {
      const rv = (await db.get(
        "SELECT id FROM review_requests WHERE nest_id = ? AND node_id = ? AND status = 'pending' AND LOWER(requested_by) = LOWER(?) ORDER BY requested_at DESC LIMIT 1",
        [r.nest_id, r.node_id, r.persona_email],
      )) as { id: string } | undefined;
      reviewId = rv?.id ?? null;
    }
    if (reviewId) {
      n += (await db.run("UPDATE surface_proposal_items SET state = 'pending', review_id = ?, updated_at = ? WHERE id = ? AND state = 'creating'", [reviewId, iso(nowMs), r.id])).changes;
      continue;
    }
    if (r.node_id && r.persona_email) await discardDraftIfOurs(r.nest_id, r.node_id, r.persona_email).catch(() => {});
    n += (await db.run("UPDATE surface_proposal_items SET state = 'dropped', title = NULL, updated_at = ? WHERE id = ? AND state = 'creating'", [iso(nowMs), r.id])).changes;
  }
  return n;
}

/** Sweep: resolve stale `creating` rows, then retry withdrawals for bindings no longer capturing. */
export async function retryWithdrawals(nowMs = Date.now()): Promise<number> {
  const db = getDb();
  await resolveStaleCreating(nowMs);
  const rows = (await db.all(
    `SELECT DISTINCT p.id FROM surface_proposals p JOIN surface_proposal_items i ON i.proposal_id = p.id
       LEFT JOIN surface_bindings b ON b.id = p.binding_id
      WHERE i.state = 'pending' AND (b.id IS NULL OR b.status <> 'active')`,
  )) as Array<{ id: string }>;
  let n = 0;
  for (const r of rows) n += await withdrawProposalItems(r.id);
  return n;
}
