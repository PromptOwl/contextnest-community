/**
 * The commit path (PRD §4.12, HR2, HR3). The ONLY place in Surfaces that
 * calls review-service `approve` / `reject` (AC-CMT-15).
 *
 * Preconditions, in order, for every commit-class action:
 *  1. the interaction comes from the proposal's own workspace (team /
 *     enterprise), its own channel (card clicks) and a home-team clicker —
 *     otherwise "Only <org> members can act on this." and NOTHING changes
 *     (AC-IDN-15);
 *  2. the item is still pending;
 *  3. the clicker is linked (else a one-time link, nothing committed) and has
 *     answered the first-use confirm naming the verb (N3);
 *  4. the linked Community user passes canUserApprove on every item (else
 *     the N6 note; no review-service call);
 *  5. each item is claimed with ONE idempotency key per item
 *     (`decide:<item>`), shared with expiry, withdrawal and queue overflow —
 *     so a double click, two reviewers, Approve vs Reject and approve vs
 *     expire/withdraw all resolve to exactly one winner.
 *
 * The approval is made AS the linked person (their email is `approvedBy`);
 * the listener stays the proposer. A service user or the listener's own
 * persona can never be the approver. Slack ids ride as client metadata and
 * are always written to `surface_commits`.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../../db/client.js";
import { config } from "../../config.js";
import { approve, reject } from "../../governance/review-service.js";
import { canUserEdit } from "../../governance/stewardship-service.js";
import { getApprovedVersion } from "../../governance/version-service.js";
import { isPrimeDocument } from "../../governance/prime-service.js";
import { updateNode } from "../../nodes/service.js";
import { purgeSurfaceDraft } from "./draft-purge.js";
import { personalNestRefusal, surfacesPersonalOwner } from "../draft-visibility.js";
import { engineCache } from "../../nodes/engine.js";
import { checkInteraction, type CommitVerb } from "../core/identity-rules.js";
import { nodePath, REASON_LABELS, type CardOutcome, type RejectReason } from "../core/card-model.js";
import { titleTokens } from "../core/dedup.js";
import { checkEdit, type EditedFields, type WindowGuard } from "./edit-guard.js";
import { nameableReviewers } from "../core/reviewers.js";
import { renderConfirm } from "../adapters/slack/blockkit.js";
import { getBindingRow, type BindingRow } from "./binding-service.js";
import { adminFolderRefusal, ADMIN_FOLDER_REFUSAL } from "../admin-folders.js";
import { getInstall, homeTenant, type InstallRow } from "./install-store.js";
import { resolveActor } from "./identity-service.js";
import { listenerFolders, listenerFor } from "./listener-service.js";
import { getItems, getProposal, mentionFor, nestName, updateCardOnce, type ItemRow, type ProposalRow } from "./card-service.js";
import { canReviewAll, eligibleReviewers } from "./routing-service.js";
import { guardKey } from "./window-guard-key.js";

const iso = (ms = Date.now()) => new Date(ms).toISOString();
export const HOLD_MS = 7 * 24 * 3600_000;

/** Where a click came from and how to answer the clicker privately. */
export interface Origin {
  source: "card" | "home";
  team_id: string | null;
  enterprise_id: string | null;
  channel_id: string | null;
  clicker_home_team: string | null;
}
export interface Responder {
  /** A private note to the clicker (Slack: response_url ephemeral / chat.postEphemeral). */
  note(text: string, blocks?: unknown[]): Promise<void>;
}

export interface CommitRequest {
  installId: string;
  surfaceUserId: string;
  proposalId: string;
  verb: CommitVerb;
  /** approve_selected / edit on a merged card: the ticked items. */
  itemIds?: string[];
  reason?: RejectReason | null;
  /** Edit → approve: per-item edits; items absent here are not kept. */
  edits?: Record<string, EditedFields>;
  interactionId: string;
  origin: Origin;
  responder: Responder;
  /** Set after a "Yes, that's me" so the confirm isn't asked again. */
  confirmed?: boolean;
  /** Edit: validate only (the dialog needs field errors within 3 s). */
  dryRun?: boolean;
  /** Edit dry run: stop validating at this time and answer "deferred". */
  deadlineMs?: number;
}

