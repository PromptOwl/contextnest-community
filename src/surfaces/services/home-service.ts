/**
 * "My pending" (PRD AC-HOM-*): one read model for the Slack App Home, REST
 * `GET /surfaces/pending` and MCP `context_surfaces_my_pending`.
 *
 *  - Lists pending items ONLY from nests the viewer already reads and can
 *    review (canUserApprove), so permissions follow nest structure.
 *  - In-thread items, held items (with the commit buttons, same commit
 *    service + first-use confirm), the viewer's own queue and the one daily
 *    limit number from settings (AC-CRD-10).
 *  - Org admins also see "Held for a reviewer (admin view)": counts and who
 *    has them; personal-nest titles are redacted for anyone but the owner (N1).
 *  - No DM nudges, ever: this is only ever published when the person opens
 *    the Home tab or acts on it.
 */
import { getDb } from "../../db/client.js";
import { canUserApprove } from "../../governance/stewardship-service.js";
import { resolveNestPermission, permissionLevel } from "../../shared/access.js";
import { orgDay } from "../core/budget.js";
import { ACTION, clip, esc } from "../adapters/slack/blockkit.js";
import { getConnector } from "../registry.js";
import { isOrgAdmin } from "./binding-service.js";
import { getInstall, installRef, type InstallRow } from "./install-store.js";
import { activeLink, issueLinkToken, linkUrl } from "./identity-service.js";
import { getSettings } from "./settings-service.js";
import { dateLabel, draftUrl, mentionFor, parseRef, reviewerCanEdit } from "./card-service.js";
import { canReviewAll } from "./routing-service.js";
import { personalDmOff } from "./dm-service.js";
import { PRIVATE_NEST_DISCLOSURE } from "../core/card-model.js";

export const REDACTED_TITLE = "DM · private nest · title hidden";

export interface PendingRow {
  proposal_id: string;
  item_ids: string[];
  nest_id: string;
  nest_name: string;
  conversation: string | null;
  state: "posted" | "held" | "queued";
  title: string;
  summary: string | null;
  folder: string;
  posted_at: string | null;
  expires_at: string;
  queued_release_at: string | null;
  permalink: string | null;
  draft_url: string;
  personal: boolean;
  /** R2: the viewer may edit every item (Edit shows only then). */
  can_edit: boolean;
}

export interface MyPending {
  scope: Array<{ nest_id: string; name: string }>;
  in_thread: PendingRow[];
  held: PendingRow[];
  queued: PendingRow[];
  daily_limit: number;
  used_today: number;
  admin_held: Array<{ nest_id: string; nest_name: string; conversation: string | null; count: number; reviewers: string; title: string }> | null;
}

async function email(userId: string): Promise<string | null> {
  const r = (await getDb().get("SELECT email FROM users WHERE id = ?", [userId])) as { email: string } | undefined;
  return r?.email ?? null;
}

async function personalOwner(nestId: string): Promise<string | null> {
  const r = (await getDb().get("SELECT community_user_id FROM surface_personal_nests WHERE nest_id = ?", [nestId])) as { community_user_id: string } | undefined;
  return r?.community_user_id ?? null;
}

/** Reads the nest and can review it (nest-wide approve right). */
async function readsAndReviews(nestId: string, userId: string, mail: string): Promise<boolean> {
  try {
    if (permissionLevel(await resolveNestPermission(nestId, userId)) < permissionLevel("read")) return false;
    const v = await canUserApprove(nestId, "nodes/__surfaces_scope_probe__", mail, { requestedBy: "surfaces-nobody@invalid" });
    return v.allowed;
  } catch {
    return false;
  }
}

/** AC-HOM-08: who has a held item — linked users who may approve it, by Slack mention only. */
async function reviewerMentions(installId: string, nestId: string, items: Array<{ node_id: string | null }>): Promise<string[]> {
  const links = (await getDb().all("SELECT surface_user_id, community_user_id FROM surface_identity_links WHERE install_id = ? AND status = 'active' ORDER BY surface_user_id", [
    installId,
  ])) as Array<{ surface_user_id: string; community_user_id: string }>;
  const out: string[] = [];
  for (const l of links) {
    if (!(await canReviewAll(nestId, l.community_user_id, items))) continue;
    const m = await mentionFor(installId, l.community_user_id);
    if (m) out.push(m);
  }
  return out;
}

export const PRIVATE_CONVERSATION = "a private channel";

/**
 * My pending. `installId` (the App Home being viewed) scopes the list to that
 * install (security L7); without it (REST / MCP) every install is listed.
 * A conversation's name is shown only for public channels or conversations
 * the viewer is a (snapshot) member of; anything else reads "a private channel".
 */
