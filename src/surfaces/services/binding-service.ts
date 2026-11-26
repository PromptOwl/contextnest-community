/**
 * Conversation ↔ nest bindings (PRD M3, §4.10, §4.17; states per §12 R3).
 *
 * A binding is created only when the guard allows capture (`capture_ok`),
 * re-checked on every trigger, paused (never silently resumed) when capture
 * stops being safe, and can be booted by any member of a non-general
 * conversation. Server admins are excluded from the reader set and disclosed
 * on every binding (§12 R1).
 */
import { v4 as uuid } from "uuid";
import { DEFAULT_LISTENER_NAME, DEFAULT_MAX_ITEMS, DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_TURNS, DEFAULT_TIMEOUT_SECONDS, readJudgeTuning, starterFolders, type JudgeTuning } from "./judge-tuning.js";
import { hootieModel } from "../../shared/model-credential.js";
import { listenerName } from "../../metacognition/managed.js";
import { getAgent } from "../../metacognition/store.js";
import { getDb } from "../../db/client.js";
import { config } from "../../config.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { resolveNestPermission, permissionLevel, isServerAdminUserId } from "../../shared/access.js";
import type { ConversationKind, ConversationInfo, MembersResult } from "../contract.js";
import { computeGuard, isExcludedBot, SERVER_ADMIN_DISCLOSURE, type GuardResult, type MappedMember } from "../core/guard.js";
import { canBoot, canResume, nextStatusAfterGuard, type BindingStatus } from "../core/binding-state.js";
import { getConnector } from "../registry.js";
import { ORG_ID } from "../flags.js";
import { getInstall, homeTenant, installRef, type InstallRow } from "./install-store.js";
import { safeMembers } from "./members.js";
import { effectiveReaders } from "./readers.js";
import { evaluateAutoMatch, getProfile, resolveIdentity } from "./identity-service.js";
import { runPauseHooks, runSurfaceOkLostHooks, type PauseReason } from "./pause-hooks.js";
import { recordNotice } from "./notices.js";
import { logCaught } from "../log.js";

export { SERVER_ADMIN_DISCLOSURE };

export interface BindingRow {
  id: string;
  install_id: string;
  org_id: string;
  nest_id: string;
  conversation_id: string;
  conversation_kind: ConversationKind;
  conversation_name: string | null;
  is_general: number;
  dm_owner_user_id: string | null;
  listener_agent_node_id: string | null;
  explicit_public_bind: number;
  is_ext_shared: number;
  ext_capture_enabled: number;
  bound_by_user_id: string | null;
  status: BindingStatus;
  status_changed_at: string | null;
  /** Why a paused binding is paused when it isn't the guard: ADMIN_PAUSE, 'dm_off', 'dm_optout'. */
  pause_reason?: string | null;
  booted_by_surface_user_id: string | null;
  booted_at: string | null;
  boot_consent_at: string | null;
  capture_ok: number;
  surface_ok: number;
  members_known: number;
  guard_detail: string;
  guard_checked_at: string | null;
  guard_dirty: number;
  guard_dirty_epoch: number;
  version: number;
  readers_fingerprint: string | null;
  created_at: string;
  updated_at: string;
}

/** 409 carrying the guard's verdict (counts only). */
export class GuardRefusedError extends AppError {
  constructor(
    message: string,
    public guard: GuardResult,
  ) {
    super(409, message);
    this.name = "GuardRefusedError";
  }
}

/** 422: a setting that can never apply to this conversation. */
export class UnprocessableError extends AppError {
  constructor(message: string) {
    super(422, message);
    this.name = "UnprocessableError";
  }
}

export const DM_REFUSED = "Nest can't keep a private nest here yet. Ask your admin.";

/**
 * Commit-point hooks for deterministic interleaving tests (no sleeps). Inert
 * in production: nothing sets them outside tests.
 */
export const bindingTestHooks: {
  afterEvaluate?: (bindingId: string) => unknown;
  beforeResumeCommit?: (bindingId: string) => unknown;
  beforeBootCommit?: (bindingId: string) => unknown;
} = {};

/** A boot retries a lost compare-and-set at most this many times, then 409s. */
export const BOOT_CAS_ATTEMPTS = 5;

/** Uniform "not found" for conversations the caller may not inspect (M5). */
const CONVERSATION_NOT_FOUND = "Conversation not found.";

const nowIso = () => new Date().toISOString();

// ─── authorization ─────────────────────────────────────────────────────────

async function isServiceUser(userId: string): Promise<boolean> {
  const r = (await getDb().get("SELECT is_service FROM users WHERE id = ?", [userId])) as { is_service: number | null } | undefined;
  return !!r?.is_service;
}

export async function isOrgAdmin(userId: string): Promise<boolean> {
  if (config.AUTH_MODE === "open") return true;
  if (await isServiceUser(userId)) return false;
  return isServerAdminUserId(userId);
}

export async function canAdministerNest(nestId: string, userId: string): Promise<boolean> {
  if (config.AUTH_MODE === "open") return true;
  if (await isServiceUser(userId)) return false;
  return permissionLevel(await resolveNestPermission(nestId, userId)) >= permissionLevel("admin");
}

export async function assertNestAdmin(nestId: string, userId: string): Promise<void> {
  if (!(await canAdministerNest(nestId, userId))) {
    throw new ForbiddenError("Only an owner or admin of this nest can manage its conversation bindings.");
  }
}

// ─── evaluation ────────────────────────────────────────────────────────────

interface Evaluation {
  install: InstallRow;
  members: MembersResult;
  conversation: ConversationInfo | null;
  mapped: MappedMember[];
  guard: GuardResult;
  fingerprint: string;
  dmOwner: string | null;
  readers: Awaited<ReturnType<typeof effectiveReaders>>;
}