export type Authorized = { ok: true; p: ProposalRow; binding: BindingRow; install: InstallRow; items: ItemRow[]; userId: string; email: string; name: string | null } | { ok: false };

export const ORG_ONLY = (org: string) => `Only ${org} members can act on this.`;
const orgName = () => process.env.SURFACES_ORG_NAME || "this workspace's";

async function userRow(id: string) {
  return (await getDb().get("SELECT id, email, name, is_service FROM users WHERE id = ?", [id])) as
    | { id: string; email: string; name: string | null; is_service: number | null }
    | undefined;
}

/** AC-IDN-15: payload team/enterprise/channel must equal the proposal's binding. */
export function originMatches(origin: Origin, install: InstallRow, binding: BindingRow): boolean {
  const expectedChannel = origin.source === "home" ? null : binding.conversation_id;
  const v = checkInteraction(
    { team_id: origin.team_id, enterprise_id: origin.enterprise_id, channel_id: origin.source === "home" ? null : origin.channel_id, clicker_home_team: origin.clicker_home_team },
    { team_id: install.team_id, enterprise_id: install.enterprise_id, channel_id: expectedChannel as string, install_home_team: homeTenant(install) },
  );
  return v.ok;
}

/** The N6 note: names only eligible reviewers who are members of this conversation. */
export async function notReviewerNote(p: ProposalRow, binding: BindingRow, items: ItemRow[]): Promise<string> {
  const nest = await nestName(p.nest_id);
  const { eligible, members } = await eligibleReviewers(p, binding, items);
  const names = nameableReviewers(eligible, [...members.keys()])
    .map((u) => members.get(u))
    .filter((s): s is string => !!s && /^[A-Z0-9_]+$/.test(s))
    .map((s) => `<@${s}>`);
  if (!names.length) return `Only reviewers of ${nest} can approve this. A ${nest} reviewer can approve it from their My pending.`;
  return `Only reviewers of ${nest} can approve this. ${names.join(", ")} can, and they're in this channel.`;
}

const alreadyWord: Record<string, string> = { approved: "approved", rejected: "rejected", expired: "expired", withdrawn: "withdrawn", dropped: "withdrawn" };

async function alreadyNote(install: InstallRow, items: ItemRow[]): Promise<string> {
  const decided = items.find((i) => i.state !== "pending") ?? items[0];
  if (!decided) return "This proposal was already decided.";
  const who = await mentionFor(install.id, decided.decided_by_user_id);
  const w = alreadyWord[decided.state] ?? "decided";
  return who ? `Already ${w} by ${who}.` : `Already ${w}.`;
}

/**
 * Steps 1–4 shared by every commit-class action and by opening the Edit /
 * Reject dialogs (checked BEFORE views.open, AC-CMT-06).
 */