export async function myPending(userId: string, opts: { installId?: string | null; nestId?: string | null } = {}): Promise<MyPending> {
  const settings = await getSettings();
  const mail = await email(userId);
  const out: MyPending = { scope: [], in_thread: [], held: [], queued: [], daily_limit: settings.reviewer_daily_cards, used_today: 0, admin_held: null };
  if (!mail) return out;
  const day = orgDay(Date.now(), settings.timezone || "UTC");
  const used = (await getDb().get("SELECT cards_posted FROM surface_reviewer_usage WHERE user_id = ? AND day = ?", [userId, day])) as { cards_posted: number } | undefined;
  out.used_today = Number(used?.cards_posted ?? 0);
  const nests = (await getDb().all(
    `SELECT DISTINCT b.nest_id, n.name FROM surface_bindings b JOIN nests n ON n.id = b.nest_id ${opts.nestId ? "WHERE b.nest_id = ?" : ""} ORDER BY n.name`,
    opts.nestId ? [opts.nestId] : [],
  )) as Array<{ nest_id: string; name: string }>;
  const reviewable = new Set<string>();
  for (const n of nests) {
    if (await readsAndReviews(n.nest_id, userId, mail)) {
      reviewable.add(n.nest_id);
      out.scope.push({ nest_id: n.nest_id, name: n.name });
    }
  }
  const where: string[] = ["p.state IN ('posted', 'held', 'queued')"];
  const params: string[] = [];
  if (opts.nestId) (where.push("p.nest_id = ?"), params.push(opts.nestId));
  if (opts.installId) (where.push("b.install_id = ?"), params.push(opts.installId));
  const rows = (await getDb().all(
    `SELECT p.*, b.conversation_name, b.conversation_id, b.conversation_kind, b.install_id, n.name AS nest_name FROM surface_proposals p
       JOIN surface_bindings b ON b.id = p.binding_id JOIN nests n ON n.id = p.nest_id
      WHERE ${where.join(" AND ")} ORDER BY p.created_at`,
    params,
  )) as Array<Record<string, any>>;
  // The viewer's surface identities (every active link of theirs).
  const mine = (await getDb().all("SELECT install_id, surface_user_id FROM surface_identity_links WHERE community_user_id = ? AND status = 'active'", [userId])) as Array<{
    install_id: string;
    surface_user_id: string;
  }>;
  const memberOf = async (bindingId: string, installId: string): Promise<boolean> => {
    for (const l of mine.filter((x) => x.install_id === installId)) {
      if (await getDb().get("SELECT 1 AS x FROM surface_members_cache WHERE binding_id = ? AND surface_user_id = ?", [bindingId, l.surface_user_id])) return true;
    }
    return false;
  };
  const convLabel = async (p: Record<string, any>): Promise<string | null> => {
    if (!p.conversation_name) return null;
    if (p.conversation_kind === "public_channel") return p.conversation_name;
    return (await memberOf(p.binding_id, p.install_id)) ? p.conversation_name : PRIVATE_CONVERSATION;
  };
  const admin = await isOrgAdmin(userId);
  const adminHeld: NonNullable<MyPending["admin_held"]> = [];
  for (const p of rows) {
    const items = (await getDb().all("SELECT * FROM surface_proposal_items WHERE proposal_id = ? AND state = 'pending' ORDER BY created_at", [p.id])) as Array<Record<string, any>>;
    if (!items.length) continue;
    const owner = await personalOwner(p.nest_id);
    const personal = !!owner;
    const redact = personal && owner !== userId;
    if (admin && p.state === "held") {
      const names = redact ? [] : await reviewerMentions(p.install_id, p.nest_id, items as Array<{ node_id: string | null }>);
      adminHeld.push({
        nest_id: p.nest_id,
        nest_name: redact ? "Private nest" : p.nest_name,
        // Admins see every channel name (the Surfaces page does too).
        conversation: redact ? null : (p.conversation_name ?? null),
        count: items.length,
        reviewers: redact ? "Private nest" : names.length ? names.join(", ") : `no linked ${p.nest_name} reviewer yet`,
        title: redact ? REDACTED_TITLE : (items[0].title ?? ""),
      });
    }
    if (!reviewable.has(p.nest_id)) continue;
    if (!(await canReviewAll(p.nest_id, userId, items as Array<{ node_id: string | null }>))) continue;
    if (p.state === "queued" && p.named_reviewer_user_id !== userId) continue;
    let permalink: string | null = null;
    if (p.state === "posted") {
      const ref = parseRef(p.card_ref);
      const install = ref ? await getInstall(p.install_id) : null;
      const c = install ? getConnector(install.surface) : null;
      if (ref && install && c?.permalink) permalink = await c.permalink(installRef(install), ref.conversation, ref.message_ref).catch(() => null);
    }
    const row: PendingRow = {
      proposal_id: p.id,
      item_ids: items.map((i) => i.id),
      nest_id: p.nest_id,
      nest_name: p.nest_name,
      conversation: await convLabel(p),
      state: p.state,
      title: redact ? REDACTED_TITLE : items.length > 1 ? `${items.length} things worth keeping` : (items[0].title ?? ""),
      summary: redact ? null : items.length > 1 ? items.map((i) => `• ${i.title ?? ""}`).join("\n") : (items[0].summary ?? null),
      folder: items[0].target_folder,
      posted_at: p.posted_at ?? null,
      expires_at: p.expires_at,
      queued_release_at: p.queued_release_at ?? null,
      permalink,
      draft_url: draftUrl(items[0].id),
      personal,
      can_edit: await reviewerCanEdit(p.nest_id, userId, items as Array<{ node_id: string | null }>),
    };
    if (p.state === "posted") out.in_thread.push(row);
    else if (p.state === "held") out.held.push(row);
    else out.queued.push(row);
  }
  if (admin) out.admin_held = adminHeld;
  return out;
}

