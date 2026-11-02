/**
 * Surfaces read models (S2a part): the verdict log. Counts, verdicts and
 * reasons only — window rows never hold text. Org admins see every window;
 * others see windows of bindings on nests they administer.
 */
import { getDb } from "../../db/client.js";
import { canAdministerNest, isOrgAdmin } from "./binding-service.js";

export async function listWindows(
  actorUserId: string,
  f: { bindingId?: string; verdict?: string; from?: string; to?: string; nestId?: string; limit?: number } = {},
) {
  const where: string[] = [];
  const p: string[] = [];
  if (f.bindingId) (where.push("binding_id = ?"), p.push(f.bindingId));
  if (f.verdict) (where.push("verdict = ?"), p.push(f.verdict));
  if (f.from) (where.push("created_at >= ?"), p.push(f.from));
  if (f.to) (where.push("created_at <= ?"), p.push(f.to));
  if (f.nestId) (where.push("nest_id = ?"), p.push(f.nestId));
  const rows = (await getDb().all(
    `SELECT id, binding_id, nest_id, forced, opened_at, closed_at, close_reason, message_count, status, verdict, reason_code, item_count, kinds, blocked,
            model, prompt_version, cost_micros, judged_at
       FROM surface_windows ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`,
    [...p, Math.min(Math.max(f.limit ?? 200, 1), 1000)],
  )) as Array<Record<string, any>>;
  const admin = await isOrgAdmin(actorUserId);
  const allowed = new Map<string, boolean>();
  const out = [];
  for (const r of rows) {
    if (!admin) {
      if (!allowed.has(r.nest_id)) allowed.set(r.nest_id, await canAdministerNest(r.nest_id, actorUserId));
      if (!allowed.get(r.nest_id)) continue;
    }
    out.push({ ...r, forced: !!r.forced, kinds: safe(r.kinds, []), blocked: safe(r.blocked, {}), cost_micros: Number(r.cost_micros) });
  }
  return out;
}

function safe<T>(s: unknown, d: T): T {
  try {
    return typeof s === "string" ? (JSON.parse(s) as T) : d;
  } catch {
    return d;
  }
}

// ─── S2b: proposals and the commit audit ────────────────────────────────────

/** Is this nest someone's personal (DM) nest, and whose? */
async function personalOwner(nestId: string): Promise<string | null> {
  const r = (await getDb().get("SELECT community_user_id FROM surface_personal_nests WHERE nest_id = ?", [nestId])) as { community_user_id: string } | undefined;
  return r?.community_user_id ?? null;
}

export const PRIVATE_TITLE = "DM · private nest · title hidden";

async function visibleNest(actorUserId: string, nestId: string, admin: boolean, cache: Map<string, boolean>): Promise<boolean> {
  if (admin) return true;
  if (!cache.has(nestId)) cache.set(nestId, await canAdministerNest(nestId, actorUserId));
  return cache.get(nestId)!;
}

/**
 * Proposals and outcomes (REST + MCP, same function). Org admins see every
 * nest; others the nests they administer. Personal-nest rows are redacted
 * for anyone but the owner (N1): no title, no conversation.
 */