async function evaluate(input: {
  install: InstallRow;
  conversationId: string;
  nestId: string;
  explicitPublicBind: boolean;
  extCaptureEnabled: boolean;
  listenerAgentNodeId: string | null;
  /** The binding being evaluated ("new" while creating): its own and the
   *  nest's other server-tied listeners are exempt (readers.ts). */
  bindingId: string;
  fallbackKind: ConversationKind;
}): Promise<Evaluation> {
  const { install } = input;
  const members = await safeMembers(getConnector(install.surface), installRef(install), input.conversationId);
  const readers = await effectiveReaders(input.nestId, { listenerAgentNodeId: input.listenerAgentNodeId, bindingId: input.bindingId });
  const home = homeTenant(install);
  const guardInstall = { bot_user_id: install.bot_user_id, home_tenant: home };
  const mapped: MappedMember[] = [];
  let dmOwner: string | null = null;
  if (members.known) {
    for (const m of members.members) {
      if (isExcludedBot(m, guardInstall)) {
        mapped.push({ ...m, community_user_id: null });
        continue;
      }
      const external = m.is_external || (m.is_bot && m.home_tenant !== home);
      const user = m.is_guest || external || m.is_bot ? null : await resolveIdentity(install.id, m.surface_user_id);
      mapped.push({ ...m, community_user_id: user });
    }
    if (members.conversation.kind === "dm") {
      dmOwner = mapped.find((m) => !m.is_bot)?.community_user_id ?? null;
    }
  }
  const kind = members.known ? members.conversation.kind : input.fallbackKind;
  const guard = computeGuard({
    readers,
    serverAdmins: readers.serverAdmins,
    members: members.known ? { known: true, members: mapped, conversation: members.conversation } : { known: false },
    binding: {
      conversation_kind: kind,
      explicit_public_bind: input.explicitPublicBind,
      ext_capture_enabled: input.extCaptureEnabled,
      dm_owner_user_id: dmOwner,
    },
    install: guardInstall,
  });
  return {
    install,
    members,
    conversation: members.known ? members.conversation : null,
    mapped,
    guard,
    fingerprint: readers.fingerprint,
    dmOwner,
    readers,
  };
}

/** Settings that can never apply to this conversation → 422. */
function assertApplicable(conv: ConversationInfo | null, explicitPublicBind: boolean): void {
  if (!explicitPublicBind || !conv) return;
  if (conv.is_ext_shared) throw new UnprocessableError("An explicit public bind is never allowed on a channel shared with another organization.");
  if (conv.is_private || conv.kind === "dm") throw new UnprocessableError("An explicit public bind only applies to a public channel.");
}

async function installOrThrow(installId: string): Promise<InstallRow> {
  const install = await getInstall(installId);
  if (!install) throw new NotFoundError("Install not found");
  if (install.status !== "active") throw new ConflictError("That workspace install is not active.");
  return install;
}