export async function authorize(req: Omit<CommitRequest, "interactionId"> & { interactionId?: string }): Promise<Authorized> {
  const p = await getProposal(req.proposalId);
  const binding = p ? await getBindingRow(p.binding_id) : null;
  const install = binding ? await getInstall(binding.install_id) : null;
  if (!p || !binding || !install || install.id !== req.installId || install.status !== "active") {
    await req.responder.note(ORG_ONLY(orgName()));
    return { ok: false };
  }
  if (!originMatches(req.origin, install, binding)) {
    await req.responder.note(ORG_ONLY(orgName()));
    return { ok: false };
  }
  const all = await getItems(p.id);
  const wanted = req.itemIds?.length ? all.filter((i) => req.itemIds!.includes(i.id)) : all;
  const pending = all.filter((i) => i.state === "pending");
  if (!pending.length || (req.itemIds?.length && wanted.every((i) => i.state !== "pending"))) {
    await req.responder.note(await alreadyNote(install, all));
    return { ok: false };
  }
  if (p.state !== "posted" && p.state !== "held" && p.state !== "queued") {
    await req.responder.note(await alreadyNote(install, all));
    return { ok: false };
  }
  const actor = await resolveActor({ installId: install.id, surfaceUserId: req.surfaceUserId, action: req.verb });
  if (actor.status === "rate_limited") {
    await req.responder.note(actor.message);
    return { ok: false };
  }
  if (actor.status === "needs_link") {
    await req.responder.note(
      `Link your ContextNest account first (the link works once, for 15 minutes): <${actor.url}|Link my account>. Nothing was ${req.verb === "reject" ? "rejected" : "approved"}; click the button again afterwards.`,
    );
    return { ok: false };
  }
  if (actor.status === "confirm" && !req.confirmed) {
    const value = JSON.stringify({ p: p.id, v: req.verb, l: actor.linkId, i: req.itemIds ?? null, r: req.reason ?? null });
    await req.responder.note(actor.prompt.replace(/\*\*/g, "*"), renderConfirm(actor.prompt, value));
    return { ok: false };
  }
  const userId = actor.userId;
  const u = await userRow(userId);
  // Never the bot, never a service account, never the listener persona.
  const listener = await listenerFor(binding.id);
  if (!u || u.is_service || (listener && listener.persona.email.toLowerCase() === u.email.toLowerCase())) {
    await req.responder.note(await notReviewerNote(p, binding, pending));
    return { ok: false };
  }
  const target = (req.itemIds?.length ? wanted : pending).filter((i) => i.state === "pending");
  // A personal (DM) nest: its owner alone reviews (Misha, 2026-11-01).
  const personal = await surfacesPersonalOwner(p.nest_id);
  if (personal && personal.userId !== userId) {
    await req.responder.note(personalNestRefusal(personal));
    return { ok: false };
  }
  if (!(await canReviewAll(p.nest_id, userId, pending))) {
    await req.responder.note(await notReviewerNote(p, binding, pending));
    return { ok: false };
  }
  // §13 / S7-R2 L4: a seed's admin_only folders take approvals from nest
  // admins only — read from the nest's seeds (never the listener row), fail closed.
  for (const it of target) {
    const refusal = it.node_id ? await adminFolderRefusal(p.nest_id, it.node_id, u.email) : ADMIN_FOLDER_REFUSAL;
    if (refusal) {
      await req.responder.note(refusal);
      return { ok: false };
    }
  }
  // R2: approve-with-edits needs edit rights too (the existing rule) — checked
  // before any dialog opens.
  if (req.verb === "edit") {
    for (const it of target) {
      if (!it.node_id || !(await canUserEdit(it.nest_id, it.node_id, u.email).catch(() => ({ allowed: false }))).allowed) {
        await req.responder.note("You can approve or reject this; editing needs edit rights on the document.");
        return { ok: false };
      }
    }
  }
  return { ok: true, p, binding, install, items: target, userId, email: u.email, name: u.name };
}

/** One winner per item: approve, reject, expire, withdraw and overflow all claim this key. */
export async function claimItem(itemId: string, action: string, who: { surfaceUserId?: string | null; userId?: string | null; surface?: string | null } = {}): Promise<boolean> {
  const r = await getDb().run(
    `INSERT INTO surface_actions (id, idempotency_key, proposal_item_id, action, surface, surface_user_id, community_user_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?) ON CONFLICT (idempotency_key) DO NOTHING`,
    [uuid(), `decide:${itemId}`, itemId, action, who.surface ?? null, who.surfaceUserId ?? null, who.userId ?? null, iso(), iso()],
  );
  return r.changes > 0;
}
async function finishClaim(itemId: string, result: Record<string, unknown>): Promise<void> {
  await getDb().run("UPDATE surface_actions SET status = 'done', result = ?, updated_at = ? WHERE idempotency_key = ?", [JSON.stringify(result), iso(), `decide:${itemId}`]);
}
/** A commit that failed releases its claim so a later click can retry. */
async function releaseClaim(itemId: string): Promise<void> {
  await getDb().run("DELETE FROM surface_actions WHERE idempotency_key = ? AND status = 'in_progress'", [`decide:${itemId}`]);
}

function clientMeta(req: CommitRequest, a: Extract<Authorized, { ok: true }>, item: ItemRow, edited: boolean) {
  return {
    agent: "surfaces",
    client: "surfaces",
    surface: a.install.surface,
    install_id: a.install.id,
    surface_user_id: req.surfaceUserId,
    conversation_id: a.binding.conversation_id,
    window_id: a.p.window_id,
    proposal_id: a.p.id,
    proposal_item_id: item.id,
    interaction_id: req.interactionId.slice(0, 200),
    ...(edited ? { edited: true } : {}),
  };
}