// ─── App Home ───────────────────────────────────────────────────────────────

type Block = Record<string, any>;
const sec = (t: string, extra: Record<string, unknown> = {}): Block => ({ type: "section", text: { type: "mrkdwn", text: clip(t, 3000) }, ...extra });
const ctx = (t: string): Block => ({ type: "context", elements: [{ type: "mrkdwn", text: clip(t, 2000) }] });
const btn = (text: string, action_id: string, value: string, extra: Record<string, unknown> = {}): Block => ({
  type: "button",
  text: { type: "plain_text", text: clip(text, 75) },
  action_id,
  value,
  ...extra,
});
const conv = (c: string | null) => (c === PRIVATE_CONVERSATION ? c : c ? `#${esc(c.replace(/^#/, ""))}` : "a conversation");

export const limitLine = (used: number, limit: number) =>
  `You've had ${used} of your ${limit} cards today. More wait for tomorrow so nobody gets flooded.`;

/** The App Home view for one surface user (AC-HOM-01..08). */
export async function buildHomeView(install: InstallRow, surfaceUserId: string): Promise<Block> {
  const settings = await getSettings();
  const tz = settings.timezone || "UTC";
  const link = await activeLink(install.id, surfaceUserId);
  const optedOut = !!(await getDb().get("SELECT 1 AS x FROM surface_optouts WHERE install_id = ? AND surface_user_id = ?", [install.id, surfaceUserId]));
  const dmOff = await personalDmOff(install.id, surfaceUserId);
  const blocks: Block[] = [{ type: "header", text: { type: "plain_text", text: "My pending" } }];
  if (!link) {
    let url: string | null = null;
    try {
      url = linkUrl(await issueLinkToken({ installId: install.id, surfaceUserId }));
    } catch {
      url = null;
    }
    blocks.push(sec("Link your ContextNest account to review what Nest proposes. Linking doesn't approve anything."));
    if (url) blocks.push({ type: "actions", elements: [btn("Link my account", "home_link", "link", { url })] });
  } else {
    const mp = await myPending(link.community_user_id, { installId: install.id });
    blocks.push(ctx(mp.scope.length ? `From nests you can read and review: ${mp.scope.map((s) => esc(s.name)).join(", ")}` : "You don't review any nest Nest listens for yet."));
    if (mp.in_thread.length) {
      blocks.push(sec("*In threads*"));
      for (const r of mp.in_thread.slice(0, 10)) {
        blocks.push(
          sec(`${conv(r.conversation)} · *${esc(r.title)}*\nPosted ${r.posted_at ? dateLabel(r.posted_at, tz) : ""} · expires ${dateLabel(r.expires_at, tz)}`, {
            ...(r.permalink ? { accessory: btn("Open thread", ACTION.openThread, JSON.stringify({ p: r.proposal_id }), { url: r.permalink }) } : {}),
          }),
        );
      }
    }
    if (mp.held.length) {
      blocks.push(sec("*Not posted*"));
      for (const r of mp.held.slice(0, 5)) {
        const v = JSON.stringify({ p: r.proposal_id, src: "home" });
        blocks.push(
          sec(
            `Not posted: no ${esc(r.nest_name)} reviewer in ${conv(r.conversation)}\n*${esc(r.title)}*${r.summary ? `\n${esc(r.summary)}` : ""}\n📁 ${esc(r.folder)} · expires ${dateLabel(r.expires_at, tz)}`,
          ),
        );
        blocks.push({
          type: "actions",
          elements: [
            btn("Approve", ACTION.approve, v, { style: "primary" }),
            ...(r.can_edit ? [btn("Edit", ACTION.edit, v)] : []),
            btn("Reject", ACTION.reject, v),
            btn("Review in nest", ACTION.reviewInNest, v, { url: r.draft_url }),
          ],
        });
      }
    }
    if (mp.queued.length) {
      blocks.push(sec(`*Queued for you (${mp.queued.length}) · posting tomorrow at 9 AM*`));
      for (const r of mp.queued.slice(0, 5)) blocks.push(sec(`${conv(r.conversation)} · *${esc(r.title)}*`));
    }
    blocks.push(ctx(limitLine(mp.used_today, mp.daily_limit)));
    if (mp.admin_held) {
      blocks.push(sec("*Held for a reviewer (admin view)*"));
      if (!mp.admin_held.length) blocks.push(ctx("Nothing is held."));
      for (const h of mp.admin_held.slice(0, 5)) {
        // Reviewer names are Slack mentions we built (<@U…>); anything else is escaped.
        const who = h.reviewers.split(", ").map((x) => (/^<@[A-Z0-9_]+>$/.test(x) ? x : esc(x))).join(", ");
        blocks.push(ctx(`${esc(h.nest_name)} · ${conv(h.conversation)} · ${h.count} held · ${esc(h.title)} · reviewers: ${who}`));
      }
    }
    // Conversations this person is in where Nest listens: anyone may remove it (§12 R3).
    const convs = (await getDb().all(
      `SELECT b.id, b.conversation_name, b.conversation_kind FROM surface_bindings b JOIN surface_members_cache m ON m.binding_id = b.id
        WHERE b.install_id = ? AND m.surface_user_id = ? AND b.status = 'active' ORDER BY b.conversation_name`,
      [install.id, surfaceUserId],
    )) as Array<{ id: string; conversation_name: string | null; conversation_kind: string }>;
    if (convs.length) {
      blocks.push(sec("*Where Nest listens with you*"));
      for (const c of convs.slice(0, 20)) {
        blocks.push(
          sec(c.conversation_kind === "dm" ? "Our direct messages" : conv(c.conversation_name), {
            accessory: btn("Remove Nest", ACTION.boot, JSON.stringify({ b: c.id })),
          }),
        );
      }
    }
    // Conversations a member removed Nest from: any member may invite it back (Misha, 2026-11-01).
    const booted = (await getDb().all(
      `SELECT b.id, b.conversation_name FROM surface_bindings b JOIN surface_members_cache m ON m.binding_id = b.id
        WHERE b.install_id = ? AND m.surface_user_id = ? AND b.status = 'paused_by_member' AND b.pause_reason IS NULL ORDER BY b.conversation_name`,
      [install.id, surfaceUserId],
    )) as Array<{ id: string; conversation_name: string | null }>;
    if (booted.length) {
      blocks.push(sec("*Where a member removed Nest*"));
      for (const c of booted.slice(0, 10)) {
        blocks.push(sec(conv(c.conversation_name), { accessory: btn("Invite Nest back", ACTION.invite, JSON.stringify({ b: c.id })) }));
      }
    }
  }
  blocks.push({ type: "divider" });
  blocks.push(sec(optedOut ? "Nest doesn't use your messages." : "Nest may use your messages in conversations where it listens.", {
    accessory: btn(optedOut ? "Let Nest use my messages" : "Don't use my messages", ACTION.optout, optedOut ? "off" : "on"),
  }));
  if (settings.dm_capture) {
    blocks.push(sec(`${dmOff ? "DM capture is off for you." : "Nest keeps what you ask it to in our DMs."} ${PRIVATE_NEST_DISCLOSURE}`, {
      accessory: btn(dmOff ? "Turn my DM capture on" : "Turn my DM capture off", ACTION.dmCapture, dmOff ? "on" : "off"),
    }));
  }
  if (link) blocks.push({ type: "actions", elements: [btn("Unlink my account", ACTION.unlink, "unlink", { style: "danger" })] });
  return { type: "home", blocks: blocks.slice(0, 100) };
}

export async function publishHome(installId: string, surfaceUserId: string): Promise<void> {
  const install = await getInstall(installId);
  if (!install || install.status !== "active") return;
  const c = getConnector(install.surface);
  if (!c) return;
  const view = await buildHomeView(install, surfaceUserId);
  await c.publishPending(installRef(install), surfaceUserId, [view]);
}