async function writeMembersSnapshot(bindingId: string, ev: Evaluation): Promise<void> {
  const db = getDb();
  await db.run("DELETE FROM surface_members_cache WHERE binding_id = ?", [bindingId]);
  if (!ev.members.known) return;
  const now = nowIso();
  for (const m of ev.members.members) {
    await db.run(
      `INSERT INTO surface_members_cache (binding_id, surface_user_id, is_guest, is_external, is_bot, home_tenant, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [bindingId, m.surface_user_id, m.is_guest ? 1 : 0, m.is_external ? 1 : 0, m.is_bot ? 1 : 0, m.home_tenant, now],
    );
  }
}

// ─── views ─────────────────────────────────────────────────────────────────

export async function bindingView(row: BindingRow) {
  let bootedBy: string | null = null;
  if (row.booted_by_surface_user_id) {
    const p = (await getDb().get("SELECT display_name FROM surface_users_cache WHERE install_id = ? AND surface_user_id = ?", [
      row.install_id,
      row.booted_by_surface_user_id,
    ])) as { display_name: string | null } | undefined;
    bootedBy = p?.display_name ?? row.booted_by_surface_user_id;
  }
  let detail: unknown = {};
  try {
    detail = JSON.parse(row.guard_detail || "{}");
  } catch {
    detail = {};
  }
  const channel = row.conversation_kind === "dm" ? null : row.conversation_name;
  const listener = row.listener_agent_node_id ? await getAgent(row.nest_id, row.listener_agent_node_id) : null;
  return {
    id: row.id,
    install_id: row.install_id,
    nest_id: row.nest_id,
    conversation_id: row.conversation_id,
    conversation_kind: row.conversation_kind,
    conversation_name: row.conversation_name,
    is_general: !!row.is_general,
    dm_owner_user_id: row.dm_owner_user_id,
    listener_agent_node_id: row.listener_agent_node_id,
    judge: readJudgeTuning(listener?.config),
    listener_folders: starterFolders(listener?.config),
    listener_name: listener ? listenerName(listener.persona.name, channel, listener.node_id) : null,
    // What each unset setting means right now, so the dialog can show the values in use.
    judge_defaults: {
      name: (listener && listenerName(null, channel, listener.node_id)) ?? DEFAULT_LISTENER_NAME,
      avatar: null,
      folders: null,
      max_turns: DEFAULT_MAX_TURNS,
      max_items: DEFAULT_MAX_ITEMS,
      model: config.SURFACES_JUDGE_MODEL || hootieModel(),
      max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
      temperature: 0,
      timeout_seconds: DEFAULT_TIMEOUT_SECONDS,
    } satisfies JudgeTuning,
    explicit_public_bind: !!row.explicit_public_bind,
    is_ext_shared: !!row.is_ext_shared,
    ext_capture_enabled: !!row.ext_capture_enabled,
    status: row.status,
    /** po-1437: a nest admin paused it on purpose. A member's boot never carries a reason (AC-BOOT-03). */
    paused_by_admin: row.pause_reason === ADMIN_PAUSE,
    status_changed_at: row.status_changed_at,
    booted_by: bootedBy,
    booted_at: row.booted_at,
    capture_ok: !!row.capture_ok,
    surface_ok: !!row.surface_ok,
    members_known: !!row.members_known,
    guard_detail: detail,
    guard_checked_at: row.guard_checked_at,
    disclosure: SERVER_ADMIN_DISCLOSURE,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getBindingRow(id: string): Promise<BindingRow | null> {
  return ((await getDb().get("SELECT * FROM surface_bindings WHERE id = ?", [id])) as BindingRow | undefined) ?? null;
}

async function rowOrThrow(id: string): Promise<BindingRow> {
  const row = await getBindingRow(id);
  if (!row) throw new NotFoundError("Binding not found");
  return row;
}

// ─── public operations ─────────────────────────────────────────────────────

export interface BindInput {
  actorUserId: string;
  installId: string;
  conversationId: string;
  nestId: string;
  explicitPublicBind?: boolean;
  extCaptureEnabled?: boolean;
  /** po-1437: optional note for the binding's history ("started"). */
  reason?: string | null;
  /**
   * SERVER-SIDE ONLY: the listener agent Surfaces created for this binding
   * (S2/S3 call createBinding with it). Routes and MCP tools never pass it —
   * a client-supplied value is refused with 422 (security M3).
   */
  listenerAgentNodeId?: string | null;
}

/**
 * May this caller see anything about the conversation (M5)? Server admins
 * may. Otherwise a public channel is fine, and a private channel or DM only
 * when the caller maps to one of its current members. Anything else —
 * including a conversation whose members can't be read — is a uniform 404,
 * so the guard can't be used to probe conversations.
 */
async function assertMayInspect(actorUserId: string, ev: Evaluation): Promise<void> {
  if (await isOrgAdmin(actorUserId)) return;
  if (!ev.members.known || !ev.conversation) throw new NotFoundError(CONVERSATION_NOT_FOUND);
  if (!ev.conversation.is_private && ev.conversation.kind !== "dm") return;
  if (ev.mapped.some((m) => !m.is_bot && m.community_user_id === actorUserId)) return;
  throw new NotFoundError(CONVERSATION_NOT_FOUND);
}

/** Only server admins may make an explicit org-public bind (M4). */
async function assertMayPublicBind(actorUserId: string): Promise<void> {
  if (!(await isOrgAdmin(actorUserId))) {
    throw new ForbiddenError("Only a server administrator can bind a public channel to a nest some of whose readers aren't in it.");
  }
}

/** A server-side listener must be an agent configured on this nest (M3). */
async function assertListener(nestId: string, nodeId: string | null | undefined): Promise<void> {
  if (nodeId === undefined || nodeId === null) return;
  const row = await getDb().get("SELECT 1 AS hit FROM metacognition_agents WHERE nest_id = ? AND node_id = ?", [nestId, nodeId]);
  if (!row) throw new UnprocessableError("The listener must be an agent created for this binding on this nest.");
}

/** Dry-run the guard for (install, conversation, nest). */
export async function previewBinding(input: BindInput) {
  await assertNestAdmin(input.nestId, input.actorUserId);
  const install = await installOrThrow(input.installId);
  await assertListener(input.nestId, input.listenerAgentNodeId);
  const ev = await evaluate({
    install,
    conversationId: input.conversationId,
    nestId: input.nestId,
    explicitPublicBind: !!input.explicitPublicBind,
    extCaptureEnabled: !!input.extCaptureEnabled,
    listenerAgentNodeId: input.listenerAgentNodeId ?? null,
    bindingId: "new",
    fallbackKind: "private_channel",
  });
  await assertMayInspect(input.actorUserId, ev);
  assertApplicable(ev.conversation, !!input.explicitPublicBind);
  // §13 / AC-SEED-09: an unseeded nest proposes nowhere — say so and offer seeds.
  const { seedPreview } = await import("./seed-service.js");
  const seed = await seedPreview(input.nestId, input.actorUserId);
  return {
    no_seed: seed.no_seed,
    seeds: seed.seeds,
    would_bind: ev.guard.capture_ok,
    guard: ev.guard,
    conversation_kind: ev.conversation?.kind ?? null,
    is_ext_shared: ev.conversation?.is_ext_shared ?? null,
    ext_capture_enabled: !!input.extCaptureEnabled,
    disclosure: SERVER_ADMIN_DISCLOSURE,
    people: await previewPeople(input.nestId, ev),
  };
}

/**
 * Who blocks the pair and who in the conversation can't read the nest, by
 * name (po-1432). Preview only: its caller already sees the nest's readers
 * (nest admin) and the conversation (assertMayInspect). Never stored.
 */
const PEOPLE_CAP = 20;

async function previewPeople(nestId: string, ev: Evaluation) {
  const db = getDb();
  const { readers, install } = ev;
  const nest = (await db.get("SELECT visibility FROM nests WHERE id = ?", [nestId])) as { visibility: string } | undefined;
  const universe_cause = !readers.universe ? null : nest?.visibility === "public" ? "public" : nest?.visibility === "org" ? "shared_deployment" : "link";
  if (!ev.members.known) return { absent_readers: [], members_not_readers: [], universe_cause };

  const people = ev.mapped.filter((m) => !m.is_bot && !m.is_guest && !m.is_external);
  const present = new Set(people.map((m) => m.community_user_id).filter(Boolean));
  // At most PEOPLE_CAP names per list; guard.detail keeps the full counts.
  const absentIds = readers.users.filter((u) => !present.has(u)).slice(0, PEOPLE_CAP);
  // Other apps' bots in this workspace count against surface_ok too, so name them (they can't be added).
  const home = homeTenant(install);
  const bots = ev.mapped.filter((m) => m.is_bot && !m.is_external && m.home_tenant === home && m.surface_user_id !== install.bot_user_id);
  const outsiders = [
    ...people.filter((m) => !m.community_user_id || (!readers.users.includes(m.community_user_id) && !readers.serverAdmins.includes(m.community_user_id))),
    ...bots,
  ].slice(0, PEOPLE_CAP);
  const ids = [...absentIds, ...outsiders.map((m) => m.community_user_id)].filter((u): u is string => !!u && !u.includes(":"));
  const users = new Map(
    (ids.length
      ? ((await db.all(`SELECT id, name, email FROM users WHERE id IN (${ids.map(() => "?").join(",")})`, ids)) as Array<{ id: string; name: string | null; email: string }>)
      : []
    ).map((u) => [u.id, u]),
  );

  const members_not_readers = [];
  for (const m of outsiders) {
    const u = m.community_user_id ? users.get(m.community_user_id) : undefined;
    const profile = u?.name
      ? null
      : await getProfile(install.id, m.surface_user_id).catch((err) => {
          logCaught("guard", err, { install: install.id, call: "profile" }, "warn");
          return null;
        });
    const name = u?.name ?? profile?.display_name ?? null;
    // po-1445: the email Slack has for someone with no account match, so the
    // admin can spot a mismatch. Only a confirmed one; preview only, never stored.
    const slack_email = !u && profile?.email_confirmed ? (profile.email ?? null) : null;
    members_not_readers.push({ surface_user_id: m.surface_user_id, name, community_user_id: m.community_user_id, email: u?.email ?? null, slack_email, is_bot: m.is_bot });
  }
  // po-1467: an unmatched member whose confirmed Slack email is a reader's is in
  // the channel; the identity rules refused the link. Say why, not "not in channel".
  const sameEmail = new Map(
    members_not_readers.filter((m) => !m.community_user_id && m.slack_email).map((m) => [m.slack_email!.trim().toLowerCase(), m.surface_user_id]),
  );

  const absent_readers = [];
  for (const id of absentIds) {
    if (id.includes(":")) {
      // team:<id>:<email> / email:<email> — a reader with no account here.
      const email = id.split(":").pop()!;
      if (email.includes("@")) absent_readers.push({ user_id: null, name: null, email, reason: "no_account" as const });
      continue;
    }
    const u = users.get(id);
    const member = u?.email ? sameEmail.get(u.email.trim().toLowerCase()) : undefined;
    if (member) {
      const v = await evaluateAutoMatch(install.id, member);
      absent_readers.push({ user_id: id, name: u?.name ?? null, email: u?.email ?? null, reason: "not_linked" as const, match_reason: v.ok ? null : v.reason });
      continue;
    }
    const known = await db.get(
      `SELECT 1 AS hit FROM surface_identity_links WHERE install_id = ? AND community_user_id = ? AND status = 'active'
       UNION SELECT 1 AS hit FROM surface_users_cache WHERE install_id = ? AND LOWER(email) = LOWER(?) AND deleted = 0`,
      [install.id, id, install.id, u?.email ?? ""],
    );
    absent_readers.push({ user_id: id, name: u?.name ?? null, email: u?.email ?? null, reason: known ? ("not_in_channel" as const) : ("no_slack_link" as const) });
  }
  return { absent_readers, members_not_readers, universe_cause };
}

/** Create (or re-create a removed) binding. Refused (409) unless capture_ok. */
export async function createBinding(input: BindInput) {
  await assertNestAdmin(input.nestId, input.actorUserId);
  const install = await installOrThrow(input.installId);
  await assertListener(input.nestId, input.listenerAgentNodeId);
  const explicitPublicBind = !!input.explicitPublicBind;
  const extCaptureEnabled = !!input.extCaptureEnabled;
  const ev = await evaluate({
    install,
    conversationId: input.conversationId,
    nestId: input.nestId,
    explicitPublicBind,
    extCaptureEnabled,
    listenerAgentNodeId: input.listenerAgentNodeId ?? null,
    bindingId: "new",
    fallbackKind: "private_channel",
  });
  await assertMayInspect(input.actorUserId, ev);
  assertApplicable(ev.conversation, explicitPublicBind);
  if (explicitPublicBind) await assertMayPublicBind(input.actorUserId);
  if (!ev.guard.capture_ok) {
    const dm = ev.conversation?.kind === "dm";
    throw new GuardRefusedError(
      dm ? DM_REFUSED : !ev.guard.members_known ? "The conversation's members couldn't be read, so it can't be bound." : "This nest is readable by people or systems outside this conversation.",
      ev.guard,
    );
  }
  const conv = ev.conversation!;
  const db = getDb();
  const existing = (await db.get("SELECT * FROM surface_bindings WHERE install_id = ? AND conversation_id = ?", [install.id, input.conversationId])) as
    | BindingRow
    | undefined;
  if (existing && existing.status !== "removed") {
    throw new ConflictError(
      existing.status === "paused_by_member"
        ? "A member removed Nest from this conversation. Re-bind it with resume once they agree or have left."
        : "This conversation is already bound.",
    );
  }
  const now = nowIso();
  const values = [
    input.nestId,
    conv.kind,
    conv.name ?? null,
    conv.is_general ? 1 : 0,
    ev.dmOwner,
    input.listenerAgentNodeId ?? null,
    explicitPublicBind ? 1 : 0,
    conv.is_ext_shared ? 1 : 0,
    extCaptureEnabled ? 1 : 0,
    input.actorUserId,
    ev.guard.capture_ok ? 1 : 0,
    ev.guard.surface_ok ? 1 : 0,
    ev.guard.members_known ? 1 : 0,
    JSON.stringify(ev.guard.detail),
    now,
    ev.fingerprint,
    now,
  ];
  // The row is written DIRTY (N2): an invalidation that arrived while we
  // evaluated matched no live row, so the next tick must re-check it.
  let id: string;
  if (existing) {
    id = existing.id;
    // CAS: only a still-removed row at the version we read is re-created.
    const r = await db.run(
      `UPDATE surface_bindings SET nest_id = ?, conversation_kind = ?, conversation_name = ?, is_general = ?, dm_owner_user_id = ?,
         listener_agent_node_id = ?, explicit_public_bind = ?, is_ext_shared = ?, ext_capture_enabled = ?, bound_by_user_id = ?,
         capture_ok = ?, surface_ok = ?, members_known = ?, guard_detail = ?, guard_checked_at = ?, readers_fingerprint = ?, updated_at = ?,
         status = 'active', status_changed_at = ?, guard_dirty = 1, guard_dirty_epoch = guard_dirty_epoch + 1, guard_dirty_at = ?, version = version + 1,
         booted_by_surface_user_id = NULL, booted_at = NULL, boot_consent_at = NULL
       WHERE id = ? AND status = 'removed' AND version = ?`,
      [...values, now, now, id, existing.version],
    );
    if (r.changes === 0) throw new ConflictError("This binding changed while it was being re-created. Try again.");
  } else {
    id = uuid();
    try {
      await db.run(
        `INSERT INTO surface_bindings (nest_id, conversation_kind, conversation_name, is_general, dm_owner_user_id, listener_agent_node_id,
           explicit_public_bind, is_ext_shared, ext_capture_enabled, bound_by_user_id, capture_ok, surface_ok, members_known, guard_detail,
           guard_checked_at, readers_fingerprint, updated_at, id, install_id, org_id, conversation_id, status, status_changed_at, created_at,
           guard_dirty, guard_dirty_epoch, guard_dirty_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1, 1, ?)`,
        [...values, id, install.id, ORG_ID, input.conversationId, now, now, now],
      );
    } catch (err) {
      // Usually the unique index (already bound); the line says if it was not.
      logCaught("guard", err, { install: install.id, call: "insert_binding" }, "warn");
      throw new ConflictError("This conversation is already bound.");
    }
  }
  await writeMembersSnapshot(id, ev);
  const row = await rowOrThrow(id);
  await recordBindingHistory(row, "started", input.reason?.trim().slice(0, 500) || null, input.actorUserId);
  return { binding: await bindingView(row), guard: ev.guard, disclosure: SERVER_ADMIN_DISCLOSURE };
}

async function pause(row: BindingRow, to: BindingStatus, reason: PauseReason, extra: Record<string, unknown> = {}): Promise<void> {
  // po-1437: pauses nobody chose still go on the binding's history, as Nest.
  if (reason === "guard") {
    await recordBindingHistory(row, "paused", "Paused by Nest: someone who can read the nest isn't in the channel, or the channel's members couldn't be checked.", null);
  } else if (reason === "member_boot") {
    await recordBindingHistory(row, "paused", "Paused by Nest: a channel member removed Nest from the channel.", null);
  }
  await runPauseHooks({ id: row.id, install_id: row.install_id, nest_id: row.nest_id, conversation_id: row.conversation_id }, reason);
  if (reason === "guard") {
    let detail: Record<string, unknown> = {};
    if (extra.recheck_failed) {
      detail = { recheck_failed: true };
    } else {
      try {
        detail = JSON.parse(row.guard_detail || "{}");
      } catch {
        detail = {};
      }
    }
    await recordNotice({
      kind: "binding_paused",
      audience: "admins",
      bindingId: row.id,
      nestId: row.nest_id,
      detail: { ...detail, to },
      subject: "Nest paused capture in a conversation",
      text: extra.recheck_failed
        ? "Capture was paused in a bound conversation because its safety re-check failed. Open Surfaces to review and resume it once the re-check passes."
        : `Capture was paused in a bound conversation because the nest's readers and the conversation's members no longer match (${Number(
            detail.readers_absent ?? 0,
          )} reader(s) absent, ${Number(detail.members_not_readers ?? 0)} member(s) who can't read the nest). Open Surfaces to review and resume it.`,
    });
  } else if (reason === "member_boot") {
    await recordNotice({
      kind: "binding_booted",
      audience: "admins",
      bindingId: row.id,
      nestId: row.nest_id,
      detail: { ...extra },
      subject: "A member removed Nest from a conversation",
      text: "A member of a bound conversation removed Nest from it. Capture stopped. See who and when on the Surfaces page.",
    });
  }
}

