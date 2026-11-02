/**
 * Slack interactivity (PRD §4.12, AC-CMT-*, AC-HOM-*, §12 R2/R3):
 * block_actions, view_submission and the `/nest` slash command.
 *
 * The route has already verified the signature (constant time, 300 s replay
 * window) and the feature flag. Here:
 *  - every block action is acknowledged at once (empty 200) and handled in
 *    the background; results reach the clicker through `response_url`
 *    (ephemeral) and the card through `chat.update` (AC-CMT-12);
 *  - Edit / Reject open their dialog only after the full commit checks
 *    (AC-CMT-06), with the click's own trigger_id;
 *  - dialog submissions carry HMAC-signed private_metadata bound to the
 *    proposal, items, nest, folder, the opener and the workspace: anything
 *    else is refused with no state change (AC-CMT-07);
 *  - `response_url` is only ever a hooks.slack.com URL (SSRF fence).
 */
import { createHmac, timingSafeEqual } from "crypto";
import { config } from "../../../config.js";
import { getDb } from "../../../db/client.js";
import { track } from "../../services/work.js";
import type { InstallRow } from "../../services/install-store.js";
import { commit, authorizeDialog, editableItems, type Origin, type Responder } from "../../services/commit-service.js";
import { confirmFirstUse, activeLink, revokeLink } from "../../services/identity-service.js";
import { bootBinding, consentToReturn, getBindingRow, isOrgAdmin, type BindingRow } from "../../services/binding-service.js";
import { publishHome } from "../../services/home-service.js";
import { setPersonalDm } from "../../services/dm-service.js";
import { completePendingInvite, inviteBack } from "../../services/invite-service.js";
import { modalKey } from "../../services/window-guard-key.js";
import { getItems, getProposal, nestName } from "../../services/card-service.js";
import { PICKABLE_REASONS, type RejectReason } from "../../core/card-model.js";
import { COMMIT_VERBS, type CommitVerb } from "../../core/identity-rules.js";
import { ACTION, VIEW, renderBootModal, renderEditModal, renderRejectModal, validateView } from "./blockkit.js";
import { botToken } from "./connector.js";
import { slackCall } from "./api.js";

export interface HandlerResult {
  status: number;
  body: unknown | null;
}

const RESPONSE_URL = /^https:\/\/hooks\.slack\.com\/[A-Za-z0-9/_.-]+$/;