export async function listProposals(actorUserId: string, f: { nestId?: string; state?: string; limit?: number } = {}) {
  const where: string[] = [];
  const p: string[] = [];
  if (f.nestId) (where.push("p.nest_id = ?"), p.push(f.nestId));
  if (f.state) (where.push("p.state = ?"), p.push(f.state));
  const rows = (await getDb().all(
    `SELECT p.id, p.window_id, p.binding_id, p.nest_id, p.card_kind, p.state, p.forced, p.named_reviewer_user_id, p.posted_at, p.expires_at, p.queue_reason,
            p.hold_reason, p.message_count, p.created_at, b.conversation_name, b.conversation_kind
       FROM surface_proposals p LEFT JOIN surface_bindings b ON b.id = p.binding_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY p.created_at DESC LIMIT ?`,
    [...p, Math.min(Math.max(f.limit ?? 200, 1), 1000)],
  )) as Array<Record<string, any>>;
  const admin = await isOrgAdmin(actorUserId);
  const cache = new Map<string, boolean>();
  const out = [];
  for (const r of rows) {
    if (!(await visibleNest(actorUserId, r.nest_id, admin, cache))) continue;
    const owner = await personalOwner(r.nest_id);
    const redact = !!owner && owner !== actorUserId;
    const items = (await getDb().all(
      "SELECT id, item_kind, op, target_folder, title, state, decided_by_user_id, decided_at, version, reason, edited FROM surface_proposal_items WHERE proposal_id = ? ORDER BY created_at",
      [r.id],
    )) as Array<Record<string, any>>;
    out.push({
      id: r.id,
      nest_id: r.nest_id,
      binding_id: r.binding_id,
      conversation: redact ? "DM · private nest" : (r.conversation_name ?? null),
      card_kind: r.card_kind,
      state: r.state,
      forced: !!r.forced,
      // Queue state is shown to admins here (N2: never on a channel card).
      named_reviewer_user_id: redact ? null : r.named_reviewer_user_id,
      queue_reason: r.queue_reason,
      hold_reason: r.hold_reason,
      message_count: Number(r.message_count ?? 0),
      posted_at: r.posted_at,
      expires_at: r.expires_at,
      created_at: r.created_at,
      private_nest: !!owner,
      items: items.map((i) => ({
        id: i.id,
        kind: i.item_kind,
        op: i.op,
        folder: i.target_folder,
        title: redact ? PRIVATE_TITLE : i.title,
        state: i.state,
        decided_by_user_id: redact ? null : i.decided_by_user_id,
        decided_at: i.decided_at,
        version: i.version,
        reason: i.reason,
        edited: !!i.edited,
      })),
    });
  }
  return out;
}

/**
 * The commit audit (AC-SRF-01): who approved (the Community user), from
 * which surface, the surface user id kept for audit, the window and its
 * message count, the proposal — and "proposed by Nest listener".
 */
export async function listCommits(actorUserId: string, f: { nestId?: string; nodeId?: string; proposalId?: string; limit?: number } = {}) {
  const where: string[] = [];
  const p: string[] = [];
  if (f.nestId) (where.push("c.nest_id = ?"), p.push(f.nestId));
  if (f.nodeId) (where.push("c.node_id = ?"), p.push(f.nodeId));
  if (f.proposalId) (where.push("c.proposal_id = ?"), p.push(f.proposalId));
  const rows = (await getDb().all(
    `SELECT c.*, u.email AS approver_email, u.name AS approver_name, w.message_count AS window_message_count
       FROM surface_commits c LEFT JOIN users u ON u.id = c.approved_by_user_id LEFT JOIN surface_windows w ON w.id = c.window_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY c.created_at DESC LIMIT ?`,
    [...p, Math.min(Math.max(f.limit ?? 200, 1), 1000)],
  )) as Array<Record<string, any>>;
  const admin = await isOrgAdmin(actorUserId);
  const cache = new Map<string, boolean>();
  const out = [];
  for (const r of rows) {
    if (!(await visibleNest(actorUserId, r.nest_id, admin, cache))) continue;
    const owner = await personalOwner(r.nest_id);
    const redact = !!owner && owner !== actorUserId;
    out.push({
      id: r.id,
      nest_id: r.nest_id,
      node_id: redact ? null : r.node_id,
      version: r.version,
      approved_by: { user_id: r.approved_by_user_id, email: redact ? null : r.approver_email, name: redact ? null : r.approver_name },
      surface: r.surface,
      install_id: r.install_id,
      surface_user_id: redact ? null : r.surface_user_id,
      conversation_id: redact ? null : r.conversation_id,
      window_id: r.window_id,
      window_message_count: r.window_message_count == null ? null : Number(r.window_message_count),
      proposal_id: r.proposal_id,
      proposal_item_id: r.proposal_item_id,
      action: r.action,
      edited: !!r.edited,
      self_vouched: !!r.self_vouched,
      proposed_by: "Nest listener",
      created_at: r.created_at,
    });
  }
  return out;
}