/**
 * A re-check that throws fails closed (M1): an active binding moves to
 * paused_guard (CAS), both flags drop, hooks purge and withdraw, and admins
 * get a counts-only alert. guard_dirty is left set, so the next tick retries.
 */
export async function failClosedBinding(id: string): Promise<void> {
  const row = await getBindingRow(id);
  if (row) await failClosed(row);
}

async function failClosed(row: BindingRow): Promise<void> {
  const now = nowIso();
  const moved = await getDb().run(
    `UPDATE surface_bindings SET status = 'paused_guard', status_changed_at = ?, capture_ok = 0, surface_ok = 0, version = version + 1, updated_at = ?
     WHERE id = ? AND status = 'active'`,
    [now, now, row.id],
  );
  await getDb().run(
    "UPDATE surface_bindings SET capture_ok = 0, surface_ok = 0, updated_at = ? WHERE id = ? AND status <> 'removed'",
    [now, row.id],
  );
  if (row.surface_ok) await runSurfaceOkLostHooks({ id: row.id, install_id: row.install_id, nest_id: row.nest_id, conversation_id: row.conversation_id });
  if (moved.changes > 0) await pause(row, "paused_guard", "guard", { recheck_failed: true });
}

/**
 * Re-run the guard for one binding and apply the §4.17 transition table.
 *
 * Every write is a compare-and-set on (status, version) read at the start,
 * so nothing that happened during the (slow, networked) evaluation can be
 * overwritten: a removal, a boot, a resume or a settings change wins, and
 * this re-check's result is dropped (H1). The re-check never writes
 * `active` over anything else — it can only keep the status or pause.
 * guard_dirty is cleared only if no invalidation arrived since the re-check
 * started (dirty epoch, H2). A throw fails closed (M1).
 */