/** After a reject: draft purged, title/summary purged, 7-day fingerprint hold. */
export async function purgeAndHold(binding: BindingRow, item: ItemRow, source: "rejected" | "expired", nowMs = Date.now()): Promise<void> {
  if (item.node_id) await purgeSurfaceDraft({ nestId: item.nest_id, nodeId: item.node_id, reviewId: item.review_id, proposalId: item.proposal_id, cancel: false });
  // A sealed personal nest keeps keyed hashes, never plaintext title tokens.
  const { sealedNest } = await import("../sealed.js");
  const plainTokens = item.title ? titleTokens(item.title) : [];
  const tokens = (await sealedNest(item.nest_id)) ? plainTokens.map((await import("./fingerprint-hash.js")).fingerprintHasher(item.nest_id)) : plainTokens;
  const { createHash } = await import("crypto");
  await getDb().run(
    `INSERT INTO surface_fingerprints (id, nest_id, binding_id, kind, op, target_folder, target_node_id, node_id, title_tokens, title_hash, source, hold_until, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuid(),
      item.nest_id,
      binding.id,
      item.item_kind,
      item.op,
      item.target_folder,
      item.target_node_id,
      item.node_id,
      JSON.stringify(tokens),
      createHash("sha256").update([...tokens].sort().join(" ")).digest("hex"),
      source,
      iso(nowMs + HOLD_MS),
      iso(nowMs),
    ],
  );
  await getDb().run("UPDATE surface_proposal_items SET title = NULL, summary = NULL, why = NULL, on_record = NULL, title_tokens = '[]', updated_at = ? WHERE id = ?", [
    iso(nowMs),
    item.id,
  ]);
}

async function maybeDecided(proposalId: string): Promise<void> {
  const left = (await getDb().get("SELECT COUNT(*) AS n FROM surface_proposal_items WHERE proposal_id = ? AND state = 'pending'", [proposalId])) as { n: number | string };
  if (Number(left.n) === 0) {
    await getDb().run("UPDATE surface_proposals SET state = 'decided', window_guard = NULL, updated_at = ? WHERE id = ? AND state IN ('posted', 'held', 'queued')", [
      iso(),
      proposalId,
    ]);
  }
}

const firstName = (n: string | null, email: string) => (n?.trim().split(/\s+/)[0] || email.split("@")[0]);

async function approveOne(req: CommitRequest, a: Extract<Authorized, { ok: true }>, item: ItemRow, edit: EditedFields | null): Promise<{ ok: true; version: number | null } | { ok: false; why: string }> {
  if (!item.node_id) return { ok: false, why: "missing draft" };
  if (!(await claimItem(item.id, edit ? "edit_approve" : req.verb, { surfaceUserId: req.surfaceUserId, userId: a.userId, surface: a.install.surface }))) {
    return { ok: false, why: "already" };
  }
  // A binding paused under us (withdraw in flight): don't commit into it.
  const live = await getBindingRow(a.binding.id);
  if (!live || live.status !== "active") {
    await releaseClaim(item.id);
    return { ok: false, why: "already" };
  }
  try {
    if (edit) {
      const { storage } = await engineCache.get(item.nest_id);
      const doc = await storage.readDocument(item.node_id);
      if (await isPrimeDocument(item.nest_id, (doc.frontmatter.tags || []) as string[], doc.frontmatter.metadata)) throw new Error("prime");
      const body = String(doc.body ?? "");
      const cut = body.lastIndexOf("\n\n---\n_Source:");
      const provenance = cut >= 0 ? body.slice(cut) : "";
      await updateNode(
        item.nest_id,
        item.node_id,
        { title: edit.title, content: `${edit.body.trim()}${provenance}`, changeNote: "Reviewer edit before approval (from Slack)", client: clientMeta(req, a, item, true) },
        a.email,
        { reviewerEdit: true },
      );
    }
    await approve({
      nestId: item.nest_id,
      nodeId: item.node_id,
      approvedBy: a.email,
      note: edit ? "Approved with reviewer edits (from Slack)" : "Approved from Slack",
      baseUrl: config.PUBLIC_BASE_URL || undefined,
      client: clientMeta(req, a, item, !!edit),
      ...(edit ? { withEdits: true } : {}),
    });
  } catch {
    await releaseClaim(item.id);
    return { ok: false, why: "failed" };
  }
  const version = (await getApprovedVersion(item.nest_id, item.node_id).catch(() => null)) ?? null;
  // L6: the item, the audit row and the claim finalise land in ONE
  // transaction. A crash before it leaves an in_progress claim that the
  // sweep reconciles from the review row (reconcileStuckClaims).
  await getDb().transaction(async (tx) => {
    await tx.run(
      `UPDATE surface_proposal_items SET state = 'approved', decided_by_user_id = ?, decided_at = ?, version = ?, edited = ?,
         title = COALESCE(?, title), summary = COALESCE(?, summary), updated_at = ? WHERE id = ? AND state = 'pending'`,
      [a.userId, iso(), version, edit ? 1 : 0, edit?.title ?? null, edit?.summary ?? null, iso(), item.id],
    );
    await writeCommitRow(tx, {
      item,
      proposal: a.p,
      approver: a.userId,
      surface: a.install.surface,
      installId: a.install.id,
      surfaceUserId: req.surfaceUserId,
      conversationId: a.binding.conversation_id,
      action: edit ? "edit_approve" : req.verb === "update_record" ? "update_record" : req.verb === "approve_selected" ? "approve_selected" : "approve",
      edited: !!edit,
      version,
    });
    await tx.run("UPDATE surface_actions SET status = 'done', result = ?, updated_at = ? WHERE idempotency_key = ?", [
      JSON.stringify({ outcome: "approved", version }),
      iso(),
      `decide:${item.id}`,
    ]);
  });
  return { ok: true, version };
}

type Runner = { run: (sql: string, p?: any[]) => Promise<unknown>; get?: (sql: string, p?: any[]) => Promise<unknown> };

/** The surface_commits audit row (shared by the commit path and the reconciler). */
async function writeCommitRow(
  q: Runner,
  r: {
    item: ItemRow;
    proposal: ProposalRow;
    approver: string;
    surface: string;
    installId: string | null;
    surfaceUserId: string | null;
    conversationId: string | null;
    action: string;
    edited: boolean;
    version: number | null;
  },
): Promise<void> {
  await q.run(
    `INSERT INTO surface_commits (id, nest_id, node_id, version, review_id, proposal_item_id, proposal_id, window_id, approved_by_user_id, surface, install_id,
       surface_user_id, conversation_id, action, edited, self_vouched, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuid(),
      r.item.nest_id,
      r.item.node_id,
      r.version,
      r.item.review_id,
      r.item.id,
      r.proposal.id,
      r.proposal.window_id,
      r.approver,
      r.surface,
      r.installId,
      r.surfaceUserId,
      r.conversationId,
      r.action,
      r.edited ? 1 : 0,
      r.proposal.requested_by_surface_user_id && r.proposal.requested_by_surface_user_id === r.surfaceUserId ? 1 : 0,
      iso(),
    ],
  );
}