export async function respondTo(url: string | null | undefined, body: Record<string, unknown>): Promise<boolean> {
  if (!url || !RESPONSE_URL.test(url)) return false;
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function dm(install: InstallRow, user: string, text: string, blocks?: unknown[]): Promise<void> {
  try {
    const tk = await botToken(install.id);
    const ch = String((await slackCall("conversations.open", { users: user }, { token: tk })).channel?.id ?? "");
    if (ch) await slackCall("chat.postMessage", { channel: ch, text, ...(blocks ? { blocks: JSON.stringify(blocks) } : {}) }, { token: tk });
  } catch {
    /* best effort */
  }
}

function responder(install: InstallRow, p: Record<string, any>): Responder {
  const url = typeof p.response_url === "string" ? p.response_url : null;
  const channel = p.channel?.id ? String(p.channel.id) : null;
  const user = String(p.user?.id ?? "");
  return {
    async note(text, blocks) {
      const body = { response_type: "ephemeral", replace_original: false, text, ...(blocks ? { blocks } : {}) };
      if (await respondTo(url, body)) return;
      try {
        const tk = await botToken(install.id);
        if (channel) await slackCall("chat.postEphemeral", { channel, user, text, ...(blocks ? { blocks: JSON.stringify(blocks) } : {}) }, { token: tk });
        // App Home has no channel: the note (and any confirm buttons) go by DM.
        else await dm(install, user, text, blocks);
      } catch {
        /* best effort */
      }
    },
  };
}

function originOf(p: Record<string, any>): Origin {
  const home = p.container?.type === "view" || p.view?.type === "home";
  return {
    source: home ? "home" : "card",
    team_id: p.team?.id ? String(p.team.id) : (p.user?.team_id ? String(p.user.team_id) : null),
    enterprise_id: p.enterprise?.id ? String(p.enterprise.id) : null,
    channel_id: p.channel?.id ? String(p.channel.id) : p.container?.channel_id ? String(p.container.channel_id) : null,
    clicker_home_team: p.user?.team_id ? String(p.user.team_id) : null,
  };
}

// ─── signed modal metadata ───────────────────────────────────────────────────

interface Meta {
  k: "edit" | "reject" | "boot";
  p?: string;
  i?: string[];
  n?: string;
  f?: string;
  b?: string;
  u: string;
  t: string | null;
  v?: CommitVerb;
  /** Security L3: the identity link the dialog was authorised under. */
  l?: string;
  x: number;
}

export function signMeta(m: Meta): string | null {
  const key = modalKey();
  if (!key) return null;
  const body = Buffer.from(JSON.stringify(m)).toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

export function readMeta(raw: unknown): Meta | null {
  const key = modalKey();
  if (!key || typeof raw !== "string") return null;
  const [body, mac] = raw.split(".");
  if (!body || !mac) return null;
  const want = Buffer.from(createHmac("sha256", key).update(body).digest("base64url"));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const m = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Meta;
    if (typeof m.x !== "number" || m.x < Date.now()) return null;
    return m;
  } catch {
    return null;
  }
}

async function openView(install: InstallRow, triggerId: string, view: Record<string, any>): Promise<boolean> {
  if (validateView(view, "modal").length) return false;
  try {
    await slackCall("views.open", { trigger_id: triggerId, view: JSON.stringify(view) }, { token: await botToken(install.id) });
    return true;
  } catch {
    return false;
  }
}

// ─── block actions ───────────────────────────────────────────────────────────

const VERB_OF: Record<string, CommitVerb> = {
  [ACTION.approve]: "approve",
  [ACTION.approveSelected]: "approve_selected",
  [ACTION.updateRecord]: "update_record",
  [ACTION.keepRecord]: "keep_record",
  [ACTION.reject]: "reject",
  [ACTION.rejectAll]: "reject",
  [ACTION.edit]: "edit",
};

function parseValue(v: unknown): Record<string, any> {
  try {
    const o = typeof v === "string" ? JSON.parse(v) : null;
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function ticked(p: Record<string, any>): string[] | undefined {
  const vals = p.state?.values ?? {};
  for (const block of Object.values(vals) as Array<Record<string, any>>) {
    const sel = block?.[ACTION.select]?.selected_options;
    if (Array.isArray(sel)) return sel.map((o: any) => String(o.value));
  }
  return undefined;
}

/** Edit / Reject: checks first, then the dialog (AC-CMT-06). */
async function openDialog(install: InstallRow, p: Record<string, any>, verb: "edit" | "reject", proposalId: string, opts: { confirmed?: boolean; itemIds?: string[] } = {}): Promise<void> {
  const user = String(p.user?.id ?? "");
  const a = await authorizeDialog({
    installId: install.id,
    surfaceUserId: user,
    proposalId,
    verb,
    itemIds: opts.itemIds,
    origin: originOf(p),
    responder: responder(install, p),
    confirmed: opts.confirmed,
  });
  if (!a.ok) return;
  const meta = signMeta({
    k: verb,
    p: a.p.id,
    i: a.items.map((i) => i.id),
    n: a.p.nest_id,
    f: a.items[0]?.target_folder ?? "",
    u: user,
    t: originOf(p).team_id,
    v: verb,
    l: (await activeLink(install.id, user))?.id,
    x: Date.now() + 60 * 60_000,
  });
  if (!meta) {
    await responder(install, p).note("Editing isn't available on this server right now.");
    return;
  }
  const nest = await nestName(a.p.nest_id);
  const target = a.binding.conversation_kind === "dm" ? `${a.items[0]?.target_folder ?? ""} (your private nest)` : (a.items[0]?.target_folder ?? "");
  const view = verb === "edit" ? renderEditModal(await editableItems(a.items), meta, nest, target) : renderRejectModal(meta);
  await openView(install, String(p.trigger_id ?? ""), view);
}

async function generalRefusal(install: InstallRow): Promise<string> {
  const admins = (await getDb().all(
    "SELECT l.surface_user_id, l.community_user_id FROM surface_identity_links l WHERE l.install_id = ? AND l.status = 'active'",
    [install.id],
  )) as Array<{ surface_user_id: string; community_user_id: string }>;
  const names: string[] = [];
  for (const a of admins) if ((await isOrgAdmin(a.community_user_id)) && /^[A-Z0-9_]+$/.test(a.surface_user_id)) names.push(`<@${a.surface_user_id}>`);
  return names.length
    ? `This is a general channel, so only a workspace admin can remove Nest from it: ${names.join(", ")}.`
    : "This is a general channel, so only a workspace admin can remove Nest from it. Ask a workspace admin.";
}

async function clickerIsAdmin(install: InstallRow, user: string): Promise<boolean> {
  const l = await activeLink(install.id, user);
  return !!l && (await isOrgAdmin(l.community_user_id));
}

/** The boot dialog (§12 R3): general channels refuse non-admins up front (AC-BOOT-02). */
export async function startBoot(install: InstallRow, binding: BindingRow, user: string, triggerId: string, note: (t: string) => Promise<void>): Promise<void> {
  if (binding.status !== "active" && binding.status !== "paused_guard") {
    await note("Nest isn't listening in this conversation.");
    return;
  }
  if (binding.is_general && !(await clickerIsAdmin(install, user))) {
    await note(await generalRefusal(install));
    return;
  }
  const meta = signMeta({ k: "boot", b: binding.id, u: user, t: install.team_id, x: Date.now() + 30 * 60_000 });
  if (!meta || !(await openView(install, triggerId, renderBootModal(meta, binding.conversation_name)))) await note("Couldn't open the dialog. Try `/nest leave` again.");
}

async function onBlockAction(install: InstallRow, p: Record<string, any>): Promise<void> {
  const action = (p.actions?.[0] ?? {}) as Record<string, any>;
  const id = String(action.action_id ?? "");
  const user = String(p.user?.id ?? "");
  const v = parseValue(action.value);
  const r = responder(install, p);
  const origin = originOf(p);
  const home = origin.source === "home";
  const interactionId = `${p.trigger_id ?? ""}:${action.action_ts ?? ""}`;
  // The workspace must be this install's for every action, home included.
  if ((origin.team_id ?? null) !== (install.team_id ?? null) || (origin.enterprise_id ?? null) !== (install.enterprise_id ?? null)) {
    await r.note(`Only ${config.SURFACES_ORG_NAME || "this workspace's"} members can act on this.`);
    return;
  }
  const after = async () => {
    if (home) await publishHome(install.id, user).catch(() => {});
  };
  switch (id) {
    case ACTION.approve:
    case ACTION.approveSelected:
    case ACTION.updateRecord:
    case ACTION.keepRecord: {
      if (typeof v.p !== "string") return;
      await commit({ installId: install.id, surfaceUserId: user, proposalId: v.p, verb: VERB_OF[id], itemIds: id === ACTION.approveSelected ? (ticked(p) ?? []) : undefined, interactionId, origin, responder: r });
      return after();
    }
    case ACTION.reject:
    case ACTION.rejectAll:
    case ACTION.edit: {
      if (typeof v.p !== "string") return;
      return openDialog(install, p, VERB_OF[id] as "edit" | "reject", v.p);
    }
    case ACTION.confirmYes:
    case ACTION.confirmNo: {
      const verb = String(v.v ?? "");
      if (typeof v.l !== "string" || typeof v.p !== "string" || !(COMMIT_VERBS as readonly string[]).includes(verb)) return;
      // The link must be this clicker's own.
      const link = await activeLink(install.id, user);
      if (!link || link.id !== v.l) {
        await r.note("This confirmation isn't yours.");
        return;
      }
      const ans = await confirmFirstUse({ linkId: v.l, action: verb, answer: id === ACTION.confirmYes ? "yes" : "not_me" });
      if (ans.status === "revoked") {
        await r.note("Thanks. That link was removed and nothing was done. Your admins have been told.");
        return after();
      }
      // Continue the ORIGINAL action (N3).
      if (ans.action === "edit" || ans.action === "reject") return openDialog(install, p, ans.action, v.p, { confirmed: true, itemIds: Array.isArray(v.i) ? v.i : undefined });
      await commit({
        installId: install.id,
        surfaceUserId: user,
        proposalId: v.p,
        verb: ans.action,
        itemIds: Array.isArray(v.i) ? v.i.map(String) : undefined,
        reason: PICKABLE_REASONS.includes(v.r) ? v.r : null,
        interactionId,
        origin,
        responder: r,
        confirmed: true,
      });
      return after();
    }
    case ACTION.overflow: {
      const sel = parseValue(action.selected_option?.value);
      if (sel.a !== "boot" || typeof sel.p !== "string") return;
      const prop = await getProposal(sel.p);
      const b = prop ? await getBindingRow(prop.binding_id) : null;
      if (!b || b.install_id !== install.id || b.conversation_id !== origin.channel_id) {
        await r.note(`Only ${config.SURFACES_ORG_NAME || "this workspace's"} members can act on this.`);
        return;
      }
      return startBoot(install, b, user, String(p.trigger_id ?? ""), (t) => r.note(t));
    }
    case ACTION.boot: {
      const b = typeof v.b === "string" ? await getBindingRow(v.b) : null;
      if (!b || b.install_id !== install.id) return;
      return startBoot(install, b, user, String(p.trigger_id ?? ""), (t) => dm(install, user, t));
    }
    case ACTION.optout: {
      if (v === null) return;
      const on = action.value === "on";
      if (on) {
        await getDb().run("INSERT INTO surface_optouts (install_id, surface_user_id, created_at) VALUES (?, ?, ?) ON CONFLICT (install_id, surface_user_id) DO NOTHING", [
          install.id,
          user,
          new Date().toISOString(),
        ]);
        await getDb().run("DELETE FROM surface_buffer WHERE install_id = ? AND author_surface_user_id = ?", [install.id, user]);
      } else {
        await getDb().run("DELETE FROM surface_optouts WHERE install_id = ? AND surface_user_id = ?", [install.id, user]);
      }
      return after();
    }
    case ACTION.dmCapture: {
      await setPersonalDm(install, user, action.value === "on");
      return after();
    }
    case ACTION.unlink: {
      const l = await activeLink(install.id, user);
      if (l) await revokeLink({ linkId: l.id, byUserId: l.community_user_id, reason: "unlinked_from_home" });
      return after();
    }
    case ACTION.allowBack: {
      // Scoped to this install (INFO c): the binding must belong to it.
      const ab = typeof v.b === "string" ? await getBindingRow(v.b) : null;
      if (ab && ab.install_id === install.id) {
        const ok = await consentToReturn({ bindingId: v.b, surfaceUserId: user });
        if (!ok) {
          await r.note("Nothing to agree to here.");
          return;
        }
        // A member's invite was waiting on this consent: finish it.
        const done = await completePendingInvite(ab.id);
        await r.note(done ? done.message : "Thanks. An admin can now add Nest back.");
      }
      return;
    }
    case ACTION.invite: {
      const ib = typeof v.b === "string" ? await getBindingRow(v.b) : null;
      if (!ib || ib.install_id !== install.id) return;
      const out = await inviteBack({ bindingId: ib.id, inviterSurfaceUserId: user, isAdmin: await clickerIsAdmin(install, user) });
      await r.note(out.message);
      return after();
    }
    default:
      return; // selection changes, URL buttons: nothing to do
  }
}

// ─── view submissions ────────────────────────────────────────────────────────

function inputValue(values: Record<string, any>, blockId: string): string | null {
  const b = values?.[blockId]?.v;
  if (!b) return null;
  if (typeof b.value === "string") return b.value;
  return null;
}

async function onViewSubmission(install: InstallRow, p: Record<string, any>): Promise<HandlerResult> {
  const view = (p.view ?? {}) as Record<string, any>;
  const meta = readMeta(view.private_metadata);
  const user = String(p.user?.id ?? "");
  const team = p.team?.id ? String(p.team.id) : null;
  const refuse: HandlerResult = { status: 403, body: { error: "This dialog can't be used." } };
  if (!meta || meta.u !== user || (meta.t ?? null) !== (team ?? null) || (install.team_id ?? null) !== (team ?? null)) return refuse;
  const expected = view.callback_id === VIEW.edit ? "edit" : view.callback_id === VIEW.reject ? "reject" : view.callback_id === VIEW.boot ? "boot" : null;
  if (!expected || meta.k !== expected) return refuse;
  const values = (view.state?.values ?? {}) as Record<string, any>;
  if (meta.k === "boot") {
    const b = meta.b ? await getBindingRow(meta.b) : null;
    if (!b || b.install_id !== install.id) return refuse;
    const isAdmin = await clickerIsAdmin(install, user);
    track(
      (async () => {
        const out = await bootBinding({ bindingId: b.id, surfaceUserId: user, isAdmin });
        if (!out.ok) await dm(install, user, out.reason === "general_channel" ? await generalRefusal(install) : out.message);
      })(),
      "boot",
    );
    return { status: 200, body: { response_action: "clear" } };
  }
  // edit / reject: the signed items must still be this proposal's, in this nest and folder.
  const prop = meta.p ? await getProposal(meta.p) : null;
  if (!prop || prop.nest_id !== meta.n) return refuse;
  const items = await getItems(prop.id);
  const ids = new Set(items.map((i) => i.id));
  if (!meta.i?.length || meta.i.some((i) => !ids.has(i)) || items.filter((i) => meta.i!.includes(i.id)).some((i) => i.target_folder !== meta.f && meta.i!.length === 1)) return refuse;
  const binding = await getBindingRow(prop.binding_id);
  if (!binding || binding.install_id !== install.id) return refuse;
  const origin: Origin = { source: "card", team_id: team, enterprise_id: p.enterprise?.id ? String(p.enterprise.id) : null, channel_id: binding.conversation_id, clicker_home_team: p.user?.team_id ? String(p.user.team_id) : team };
  const r = responder(install, { ...p, channel: { id: binding.conversation_id } });
  const interactionId = `view:${view.id ?? ""}`;
  // L3: the dialog was authorised under link meta.l. If the clicker's link
  // changed since, the first-use confirm runs again (never skipped).
  const sameLink = !!meta.l && (await activeLink(install.id, user))?.id === meta.l;
  if (meta.k === "reject") {
    const sel = values?.reason?.v?.selected_option?.value;
    const reason: RejectReason | null = PICKABLE_REASONS.includes(sel) ? sel : null;
    track(commit({ installId: install.id, surfaceUserId: user, proposalId: prop.id, verb: "reject", reason, interactionId, origin, responder: r, confirmed: sameLink }), "reject");
    return { status: 200, body: { response_action: "clear" } };
  }
  const edits: Record<string, { title: string; summary: string; body: string }> = {};
  for (const id of meta.i) {
    if (meta.i.length > 1) {
      const keep = values?.[`keep:${id}`]?.v?.selected_options;
      if (!Array.isArray(keep) || !keep.length) continue;
    }
    edits[id] = {
      title: (inputValue(values, `title:${id}`) ?? "").trim(),
      summary: (inputValue(values, `summary:${id}`) ?? "").trim(),
      body: (inputValue(values, `body:${id}`) ?? "").trim(),
    };
  }
  // Validate synchronously (field errors must come back in the response),
  // then commit in the background.
  const dry = await commit({ installId: install.id, surfaceUserId: user, proposalId: prop.id, verb: "edit", itemIds: meta.i, edits, interactionId, origin, responder: r, confirmed: sameLink, dryRun: true, deadlineMs: Date.now() + 1500 });
  if (dry.status === "invalid") return { status: 200, body: { response_action: "errors", errors: dry.errors } };
  if (dry.status === "valid" || dry.status === "deferred") {
    // "deferred": validation didn't fit the 3 s window — the real run
    // validates fully and reports any problem through response_url.
    track(commit({ installId: install.id, surfaceUserId: user, proposalId: prop.id, verb: "edit", itemIds: meta.i, edits, interactionId, origin, responder: r, confirmed: sameLink }), "edit approve");
  }
  return { status: 200, body: { response_action: "clear" } };
}

/** Entry point from the route (signature already verified). */
export async function handleInteraction(install: InstallRow, raw: string): Promise<HandlerResult> {
  let p: Record<string, any>;
  try {
    p = JSON.parse(new URLSearchParams(raw).get("payload") ?? "");
  } catch {
    return { status: 400, body: { error: "bad request" } };
  }
  if (p.type === "block_actions") {
    track(onBlockAction(install, p), "slack action");
    return { status: 200, body: null };
  }
  if (p.type === "view_submission") return onViewSubmission(install, p);
  return { status: 200, body: null };
}

// ─── /nest slash command ─────────────────────────────────────────────────────

export async function handleCommand(install: InstallRow, raw: string): Promise<HandlerResult> {
  const f = new URLSearchParams(raw);
  const text = (f.get("text") ?? "").trim().toLowerCase();
  const user = f.get("user_id") ?? "";
  const channel = f.get("channel_id") ?? "";
  const team = f.get("team_id") ?? null;
  const say = (t: string): HandlerResult => ({ status: 200, body: { response_type: "ephemeral", text: t } });
  if ((install.team_id ?? null) !== team) return say(`Only ${config.SURFACES_ORG_NAME || "this workspace's"} members can act on this.`);
  if (text === "leave") {
    const b = (await getDb().get("SELECT * FROM surface_bindings WHERE install_id = ? AND conversation_id = ?", [install.id, channel])) as BindingRow | undefined;
    if (!b || (b.status !== "active" && b.status !== "paused_guard")) return say("Nest isn't listening in this conversation.");
    if (b.is_general && !(await clickerIsAdmin(install, user))) return say(await generalRefusal(install));
    const url = f.get("response_url");
    track(startBoot(install, b, user, f.get("trigger_id") ?? "", (t) => respondTo(url, { response_type: "ephemeral", text: t }).then(() => {})), "boot dialog");
    return { status: 200, body: null };
  }
  if (text === "invite") {
    // Misha, 2026-11-01: any member brings Nest back after a member removed it.
    const b = (await getDb().get("SELECT * FROM surface_bindings WHERE install_id = ? AND conversation_id = ?", [install.id, channel])) as BindingRow | undefined;
    if (!b) return say("Nest isn't set up for this conversation.");
    // Ack at once; the membership page-through, the guard re-check and any
    // consent DM run after the ack, answering through response_url.
    const url = f.get("response_url");
    track(
      (async () => {
        const out = await inviteBack({ bindingId: b.id, inviterSurfaceUserId: user, isAdmin: await clickerIsAdmin(install, user) });
        await respondTo(url, { response_type: "ephemeral", text: out.message });
      })(),
      "invite",
    );
    return { status: 200, body: null };
  }
  if (text === "dm off" || text === "dm on") {
    await setPersonalDm(install, user, text === "dm on");
    return say(text === "dm on" ? "Your DM capture is on again." : "Your DM capture is off. Anything Nest was holding from our DMs was deleted, and DM proposals waiting for you were withdrawn.");
  }
  return say("Try `/nest leave` (remove Nest from this conversation), `/nest invite` (bring it back after a member removed it), or `/nest dm off` / `/nest dm on`.");
}