export async function recheckBinding(id: string): Promise<BindingRow> {
  const row = await rowOrThrow(id);
  const now = nowIso();
  if (row.status === "removed") {
    await getDb().run("UPDATE surface_bindings SET guard_dirty = 0 WHERE id = ? AND status = 'removed' AND guard_dirty_epoch = ?", [
      id,
      row.guard_dirty_epoch,
    ]);
    return rowOrThrow(id);
  }
  let ev: Evaluation;
  let install: InstallRow | null;
  try {
    install = await getInstall(row.install_id);
    if (!install || install.status !== "active") {
      await markRemoved(row);
      return rowOrThrow(id);
    }
    ev = await evaluate({
      install,
      conversationId: row.conversation_id,
      nestId: row.nest_id,
      explicitPublicBind: !!row.explicit_public_bind,
      extCaptureEnabled: !!row.ext_capture_enabled,
      listenerAgentNodeId: row.listener_agent_node_id,
      bindingId: row.id,
      fallbackKind: row.conversation_kind,
    });
    await bindingTestHooks.afterEvaluate?.(id);
  } catch (err) {
    logCaught("guard", err, { binding: id, call: "recheck" }); // failing closed
    await failClosed(row);
    return rowOrThrow(id);
  }
  const next = nextStatusAfterGuard(row.status, ev.guard.capture_ok);
  const conv = ev.conversation;
  const res = await getDb().run(
    `UPDATE surface_bindings SET capture_ok = ?, surface_ok = ?, members_known = ?, guard_detail = ?, guard_checked_at = ?,
       guard_dirty = CASE WHEN guard_dirty_epoch = ? THEN 0 ELSE guard_dirty END,
       readers_fingerprint = ?, is_ext_shared = ?, is_general = ?, conversation_name = COALESCE(?, conversation_name),
       dm_owner_user_id = CASE WHEN conversation_kind = 'dm' THEN ? ELSE dm_owner_user_id END,
       status = ?, status_changed_at = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND status = ? AND version = ?`,
    [
      ev.guard.capture_ok ? 1 : 0,
      ev.guard.surface_ok ? 1 : 0,
      ev.guard.members_known ? 1 : 0,
      JSON.stringify(ev.guard.detail),
      now,
      row.guard_dirty_epoch,
      ev.fingerprint,
      conv ? (conv.is_ext_shared ? 1 : 0) : row.is_ext_shared,
      conv ? (conv.is_general ? 1 : 0) : row.is_general,
      conv?.name ?? null,
      ev.dmOwner,
      next.status,
      next.status !== row.status ? now : row.status_changed_at,
      now,
      id,
      row.status,
      row.version,
    ],
  );
  if (res.changes === 0) {
    // Something changed the binding while we evaluated: drop this result.
    // Its guard_dirty (if set) stays set, so the next tick re-checks.
    return rowOrThrow(id);
  }
  await writeMembersSnapshot(id, ev);
  const updated = await rowOrThrow(id);
  // §4.17 / security M1: when surface_ok drops, every posted card is put on
  // the retrying redaction path FIRST — paused or not — so a failed Slack
  // update can't leave nest or model text behind.
  if (row.surface_ok && !ev.guard.surface_ok) {
    await runSurfaceOkLostHooks({ id: row.id, install_id: row.install_id, nest_id: row.nest_id, conversation_id: row.conversation_id });
  }
  if (next.paused) await pause(updated, next.status, "guard");
  return updated;
}