export const STUCK_CLAIM_MS = 5 * 60_000;

/**
 * Security L6: a `decide:<item>` claim left in_progress for > 5 min (a crash
 * between the claim and its finalise) is reconciled from the review row:
 *  - approved → the item is marked approved by the reviewer, the missing
 *    surface_commits row is written, the claim is finalised (one transaction);
 *  - rejected → the item is marked rejected and purged with its hold;
 *  - anything else → the claim is released, so a click or the expiry can act.
 */
export async function reconcileStuckClaims(nowMs = Date.now()): Promise<number> {
  const db = getDb();
  const stuck = (await db.all("SELECT * FROM surface_actions WHERE status = 'in_progress' AND updated_at <= ?", [iso(nowMs - STUCK_CLAIM_MS)])) as Array<{
    id: string;
    idempotency_key: string;
    proposal_item_id: string | null;
    surface: string | null;
    surface_user_id: string | null;
    community_user_id: string | null;
  }>;
  let n = 0;
  for (const c of stuck) {
    const item = c.proposal_item_id ? ((await db.get("SELECT * FROM surface_proposal_items WHERE id = ?", [c.proposal_item_id])) as ItemRow | undefined) : undefined;
    if (!item || item.state !== "pending") {
      await db.run("UPDATE surface_actions SET status = 'done', updated_at = ? WHERE id = ? AND status = 'in_progress'", [iso(), c.id]);
      n++;
      continue;
    }
    const review = (item.review_id
      ? await db.get("SELECT status, resolved_by FROM review_requests WHERE id = ?", [item.review_id])
      : await db.get("SELECT status, resolved_by FROM review_requests WHERE nest_id = ? AND node_id = ? ORDER BY requested_at DESC LIMIT 1", [item.nest_id, item.node_id])) as
      | { status: string; resolved_by: string | null }
      | undefined;
    const p = await getProposal(item.proposal_id);
    const binding = p ? await getBindingRow(p.binding_id) : null;
    // Re-review N3: the decision belongs to whoever ACTUALLY resolved the
    // review (review_requests.resolved_by), never the clicker by assumption.
    const resolver = review?.resolved_by
      ? ((await db.get("SELECT id FROM users WHERE LOWER(email) = LOWER(?)", [review.resolved_by])) as { id: string } | undefined)?.id ?? null
      : null;
    const sameAsClicker = !!resolver && resolver === c.community_user_id;
    // The resolver's own Slack identity in this install, if linked.
    const resolverSurface = resolver && binding
      ? (((await db.get("SELECT surface_user_id FROM surface_identity_links WHERE install_id = ? AND community_user_id = ? AND status = 'active'", [
          binding.install_id,
          resolver,
        ])) as { surface_user_id: string } | undefined)?.surface_user_id ?? null)
      : null;
    if (review?.status === "approved" && p) {
      const approver = resolver;
      if (!approver) continue; // resolved by something we can't attribute: leave the claim for an admin to see
      const version = item.node_id ? ((await getApprovedVersion(item.nest_id, item.node_id).catch(() => null)) ?? null) : null;
      await db.transaction(async (tx) => {
        const r = (await tx.run(
          "UPDATE surface_proposal_items SET state = 'approved', decided_by_user_id = ?, decided_at = ?, version = ?, updated_at = ? WHERE id = ? AND state = 'pending'",
          [approver, iso(), version, iso(), item.id],
        )) as { changes: number };
        if (r.changes) {
          await writeCommitRow(tx, {
            item,
            proposal: p,
            approver,
            surface: c.surface ?? "slack",
            installId: binding?.install_id ?? null,
            surfaceUserId: sameAsClicker ? c.surface_user_id : resolverSurface,
            conversationId: binding?.conversation_id ?? null,
            action: sameAsClicker ? "approve_reconciled" : "approve_external",
            edited: false,
            version,
          });
        }
        await tx.run("UPDATE surface_actions SET status = 'done', result = ?, updated_at = ? WHERE id = ?", [JSON.stringify({ outcome: "approved", reconciled: true }), iso(), c.id]);
      });
      await maybeDecided(item.proposal_id);
      n++;
    } else if (review?.status === "rejected" && binding) {
      const r = await db.run("UPDATE surface_proposal_items SET state = 'rejected', decided_by_user_id = ?, decided_at = ?, updated_at = ? WHERE id = ? AND state = 'pending'", [
        resolver,
        iso(),
        iso(),
        item.id,
      ]);
      if (r.changes) await purgeAndHold(binding, item, "rejected", nowMs);
      await db.run("UPDATE surface_actions SET status = 'done', updated_at = ? WHERE id = ?", [iso(), c.id]);
      await maybeDecided(item.proposal_id);
      n++;
    } else {
      await db.run("DELETE FROM surface_actions WHERE id = ? AND status = 'in_progress'", [c.id]);
      n++;
    }
  }
  return n;
}

async function rejectOne(req: CommitRequest, a: Extract<Authorized, { ok: true }>, item: ItemRow, reason: RejectReason | null): Promise<boolean> {
  if (!item.node_id) return false;
  if (!(await claimItem(item.id, `reject:${reason ?? "none"}`, { surfaceUserId: req.surfaceUserId, userId: a.userId, surface: a.install.surface }))) return false;
  try {
    await reject({ nestId: item.nest_id, nodeId: item.node_id, rejectedBy: a.email, note: reason ? REASON_LABELS[reason] : "Rejected from Slack", baseUrl: config.PUBLIC_BASE_URL || undefined });
  } catch {
    await releaseClaim(item.id);
    return false;
  }
  await getDb().run("UPDATE surface_proposal_items SET state = 'rejected', decided_by_user_id = ?, decided_at = ?, reason = ?, updated_at = ? WHERE id = ? AND state = 'pending'", [
    a.userId,
    iso(),
    reason,
    iso(),
    item.id,
  ]);
  await purgeAndHold(a.binding, item, "rejected");
  await finishClaim(item.id, { outcome: "rejected", reason });
  return true;
}

export type CommitResult =
  | { status: "done"; outcome: CardOutcome }
  | { status: "stopped" }
  | { status: "valid" }
  | { status: "deferred" }
  | { status: "invalid"; errors: Record<string, string> };