/** Admin Resume (paused_guard) or re-bind after a boot (paused_by_member). */
export async function resumeBinding(id: string, actorUserId: string, reason: string) {
  const row = await rowOrThrow(id);
  await assertNestAdmin(row.nest_id, actorUserId);
  const fresh = await recheckBinding(id);
  const install = await getInstall(row.install_id);
  let bootingMemberPresent = true; // unknown membership: assume present (fail closed)
  if (fresh.booted_by_surface_user_id && install) {
    const m = await safeMembers(getConnector(install.surface), installRef(install), row.conversation_id);
    if (m.known) bootingMemberPresent = m.members.some((x) => x.surface_user_id === fresh.booted_by_surface_user_id);
  }
  const verdict = canResume({
    status: fresh.status,
    captureOk: !!fresh.capture_ok,
    bootedBy: fresh.booted_by_surface_user_id,
    bootConsent: !!fresh.boot_consent_at,
    bootingMemberPresent,
  });
  if (!verdict.ok) {
    const msg =
      verdict.reason === "booting_member_present"
        ? "The member who removed Nest is still in the conversation and hasn't agreed to let it back."
        : verdict.reason === "guard_failed"
          ? "The guard still fails for this conversation, so it can't resume."
          : "This binding isn't paused.";
    throw new ConflictError(msg);
  }
  await bindingTestHooks.beforeResumeCommit?.(id);
  const now = nowIso();
  // CAS from exactly what was checked: same status, same version, guard
  // passing and no pending invalidation. Anything newer wins (H1).
  const r = await getDb().run(
    `UPDATE surface_bindings SET status = 'active', status_changed_at = ?, booted_by_surface_user_id = NULL, booted_at = NULL,
       boot_consent_at = NULL, pause_reason = CASE WHEN pause_reason = '${ADMIN_PAUSE}' THEN NULL ELSE pause_reason END, version = version + 1, updated_at = ?
     WHERE id = ? AND status = ? AND version = ? AND capture_ok = 1 AND guard_dirty = 0`,
    [now, now, id, fresh.status, fresh.version],
  );
  if (r.changes === 0) throw new ConflictError("The binding changed while it was being resumed. Re-check it and try again.");
  await recordBindingHistory(row, "resumed", reason, actorUserId);
  return { binding: await bindingView(await rowOrThrow(id)) };
}

export type BootResult =
  | { ok: true; binding_id: string; status: "paused_by_member"; booted_at: string }
  | { ok: false; reason: "general_channel" | "not_member" | "not_bound"; message: string };

const BOOT_REFUSALS: Record<"general_channel" | "not_member" | "not_bound", string> = {
  general_channel: "This is a general channel. A workspace admin can remove it.",
  not_member: "Only a member of this conversation can remove Nest from it.",
  not_bound: "Nest isn't capturing in this conversation.",
};

/**
 * A conversation member removes Nest from it (§12 R3, model + transition).
 * Capture stops, hooks purge the buffer and withdraw pending cards, and the
 * binding becomes paused_by_member. Idempotent: a second boot returns the
 * same result. General channels: admins only — the refusal names nobody
 * (L1). The surface adapter (S2b) verifies the interaction and supplies
 * `isAdmin` for the clicker.
 */
export async function bootBinding(
  input: { bindingId: string; surfaceUserId: string; isAdmin?: boolean },
  attempt = 1,
): Promise<BootResult> {
  const row = await rowOrThrow(input.bindingId);
  const install = await getInstall(row.install_id);
  let isMember = true; // membership unreadable: let the privacy action through
  if (install) {
    const m = await safeMembers(getConnector(install.surface), installRef(install), row.conversation_id);
    if (m.known) isMember = m.members.some((x) => x.surface_user_id === input.surfaceUserId);
  }
  const current = await rowOrThrow(row.id);
  const verdict = canBoot({ status: current.status, isGeneral: !!current.is_general, isAdmin: !!input.isAdmin, isMember });
  if (!verdict.ok) return { ok: false, reason: verdict.reason, message: BOOT_REFUSALS[verdict.reason] };
  if (!verdict.noop) {
    await bindingTestHooks.beforeBootCommit?.(current.id);
    const now = nowIso();
    const claimed = await getDb().run(
      `UPDATE surface_bindings SET status = 'paused_by_member', status_changed_at = ?, booted_by_surface_user_id = ?, booted_at = ?,
         boot_consent_at = NULL, pause_reason = NULL, version = version + 1, updated_at = ? WHERE id = ? AND status = ? AND version = ?`,
      [now, input.surfaceUserId, now, now, current.id, current.status, current.version],
    );
    if (claimed.changes === 0) {
      // Lost a race: re-evaluate against what is there now, a bounded number of times.
      if (attempt >= BOOT_CAS_ATTEMPTS) throw new ConflictError("The binding kept changing while Nest was being removed. Try again.");
      return bootBinding(input, attempt + 1);
    }
    await pause(current, "paused_by_member", "member_boot", { booted_at: now });
  }
  const after = await rowOrThrow(row.id);
  return { ok: true, binding_id: after.id, status: "paused_by_member", booted_at: after.booted_at! };
}

/** The booting member's one-tap "Allow Nest back" (§12 AC-BOOT-04). */
export async function consentToReturn(input: { bindingId: string; surfaceUserId: string }): Promise<boolean> {
  const r = await getDb().run(
    `UPDATE surface_bindings SET boot_consent_at = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND status = 'paused_by_member' AND booted_by_surface_user_id = ?`,
    [nowIso(), nowIso(), input.bindingId, input.surfaceUserId],
  );
  return r.changes > 0;
}

/** Admin unbind → removed (hooks purge + withdraw). */
/** po-1437: pause_reason of a pause a nest admin chose. */
export const ADMIN_PAUSE = "admin";

export type HistoryAction = "started" | "paused" | "resumed" | "removed" | "moved";

/** For a caller with no reason field (the MCP tools): the history still says who and when. */
export const NO_REASON_MCP = "(via MCP, no reason given)";

/** po-1437: a person's reason for pausing, resuming, moving or removing: required, 3–500 characters. */
export function requireReason(reason: unknown): string {
  const r = typeof reason === "string" ? reason.trim() : "";
  if (r.length < 3) throw new UnprocessableError("Say why, so the rest of the team knows (at least 3 characters).");
  return r.slice(0, 500);
}

/** One history row: the actual person (id + their email now), or Nest itself when actorUserId is null. */
export async function recordBindingHistory(
  row: Pick<BindingRow, "id" | "nest_id">,
  action: HistoryAction,
  reason: string | null,
  actorUserId: string | null,
): Promise<void> {
  const db = getDb();
  const actor = actorUserId ? ((await db.get("SELECT email FROM users WHERE id = ?", [actorUserId])) as { email: string } | undefined) : undefined;
  await db.run(
    "INSERT INTO surface_binding_history (id, binding_id, nest_id, action, reason, actor_user_id, actor_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [uuid(), row.id, row.nest_id, action, reason, actorUserId, actor?.email ?? null, nowIso()],
  );
}

export const ACTIVITY_DAYS = 7;
const FAILED_VERDICTS = new Set(["error", "error_schema", "budget_exhausted"]);

/**
 * po-1446: what Nest did in one channel over the last ACTIVITY_DAYS days, so
 * an admin can answer "why no card?". Counts only, from tables that already
 * exist (counters, windows, proposals): never text, names or Slack ids.
 */
export async function bindingActivity(id: string, actorUserId: string) {
  const row = await rowOrThrow(id);
  await assertNestAdmin(row.nest_id, actorUserId);
  const db = getDb();
  // One boundary for all three sources: the start of the UTC day ACTIVITY_DAYS - 1 days ago
  // (counters are kept per UTC day, so threads and cards use the same edge).
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (ACTIVITY_DAYS - 1));
  const since = start.toISOString();
  const counters = (await db.all("SELECT metric, SUM(value) AS n FROM surface_counters WHERE binding_id = ? AND day >= ? GROUP BY metric", [
    id,
    since.slice(0, 10),
  ])) as Array<{ metric: string; n: number | string }>;
  let buffered = 0;
  const skipped: Record<string, number> = {};
  for (const c of counters) {
    if (c.metric === "buffered") buffered += Number(c.n);
    else if (c.metric.startsWith("drop_")) skipped[c.metric.slice(5)] = Number(c.n);
  }
  const windows = (await db.all(
    `SELECT status, verdict, COUNT(*) AS n FROM surface_windows
      WHERE binding_id = ? AND (status <> 'judged' OR judged_at >= ?) AND status <> 'discarded' GROUP BY status, verdict`,
    [id, since],
  )) as Array<{ status: string; verdict: string | null; n: number | string }>;
  const judged = { proposed: 0, nothing_kept: 0, failed: 0 };
  let waiting = 0;
  for (const w of windows) {
    const n = Number(w.n);
    if (w.status !== "judged") waiting += n;
    else if (w.verdict === "propose") judged.proposed += n;
    else if (w.verdict && FAILED_VERDICTS.has(w.verdict)) judged.failed += n;
    else judged.nothing_kept += n;
  }
  const cards = { posted: 0, queued: 0, held: 0 };
  for (const p of (await db.all(
    "SELECT state, CASE WHEN posted_at IS NULL THEN 0 ELSE 1 END AS was_posted, COUNT(*) AS n FROM surface_proposals WHERE binding_id = ? AND created_at >= ? GROUP BY state, was_posted",
    [id, since],
  )) as Array<{ state: string; was_posted: number | string; n: number | string }>) {
    if (Number(p.was_posted)) cards.posted += Number(p.n);
    else if (p.state === "queued" || p.state === "held") cards[p.state] += Number(p.n);
  }
  const dropped = Object.values(skipped).reduce((a, b) => a + b, 0);
  return { days: ACTIVITY_DAYS, since, received: buffered + dropped, buffered, skipped, waiting, judged, cards };
}

/** Newest first, with the person's current name when they still have an account. */
export async function bindingHistory(id: string, actorUserId: string) {
  const row = await rowOrThrow(id);
  await assertNestAdmin(row.nest_id, actorUserId);
  const rows = (await getDb().all(
    `SELECT h.action, h.reason, h.actor_user_id, h.actor_email, h.created_at, u.name AS actor_name
       FROM surface_binding_history h LEFT JOIN users u ON u.id = h.actor_user_id
      WHERE h.binding_id = ? AND h.nest_id = ? ORDER BY h.created_at DESC, h.id DESC LIMIT 200`,
    // A moved channel reuses its binding row: the new nest's admins see only that nest's history.
    [id, row.nest_id],
  )) as Array<{ action: string; reason: string | null; actor_user_id: string | null; actor_email: string | null; created_at: string; actor_name: string | null }>;
  return {
    history: rows.map((h) => ({
      action: h.action,
      reason: h.reason,
      at: h.created_at,
      by: h.actor_user_id ? { user_id: h.actor_user_id, email: h.actor_email, name: h.actor_name } : null,
    })),
  };
}

/**
 * po-1437: a nest admin pauses listening on purpose. Same state the guard uses
 * (paused_guard), told apart by pause_reason 'admin', so ingest stops and only
 * an admin Resume (which re-runs the guard) brings it back. Buffer purged and
 * pending cards withdrawn by the pause hooks, as for any pause.
 */
export async function pauseBinding(id: string, actorUserId: string, reason: string) {
  const row = await rowOrThrow(id);
  await assertNestAdmin(row.nest_id, actorUserId);
  if (row.status !== "active") throw new ConflictError("Only a binding that is listening can be paused.");
  const now = nowIso();
  const r = await getDb().run(
    `UPDATE surface_bindings SET status = 'paused_guard', pause_reason = '${ADMIN_PAUSE}', status_changed_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND status = 'active' AND version = ?`,
    [now, now, id, row.version],
  );
  if (r.changes === 0) throw new ConflictError("The binding changed while it was being paused. Try again.");
  await recordBindingHistory(row, "paused", reason, actorUserId);
  await pause(row, "paused_guard", "admin");
  return { binding: await bindingView(await rowOrThrow(id)) };
}