/**
 * Approve / Approve selected / Update the record / Reject (+reason) / Keep
 * the record / Edit → approve. Updates the card in place when done.
 */
export async function commit(req: CommitRequest): Promise<CommitResult> {
  // Security L5: "Approve selected" with nothing selected is a no-op. It
  // never turns into a reject — rejecting is always its own explicit action.
  if (req.verb === "approve_selected" && !(req.itemIds?.length)) {
    await req.responder.note("Select at least one item to approve, or use Reject all.");
    return { status: "stopped" };
  }
  const a = await authorize(req);
  if (!a.ok) return { status: "stopped" };
  const me = (await mentionFor(a.install.id, a.userId)) ?? `<@${req.surfaceUserId}>`;
  const before = await getItems(a.p.id); // titles intact, for the card
  const pending = before.filter((i) => i.state === "pending");
  let toApprove: ItemRow[] = [];
  let toReject: Array<{ item: ItemRow; reason: RejectReason | null }> = [];
  switch (req.verb) {
    case "approve":
    case "update_record":
      toApprove = pending;
      break;
    case "approve_selected": {
      const ticked = new Set(req.itemIds ?? []);
      toApprove = pending.filter((i) => ticked.has(i.id));
      if (!toApprove.length) {
        await req.responder.note("Select at least one item to approve, or use Reject all.");
        return { status: "stopped" };
      }
      toReject = pending.filter((i) => !ticked.has(i.id)).map((item) => ({ item, reason: "not_selected" as const }));
      break;
    }
    case "reject":
      toReject = pending.map((item) => ({ item, reason: req.reason ?? null }));
      break;
    case "keep_record":
      toReject = pending.map((item) => ({ item, reason: "keep_existing" as const }));
      break;
    case "edit": {
      const edits = req.edits ?? {};
      toApprove = pending.filter((i) => edits[i.id]);
      toReject = pending.filter((i) => !edits[i.id]).map((item) => ({ item, reason: "not_selected" as const }));
      const errors: Record<string, string> = {};
      for (const it of toApprove) {
        const err = await validateEdit(a, it, edits[it.id], req.deadlineMs);
        if (err === "deferred") return { status: "deferred" };
        if (err) errors[`${err.field}:${it.id}`] = err.message;
        if (it.node_id && !(await canUserEdit(it.nest_id, it.node_id, a.email).catch(() => ({ allowed: false }))).allowed) {
          errors[`title:${it.id}`] = "Edit & approve needs edit rights on this document too.";
        }
      }
      if (Object.keys(errors).length) {
        // The real (non-dry) run reports problems through response_url too.
        if (!req.dryRun) await req.responder.note(`Nothing was approved: ${Object.values(errors)[0]}`);
        return { status: "invalid", errors };
      }
      if (req.dryRun) return { status: "valid" };
      break;
    }
  }
  const kept: Array<{ path: string; version: number | null }> = [];
  const notKept: string[] = [];
  let already = 0;
  for (const it of toApprove) {
    const r = await approveOne(req, a, it, req.verb === "edit" ? (req.edits?.[it.id] ?? null) : null);
    if (r.ok) kept.push({ path: nodePath(it.target_folder, it.node_id ?? it.title ?? ""), version: r.version });
    else if (r.why === "already") already++;
  }
  const rejected: RejectReason[] = [];
  for (const { item, reason } of toReject) {
    if (await rejectOne(req, a, item, reason)) {
      notKept.push(item.title ?? "an item");
      rejected.push(reason ?? "other");
    } else already++;
  }
  await maybeDecided(a.p.id);
  if (!kept.length && !notKept.length) {
    await req.responder.note(already ? await alreadyNote(a.install, await getItems(a.p.id)) : "Nothing was saved: the nest refused the change. Try again from the nest.");
    return { status: "stopped" };
  }
  const editedBy = req.verb === "edit" ? firstName(a.name, a.email) : null;
  let outcome: CardOutcome;
  if (kept.length) outcome = { type: "approved", by: me, kept, notKept, editedBy };
  else {
    const reason = req.verb === "keep_record" ? "keep_existing" : req.verb === "approve_selected" && rejected.every((r) => r === "not_selected") ? null : (req.reason ?? null);
    outcome = { type: "rejected", by: me, reason };
  }
  if (a.p.state === "posted") await updateCardOnce(a.p.id, outcome, before);
  if (already) await req.responder.note(await alreadyNote(a.install, await getItems(a.p.id)));
  return { status: "done", outcome };
}