/** `moved_to`: the nest name the channel is moving to (recorded as "moved", not "removed"). */
/** movedToNestId: the nest the channel moves to. Its name is looked up here, never taken from the client, and only for a nest the caller administers. */
export async function removeBinding(id: string, actorUserId: string, reason: string, movedToNestId?: string | null) {
  const row = await rowOrThrow(id);
  await assertNestAdmin(row.nest_id, actorUserId);
  // A double click, a retry or a stale Move must not add a second "stopped" row to the history.
  if (row.status === "removed") throw new ConflictError("Nest has already stopped listening in this channel.");
  let movedTo: string | null = null;
  if (movedToNestId && (await canAdministerNest(movedToNestId, actorUserId))) {
    movedTo = ((await getDb().get("SELECT name FROM nests WHERE id = ?", [movedToNestId])) as { name: string } | undefined)?.name ?? null;
  }
  await markRemoved(row, null);
  await recordBindingHistory(row, movedTo ? "moved" : "removed", movedTo ? `${reason} (moved to ${movedTo.slice(0, 100)})` : reason, actorUserId);
  return { binding: await bindingView(await rowOrThrow(id)) };
}

const SYSTEM_REMOVED = "Removed by Nest: Slack was disconnected, or the channel was archived or deleted, or Nest was removed from it.";

/** Remove without an actor (uninstall, bot removed, channel deleted). A person's removal passes `systemWhy` null and records its own row. */
export async function markRemoved(row: BindingRow, systemWhy: string | null = SYSTEM_REMOVED): Promise<void> {
  const now = nowIso();
  const r = await getDb().run(
    `UPDATE surface_bindings SET status = 'removed', status_changed_at = ?, capture_ok = 0, surface_ok = 0, guard_dirty = 0,
       version = version + 1, updated_at = ? WHERE id = ? AND status <> 'removed'`,
    [now, now, row.id],
  );
  if (r.changes > 0) {
    if (systemWhy) await recordBindingHistory(row, "removed", systemWhy, null);
    await pause(row, "removed", "removed");
  }
}

/**
 * A nest going away stops its channels. Archive pauses the listening ones as an
 * admin pause (only an admin Resume restarts them); delete removes them, since
 * there is no nest left to resume into.
 */
export async function stopNestBindings(nestId: string, how: "archived" | "deleted"): Promise<void> {
  const rows = (await getDb().all(
    `SELECT * FROM surface_bindings WHERE nest_id = ? AND status ${how === "archived" ? "= 'active'" : "<> 'removed'"}`,
    [nestId],
  )) as BindingRow[];
  for (const row of rows) {
    if (how === "deleted") {
      await markRemoved(row, "Removed by Nest: the nest was deleted.");
      continue;
    }
    const now = nowIso();
    const r = await getDb().run(
      `UPDATE surface_bindings SET status = 'paused_guard', pause_reason = '${ADMIN_PAUSE}', status_changed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'active'`,
      [now, now, row.id],
    );
    if (r.changes === 0) continue;
    await recordBindingHistory(row, "paused", "Paused by Nest: the nest was archived.", null);
    await pause(row, "paused_guard", "admin");
  }
}

export async function updateBinding(
  id: string,
  actorUserId: string,
  patch: { explicitPublicBind?: boolean; extCaptureEnabled?: boolean; conversationName?: string | null },
) {
  const row = await rowOrThrow(id);
  await assertNestAdmin(row.nest_id, actorUserId);
  if (row.status === "removed") throw new ConflictError("This binding was removed. Create it again instead.");
  const explicit = patch.explicitPublicBind ?? !!row.explicit_public_bind;
  if (explicit) {
    const install = await getInstall(row.install_id);
    const m = install ? await safeMembers(getConnector(install.surface), installRef(install), row.conversation_id) : null;
    assertApplicable(m && m.known ? m.conversation : null, explicit);
    if ((!m || !m.known) && (row.is_ext_shared || row.conversation_kind !== "public_channel")) {
      throw new UnprocessableError("An explicit public bind only applies to a public channel.");
    }
    if (patch.explicitPublicBind === true && !row.explicit_public_bind) await assertMayPublicBind(actorUserId);
  }
  // Bumping the version makes any in-flight re-check (computed with the old
  // settings) lose its compare-and-set.
  await getDb().run(
    `UPDATE surface_bindings SET explicit_public_bind = ?, ext_capture_enabled = ?, conversation_name = ?,
       guard_dirty = 1, guard_dirty_epoch = guard_dirty_epoch + 1, version = version + 1, updated_at = ? WHERE id = ? AND status <> 'removed'`,
    [
      explicit ? 1 : 0,
      (patch.extCaptureEnabled ?? !!row.ext_capture_enabled) ? 1 : 0,
      patch.conversationName !== undefined ? patch.conversationName : row.conversation_name,
      nowIso(),
      id,
    ],
  );
  await recheckBinding(id);
  return { binding: await bindingView(await rowOrThrow(id)) };
}

export async function getBinding(id: string, actorUserId: string) {
  const row = await rowOrThrow(id);
  await assertNestAdmin(row.nest_id, actorUserId);
  return { binding: await bindingView(row) };
}

/** Org admins see every binding; others see bindings on nests they administer. */
export async function listBindings(actorUserId: string, filter: { nestId?: string } = {}) {
  const rows = (filter.nestId
    ? await getDb().all("SELECT * FROM surface_bindings WHERE nest_id = ? ORDER BY created_at", [filter.nestId])
    : await getDb().all("SELECT * FROM surface_bindings ORDER BY created_at")) as BindingRow[];
  const orgAdmin = await isOrgAdmin(actorUserId);
  const allowed = new Map<string, boolean>();
  const out = [];
  for (const r of rows) {
    if (!orgAdmin) {
      if (!allowed.has(r.nest_id)) allowed.set(r.nest_id, await canAdministerNest(r.nest_id, actorUserId));
      if (!allowed.get(r.nest_id)) continue;
    }
    out.push(await bindingView(r));
  }
  return out;
}