/** At most this many other documents are read to check an edit (INFO e). */
export const EDIT_CHECK_MAX_DOCS = 300;

async function validateEdit(a: Extract<Authorized, { ok: true }>, it: ItemRow, e: EditedFields, deadlineMs?: number): Promise<EditCheckFail | "deferred" | null> {
  const listener = await listenerFor(a.binding.id);
  const people = listener ? listenerFolders(listener).people : [];
  let guard: WindowGuard | null = null;
  try {
    guard = a.p.window_guard ? (JSON.parse(a.p.window_guard) as WindowGuard) : null;
  } catch {
    guard = null;
  }
  const index = (await getDb().all("SELECT node_id AS id, title FROM node_index WHERE nest_id = ? AND node_id <> ?", [it.nest_id, it.node_id ?? ""])) as Array<{
    id: string;
    title: string;
  }>;
  // Only documents the editor can read (INFO e): the check never consults
  // text they couldn't open themselves.
  const { filterAccessible } = await import("../../governance/access-guard.js");
  const readable = (await filterAccessible(it.nest_id, a.userId, a.email, index)).filter((o) => o.id !== it.target_node_id).slice(0, EDIT_CHECK_MAX_DOCS);
  const texts: string[] = [];
  const { storage } = await engineCache.get(it.nest_id);
  for (const o of readable) {
    if (deadlineMs && Date.now() > deadlineMs) return "deferred";
    try {
      const d = await storage.readDocument(o.id);
      texts.push(`${o.title}\n${d.body ?? ""}`);
    } catch {
      /* unreadable node: skip */
    }
  }
  const r = checkEdit(e, { guard, key: guardKey(), otherNodeTexts: texts, peopleFolder: people.includes(it.target_folder), kind: it.item_kind });
  return r.ok ? null : r;
}
type EditCheckFail = Extract<ReturnType<typeof checkEdit>, { ok: false }>;

/** Edit / Reject dialogs: run steps 1–4 BEFORE views.open (AC-CMT-06). */
export async function authorizeDialog(req: Omit<CommitRequest, "interactionId">): Promise<Authorized> {
  return authorize(req);
}

/** For the Edit dialog: the current draft of each pending item (body without provenance). */
export async function editableItems(items: ItemRow[]): Promise<Array<{ id: string; title: string; summary: string; body: string; kind: string; folder: string }>> {
  const out = [];
  for (const it of items) {
    let body = "";
    if (it.node_id) {
      try {
        const { storage } = await engineCache.get(it.nest_id);
        const d = await storage.readDocument(it.node_id);
        body = String(d.body ?? "");
        const cut = body.lastIndexOf("\n\n---\n_Source:");
        if (cut >= 0) body = body.slice(0, cut);
      } catch {
        body = "";
      }
    }
    out.push({ id: it.id, title: it.title ?? "", summary: it.summary ?? "", body: body.trim(), kind: it.item_kind, folder: it.target_folder });
  }
  return out;
}

