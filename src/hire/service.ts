/**
 * Hire an agent, list the hired, let one go (PO-1201, team chat C10).
 *
 * "Dont remake what we already have as a backend": a hire CREATES THE
 * EXISTING THING through the existing service, under the existing gate —
 *
 *   hootie   → a per-nest hire row (migration 100 `hired_agents`; Hootie is a
 *              server switch with no per-nest row today, so this is the one
 *              row this module owns);
 *   watcher  → an agent document (nodes/service createNode) configured as a
 *              metacognition agent (metacognition/manage configureAgent):
 *              owner/admin, like every metacognition action;
 *   webhook  → stream/agent-webhooks putAgentWebhook: owner/admin, the same
 *              URL fence (public https only), the secret returned once;
 *   key      → an AGENT PRINCIPAL (agents/principals.ts): the agent's own
 *              no-login service identity (a `users` row, as a named system
 *              is), an editor row on this nest, and one WRITE key scoped to
 *              this nest owned by that identity (auth/keys insertApiKey),
 *              returned once, plus a `hired_agents` marker row carrying the
 *              key's id; the marker's `hired_by` is the agent's owner.
 *              `config.url` adds the wake webhook in the same hire (the
 *              webhook's own owner/admin gate). A key agent is one that was
 *              HIRED: a member's personal key is never inferred from its
 *              label (security review). Keys hired before principals existed
 *              (owned by the hirer) keep working and read `legacy: true`.
 *
 * The hired list is DERIVED from those rows (agent_webhooks, api_keys,
 * metacognition_agents, hired_agents) — nothing is copied. What a member
 * sees of it follows the existing rules: who hired (an email) only for a
 * caller who may see the roster (`canSeeRoster`); delivery outcomes and the
 * `failing` status only for the nest owner or an admin, as the agent-webhooks
 * panel itself. Letting go goes through the same delete paths.
 *
 * Idempotent on (kind, handle): hiring what exists returns it with
 * `created: false` and no secret or key. One @handle answers to one agent:
 * a key and a webhook pair on a handle (the agent's identity and its wake
 * target); any other second kind is refused. `announce` posts one welcome line
 * per channel AS THE HIRING PERSON through the ordinary thread path (so it
 * fans out like any message of theirs) — never model text.
 *
 * Gates: named system keys never hire (automation wiring, like
 * agent-webhooks); a nest-scoped key can't hire a key agent (the key route's
 * own rule: a nest key can't mint keys); an archived nest hires nobody.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { insertOrIgnore } from "../db/sql.js";
import { config } from "../config.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { permissionLevel, resolveNestAccess, type NestAccess } from "../shared/access.js";
import type { ClientMetadata } from "../shared/client-metadata.js";
import { isSystemUser } from "../auth/systems.js";
import { insertApiKey } from "../auth/keys.js";
import { NO_PASSWORD } from "../auth/systems.js";
import { agentPrincipalEmail, agentPrincipalOf, type AgentPrincipal } from "../agents/principals.js";
import { createNode } from "../nodes/service.js";
import { createThread } from "../annotations/service.js";
import { fanOutPostedMessage } from "../channels/post-message.js";
import { channelAccess, getReadableChannel, isNestMember } from "../channels/channel-service.js";
import {
  assertCanManageAgentWebhooks,
  deleteAgentWebhook,
  listAgentWebhooks,
  parseAgentHandle,
  putAgentWebhook,
} from "../stream/agent-webhooks.js";
import { assertCanManageMetacognition, configureAgent, metacognitionEnabled, removeAgent } from "../metacognition/manage.js";
import { canSeeRoster, listNestPeople } from "../nests/people-service.js";
import { getAgent, listAgents } from "../metacognition/store.js";
import { CATALOG, KINDS, catalogEntry, serverUnavailableReason, type CatalogView, type HireKind } from "./catalog.js";

export interface HireCaller {
  nestId: string;
  userId: string;
  userEmail: string;
  /** The call arrived on a key fenced to this nest. */
  nestScoped?: boolean;
  client?: ClientMetadata;
}

export type HiredStatus = "active" | "failing" | "no_key" | "off";

export interface HiredAgentView {
  kind: HireKind;
  handle: string;
  /** Who hired it (an email); null for a caller who may not see the roster. */
  hired_by: string | null;
  hired_at: string;
  status: HiredStatus;
  /** One line explaining a status other than active. */
  detail: string | null;
  /** The channels a watcher watches ([] = the whole nest); [] for the rest. */
  channels: string[];
  /** Where the underlying thing is managed in the app. */
  manage: string;
  /** key: the agent's own identity, or null for a legacy key agent (a
   *  person's key labelled with the handle). Absent for other kinds. */
  principal?: PrincipalView | null;
  /** key: hired before agent principals — the key belongs to the hirer. */
  legacy?: boolean;
}

export interface PrincipalView {
  id: string;
  /** Its unroutable address (*.contextnest.invalid): how its messages are attributed. */
  email: string;
  name: string;
  nest_id: string;
  /** Who owns it: the person who hired it (an email); null for a caller who may not see the roster. */
  owner: string | null;
}

export interface HireResult {
  hired: HiredAgentView;
  created: boolean;
  /** webhook: the signing secret, only when minted. */
  secret?: string;
  /** key: the plaintext key, only when minted. */
  api_key?: string;
  announced: Array<{ channel: string; thread_id: string }>;
  /** key with config.url: the agent was hired but its wake webhook was refused. */
  wake_error?: string;
  /** The hire took but a welcome post failed (the channel changed under it):
   *  the credential above is still the only copy, so it is returned anyway. */
  announce_error?: string;
}

export const HOOTIE_HANDLE = "hootie";
export const WATCHER_FOLDER = "agents";
const WATCH_TAG_PREFIX = "watches:";
const SYSTEM_DENIED = "A system key can't manage this nest's people, settings, publishing, keys or automation.";
const OWNER_ADMIN_ONLY = (what: string) => `Only the nest owner or an admin can hire ${what}.`;
const WRITER_ONLY = "Only a person with write access to this nest can hire a key agent.";

export function parseKind(raw: unknown): HireKind {
  const k = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!(KINDS as readonly string[]).includes(k)) throw new ValidationError(`kind must be one of ${KINDS.join(", ")}.`);
  return k as HireKind;
}

const isAdminLike = (a: NestAccess) => config.AUTH_MODE === "open" || a.rawPermission === "owner" || a.rawPermission === "admin";
const isWriter = (a: NestAccess) => config.AUTH_MODE === "open" || permissionLevel(a.rawPermission) >= permissionLevel("write");

/** The caller's standing, or NotFound for anyone not added to the nest
 *  (the same answer as a nest that doesn't exist — no existence oracle). */
export async function memberAccess(caller: HireCaller): Promise<NestAccess> {
  const access = await resolveNestAccess(caller.nestId, caller.userId);
  if (!access.exists || !(await isNestMember(caller.nestId, caller.userId))) throw new NotFoundError("Nest not found");
  return access;
}

/** Why this CALLER may not hire the kind, or null. The underlying feature's
 *  gate, mirrored — never looser. */
function callerUnavailableReason(kind: HireKind, access: NestAccess, caller: HireCaller): string | null {
  switch (kind) {
    case "hootie":
      return isAdminLike(access) ? null : OWNER_ADMIN_ONLY("Hootie");
    case "watcher":
      return isAdminLike(access) ? null : OWNER_ADMIN_ONLY("a watcher");
    case "webhook":
      return isAdminLike(access) ? null : OWNER_ADMIN_ONLY("a webhook agent");
    case "key":
      if (!isWriter(access)) return WRITER_ONLY;
      if (caller.nestScoped) return "A key scoped to one nest can't mint keys. Use a session or a personal key.";
      return null;
  }
}

// ─── Catalog ─────────────────────────────────────────────────────────────

export async function hireCatalog(caller: HireCaller): Promise<{ catalog: CatalogView[] }> {
  const access = await memberAccess(caller);
  const system = await isSystemUser(caller.userId);
  return {
    catalog: CATALOG.map((e) => {
      const reason = system ? SYSTEM_DENIED : (serverUnavailableReason(e.kind) ?? callerUnavailableReason(e.kind, access, caller));
      return { ...e, available: reason === null, reason };
    }),
  };
}

// ─── The hired list (derived) ────────────────────────────────────────────

interface HireRow {
  nest_id: string;
  kind: string;
  handle: string;
  hired_by: string;
  created_at: string;
  /** The api_keys id for a key agent; null otherwise. */
  ref: string | null;
}

async function hootieRow(nestId: string): Promise<HireRow | null> {
  const row = (await getDb().get("SELECT * FROM hired_agents WHERE nest_id = ? AND kind = 'hootie'", [nestId])) as HireRow | undefined;
  return row ?? null;
}

function hootieView(row: HireRow): HiredAgentView {
  const reason = serverUnavailableReason("hootie");
  return {
    kind: "hootie",
    handle: HOOTIE_HANDLE,
    hired_by: row.hired_by,
    hired_at: row.created_at,
    status: reason === null ? "active" : config.HOOTIE_ENABLED ? "no_key" : "off",
    detail: reason,
    channels: [],
    manage: catalogEntry("hootie").manage,
  };
}

/** `nodes/agents/<handle>` ↔ handle. */
export const watcherNodeId = (handle: string) => `nodes/${WATCHER_FOLDER}/${handle}`;
export const watcherHandleOf = (nodeId: string): string | null => {
  const m = /^nodes\/agents\/([a-z0-9][a-z0-9._-]{0,62})$/.exec(nodeId);
  return m ? m[1] : null;
};

/** The channels each watcher node watches, from its `watches:<name>` tags (node_index). */
async function watcherChannels(nestId: string, nodeIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (nodeIds.length === 0) return out;
  const rows = (await getDb().all(
    `SELECT node_id, frontmatter_json FROM node_index WHERE nest_id = ? AND node_id IN (${nodeIds.map(() => "?").join(", ")})`,
    [nestId, ...nodeIds],
  )) as Array<{ node_id: string; frontmatter_json: string }>;
  for (const r of rows) {
    let tags: unknown = [];
    try {
      tags = JSON.parse(r.frontmatter_json)?.tags ?? [];
    } catch {
      /* unreadable row: no channels */
    }
    const names = (Array.isArray(tags) ? tags : [])
      .map((t) => String(t).replace(/^#/, ""))
      .filter((t) => t.startsWith(WATCH_TAG_PREFIX))
      .map((t) => t.slice(WATCH_TAG_PREFIX.length));
    out.set(r.node_id, names);
  }
  return out;
}

async function watcherViews(nestId: string): Promise<HiredAgentView[]> {
  const agents = (await listAgents(nestId)).filter((a) => watcherHandleOf(a.node_id));
  const channels = await watcherChannels(nestId, agents.map((a) => a.node_id));
  const reason = serverUnavailableReason("watcher");
  return agents.map((a) => ({
    kind: "watcher" as const,
    handle: watcherHandleOf(a.node_id)!,
    hired_by: a.created_by,
    hired_at: a.created_at,
    status: reason === null && a.enabled ? "active" : reason === null ? "off" : metacognitionEnabled() ? "no_key" : "off",
    detail: reason ?? (a.enabled ? null : "Switched off in its metacognition settings."),
    channels: channels.get(a.node_id) ?? [],
    manage: catalogEntry("watcher").manage,
  }));
}

async function webhookViews(nestId: string): Promise<HiredAgentView[]> {
  return (await listAgentWebhooks(nestId)).map((w) => ({
    kind: "webhook" as const,
    handle: w.handle,
    hired_by: w.created_by,
    hired_at: w.created_at,
    status: w.last_delivery?.status === "failed" ? "failing" : "active",
    detail: w.last_delivery?.status === "failed" ? `Last delivery failed: ${w.last_delivery.reason ?? "failed"}.` : null,
    channels: [],
    manage: catalogEntry("webhook").manage,
  }));
}

export interface KeyAgentRow {
  handle: string;
  /** The api_keys id. */
  id: string;
  /** The key's owner: the agent principal, or the hirer for a legacy key. */
  user_id: string;
  hired_by: string;
  created_at: string;
  last_used_at: string | null;
  user_email: string | null;
  user_name: string | null;
  is_service: number | null;
}

/** The nest's key agents: the hire markers joined to the keys they minted.
 *  A marker whose key was revoked elsewhere (DELETE /auth/keys) is dropped. */
export async function keyAgentRows(nestId: string): Promise<KeyAgentRow[]> {
  return (await getDb().all(
    `SELECT h.handle, k.id, k.user_id, h.hired_by, h.created_at, k.last_used_at,
            u.email AS user_email, u.name AS user_name, u.is_service
       FROM hired_agents h JOIN api_keys k ON k.id = h.ref AND k.nest_id = h.nest_id
       LEFT JOIN users u ON u.id = k.user_id
      WHERE h.nest_id = ? AND h.kind = 'key'
      ORDER BY h.created_at ASC`,
    [nestId],
  )) as KeyAgentRow[];
}

/** The principal behind a key agent row, or null for a legacy (personal) key. */
function principalOfRow(nestId: string, r: KeyAgentRow): PrincipalView | null {
  if (!Number(r.is_service) || !r.user_email || r.user_email.toLowerCase() !== agentPrincipalEmail(nestId, r.handle)) return null;
  return { id: r.user_id, email: r.user_email.toLowerCase(), name: r.user_name?.trim() || r.handle, nest_id: nestId, owner: r.hired_by };
}

function keyView(nestId: string, r: KeyAgentRow): HiredAgentView {
  const principal = principalOfRow(nestId, r);
  return {
    kind: "key",
    handle: r.handle,
    hired_by: r.hired_by,
    hired_at: r.created_at,
    status: "active",
    detail: null,
    channels: [],
    manage: catalogEntry("key").manage,
    principal,
    legacy: !principal,
  };
}

export async function listHiredAgents(caller: HireCaller): Promise<{ hired: HiredAgentView[] }> {
  const access = await memberAccess(caller);
  const { hired } = await listHiredAgentsUnchecked(caller.nestId);
  if (isAdminLike(access)) return { hired };
  // A member: the handles and kinds, but not what the admin surfaces hold —
  // who hired only with the roster, no delivery outcomes.
  const roster = await canSeeRoster(caller.nestId, caller.userId, caller.userEmail, await listNestPeople(caller.nestId)).catch(() => false);
  return {
    hired: hired.map((h) => ({
      ...h,
      hired_by: roster ? h.hired_by : null,
      ...(h.principal ? { principal: { ...h.principal, owner: roster ? h.principal.owner : null } } : {}),
      status: h.kind === "webhook" ? "active" : h.status,
      detail: h.kind === "webhook" ? null : h.detail,
    })),
  };
}

async function findHired(nestId: string, kind: HireKind, handle: string): Promise<HiredAgentView | null> {
  const { hired } = await listHiredAgentsUnchecked(nestId);
  return hired.find((h) => h.kind === kind && h.handle === handle) ?? null;
}

async function listHiredAgentsUnchecked(nestId: string): Promise<{ hired: HiredAgentView[] }> {
  const hootie = await hootieRow(nestId);
  return {
    hired: [
      ...(hootie ? [hootieView(hootie)] : []),
      ...(await watcherViews(nestId)),
      ...(await webhookViews(nestId)),
      ...(await keyAgentRows(nestId)).map((r) => keyView(nestId, r)),
    ],
  };
}

// ─── Hire ────────────────────────────────────────────────────────────────

export interface HireInput {
  kind: unknown;
  handle?: unknown;
  /** key: the agent's display name (also accepted as config.name). */
  name?: unknown;
  config?: unknown;
  channels?: unknown;
  announce?: unknown;
}

function parseChannels(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20 || raw.some((c) => typeof c !== "string")) {
    throw new ValidationError("channels must be a list of channel names (at most 20).");
  }
  return [...new Set(raw.map((c: string) => c.trim().toLowerCase().replace(/^#/, "")))];
}

/** Most key agents (agent principals) one nest may hold: they are not seats,
 *  so the hire is bounded rather than open-ended. */
export const MAX_KEY_AGENTS_PER_NEST = 25;
const MAX_DISPLAY_NAME = 60;

function parseDisplayName(raw: unknown, handle: string): string {
  if (raw === undefined || raw === null || raw === "") return handle;
  if (typeof raw !== "string" || raw.trim().length > MAX_DISPLAY_NAME || /[\r\n]/.test(raw)) {
    throw new ValidationError(`name must be one line of at most ${MAX_DISPLAY_NAME} characters.`);
  }
  return raw.trim() || handle;
}

function parseConfigObject(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("config must be an object.");
  return raw as Record<string, unknown>;
}

/** The instructions a watcher's agent document starts with. Approved text is
 *  what a run reads; on a governed nest a reviewer approves it first. */
function watcherInstructions(handle: string, channels: string[]): string {
  const where = channels.length ? channels.map((c) => `#${c}`).join(", ") : "every channel of this nest";
  return [
    `# ${handle}`,
    "",
    `You watch ${where}. Read the recent threads there (context_channel_read) and the documents they link.`,
    "",
    "Propose nothing. Comment only when a thread has settled into a decision or a task the nest does not record yet (say so and point at the thread — a person promotes it), or when a thread contradicts an approved document (name the document). Keep each comment to a few lines, and say nothing when there is nothing to say.",
    "",
  ].join("\n");
}

export async function hireAgent(caller: HireCaller, input: HireInput): Promise<HireResult> {
  if (await isSystemUser(caller.userId)) throw new ForbiddenError(SYSTEM_DENIED);
  const kind = parseKind(input.kind);
  const handle = kind === "hootie" ? HOOTIE_HANDLE : parseAgentHandle(input.handle);
  const channels = parseChannels(input.channels);
  const cfg = parseConfigObject(input.config);
  const announce = input.announce === true;
  const access = await memberAccess(caller);
  if (access.archived) throw new ForbiddenError("This nest is archived, so it is read-only.");
  const unavailable = serverUnavailableReason(kind) ?? callerUnavailableReason(kind, access, caller);
  if (unavailable) {
    if (serverUnavailableReason(kind)) throw new ValidationError(unavailable);
    throw new ForbiddenError(unavailable);
  }
  // Every channel named must exist, be readable, and take the hirer's post —
  // checked up front so a refusal leaves nothing half-hired.
  const nodes: Array<{ name: string; id: string }> = [];
  for (const name of channels) {
    const { node, view } = await getReadableChannel(caller, name);
    if (announce) {
      const refusal = (await channelAccess(caller, node)).post;
      if (refusal) throw new AppError(refusal.status, refusal.error);
    }
    nodes.push({ name: view.name, id: node.id });
  }

  let created = false;
  let secret: string | undefined;
  let apiKey: string | undefined;
  let wakeError: string | undefined;
  const nestId = caller.nestId;
  // One @handle answers to one agent: a handle hired as another kind is taken.
  // A key and a webhook pair: the agent's identity and its wake target.
  const pairs = (a: HireKind, b: HireKind) => (a === "key" && b === "webhook") || (a === "webhook" && b === "key");
  const taken = (await listHiredAgentsUnchecked(nestId)).hired.find((h) => h.handle === handle && h.kind !== kind && !pairs(h.kind, kind));
  if (taken) throw new ConflictError(`@${handle} is already hired here as a ${taken.kind} agent.`);

  if (kind === "hootie") {
    const db = getDb();
    const res = await db.run(
      insertOrIgnore(db, "INSERT INTO hired_agents (nest_id, kind, handle, hired_by, created_at) VALUES (?, ?, ?, ?, ?)"),
      [nestId, "hootie", HOOTIE_HANDLE, caller.userEmail, new Date().toISOString()],
    );
    created = res.changes > 0;
  } else if (kind === "watcher") {
    await assertCanManageMetacognition(nestId, caller.userId, access.rawPermission);
    const nodeId = watcherNodeId(handle);
    if (!(await getAgent(nestId, nodeId))) {
      // The document may exist already: let go keeps it, or a concurrent hire made it.
      try {
        await createNode(
          nestId,
          {
            id: nodeId,
            title: handle,
            content: watcherInstructions(handle, nodes.map((n) => n.name)),
            type: "agent",
            tags: ["watcher", ...nodes.map((n) => `${WATCH_TAG_PREFIX}${n.name}`)],
          },
          caller.userEmail,
          { notifyMentions: false },
        );
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
      }
      await configureAgent({
        nestId,
        nodeId,
        body: {
          persona: { name: handle },
          // The channel nodes live under nodes/channels/: the folder is the
          // scope (inFolders matches by folder, never a single node); the
          // instructions name the channels. [] = the whole nest.
          scope: { read: nodes.length ? ["channels"] : [], propose: [] },
          enabled: true,
        },
        savedBy: caller.userEmail,
      });
      created = true;
    }
  } else if (kind === "webhook") {
    await assertCanManageAgentWebhooks(nestId, caller.userId, { write: true });
    const existing = (await listAgentWebhooks(nestId)).find((w) => w.handle === handle);
    if (!existing) {
      try {
        const r = await putAgentWebhook(nestId, handle, { url: cfg.url }, caller.userEmail);
        secret = r.secret;
        created = !!r.secret;
      } catch (err) {
        // Two admins hiring the same handle at once: the second insert hits
        // the (nest, handle) key — "already hired", not a failure. Decided by
        // re-reading the row, not by the driver's wording.
        if (err instanceof AppError) throw err;
        if (!(await listAgentWebhooks(nestId)).some((w) => w.handle === handle)) throw err;
      }
    }
  } else {
    // key: the agent principal, its access and its key in ONE transaction
    // with the marker, the marker carrying the key's id from the start. The
    // marker's primary key serialises two hires of one handle (the loser sees
    // "already hired" and mints nothing), and a crash can't leave a marker
    // without a key. The optional webhook is checked up front (its own
    // owner/admin gate) and written after, through its own service.
    const db = getDb();
    const name = parseDisplayName(cfg.name ?? input.name, handle);
    // An agent never wears a person's name: its messages show its name.
    if (name !== handle) {
      const clash = (await listNestPeople(nestId)).some(
        (p) => p.email.toLowerCase() === name.toLowerCase() || (p.name ?? "").trim().toLowerCase() === name.toLowerCase(),
      );
      if (clash) throw new ValidationError("That name belongs to a person on this nest. Give the agent its own name.");
    }
    const wantsWake = cfg.url !== undefined && cfg.url !== null && cfg.url !== "";
    if (wantsWake) {
      if (!isAdminLike(access)) throw new ForbiddenError(OWNER_ADMIN_ONLY("an agent with a wake webhook"));
      await assertCanManageAgentWebhooks(nestId, caller.userId, { write: true });
    }
    const stale = (await db.get("SELECT ref FROM hired_agents WHERE nest_id = ? AND kind = 'key' AND handle = ?", [nestId, handle])) as
      | { ref: string | null }
      | undefined;
    // A marker without a key (an older write that died halfway) or whose key
    // was revoked through /auth/keys is spent: clear it, it blocks nothing.
    if (stale && (!stale.ref || !(await db.get("SELECT 1 AS ok FROM api_keys WHERE id = ?", [stale.ref])))) {
      await db.run("DELETE FROM hired_agents WHERE nest_id = ? AND kind = 'key' AND handle = ?", [nestId, handle]);
    }
    const email = agentPrincipalEmail(nestId, handle);
    const existingUser = (await db.get("SELECT id, is_service FROM users WHERE LOWER(email) = ?", [email])) as
      | { id: string; is_service: number | null }
      | undefined;
    // A person who registered the address is a person: never adopted.
    if (existingUser && !(await agentPrincipalOf(existingUser.id))) {
      throw new ConflictError(`@${handle} can't be hired here: its agent address is taken by an account that is not an agent.`);
    }
    const alreadyHired = stale?.ref && (await db.get("SELECT 1 AS ok FROM api_keys WHERE id = ?", [stale.ref]));
    if (!alreadyHired) {
      const count = (await db.get("SELECT CAST(COUNT(*) AS INTEGER) AS n FROM hired_agents WHERE nest_id = ? AND kind = 'key'", [nestId])) as { n: number | string };
      if (Number(count.n) >= MAX_KEY_AGENTS_PER_NEST) {
        throw new ConflictError(`This nest already has ${MAX_KEY_AGENTS_PER_NEST} key agents, the most it can hold. Let one go first.`);
      }
    }
    const keyId = uuid();
    const principalId = existingUser?.id ?? uuid();
    const minted = await db.transaction(async (tx) => {
      const marker = await tx.run(
        insertOrIgnore(db, "INSERT INTO hired_agents (nest_id, kind, handle, hired_by, created_at, ref) VALUES (?, ?, ?, ?, ?, ?)"),
        [nestId, "key", handle, caller.userEmail, new Date().toISOString(), keyId],
      );
      if (!marker.changes) return null; // already hired
      if (existingUser) {
        // Re-hire: the same identity, its name refreshed, no key or access left over.
        await tx.run("UPDATE users SET name = ? WHERE id = ? AND is_service = 1", [name, principalId]);
        await tx.run("DELETE FROM api_keys WHERE user_id = ?", [principalId]);
        await tx.run("DELETE FROM nest_collaborators WHERE user_id = ?", [principalId]);
      } else {
        await tx.run("INSERT INTO users (id, email, name, password_hash, is_service) VALUES (?, ?, ?, ?, 1)", [principalId, email, name, NO_PASSWORD]);
      }
      await tx.run("INSERT INTO nest_collaborators (id, nest_id, user_id, permission, granted_by) VALUES (?, ?, ?, 'write', ?)", [
        uuid(),
        nestId,
        principalId,
        caller.userId,
      ]);
      return insertApiKey(tx, { id: keyId, userId: principalId, nestId, label: handle, capability: "write", origin: "service" });
    });
    if (minted) {
      apiKey = minted.apiKey;
      created = true;
    }
    if (wantsWake && !(await listAgentWebhooks(nestId)).some((w) => w.handle === handle)) {
      try {
        const r = await putAgentWebhook(nestId, handle, { url: cfg.url }, caller.userEmail);
        secret = r.secret;
        created ||= !!r.secret;
      } catch (err) {
        // The identity is committed and its key is in this response; a
        // webhook refused here (an address that isn't public) is reported.
        if (!apiKey) throw err;
        console.warn("[hire] webhook not added for a key agent", nestId, handle, err instanceof Error ? err.message : err);
        wakeError = err instanceof Error ? err.message : "The wake webhook was not added.";
      }
    }
  }

  const hired = await findHired(nestId, kind, handle);
  if (!hired) throw new NotFoundError("The hire did not take."); // unreachable in practice
  const announced: HireResult["announced"] = [];
  let announceError: string | undefined;
  if (announce && created) {
    const line = `Hired @${handle}: ${catalogEntry(kind).in_channel}.`;
    for (const n of nodes) {
      // The hire is committed and the credential below is its only copy: a
      // welcome post that fails (the channel archived between the check and
      // the post) is reported, never allowed to lose it.
      try {
        const thread = await createThread(nestId, n.id, { body: line, anchor: null }, caller.userEmail, caller.client);
        await fanOutPostedMessage({ nestId, nodeId: n.id, thread, isReply: false, body: line, authorEmail: caller.userEmail, authorUserId: caller.userId });
        announced.push({ channel: n.name, thread_id: thread.id });
      } catch (err) {
        console.error("[hire] announce failed", nestId, n.id, err);
        announceError = `The welcome post in #${n.name} failed; the agent is hired and its credential is in this response.`;
        break;
      }
    }
  }
  return {
    hired,
    created,
    ...(secret ? { secret } : {}),
    ...(apiKey ? { api_key: apiKey } : {}),
    announced,
    ...(announceError ? { announce_error: announceError } : {}),
    ...(wakeError ? { wake_error: wakeError } : {}),
  };
}

async function userIdByEmail(email: string): Promise<string | null> {
  const row = (await getDb().get("SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND COALESCE(is_service, 0) = 0", [email])) as { id: string } | undefined;
  return row?.id ?? null;
}

// ─── Who am I (an agent principal) ───────────────────────────────────────

export interface AgentIdentityView {
  agent: boolean;
  handle?: string;
  name?: string;
  email?: string;
  nest?: { id: string; name: string | null };
  /** The person who hired it: its owner. */
  owner?: { email: string; name: string | null } | null;
  hired_at?: string;
  /** A legacy key agent: the key is a person's, labelled with the handle. */
  legacy?: boolean;
  /** A wake webhook is set for the handle. */
  webhook?: boolean;
  /** What it may do, in plain words. */
  can?: string[];
  /** For agent:false — why. */
  detail?: string;
}

/**
 * Who the caller is as an agent: its handle, name, nest and owner — the
 * agent principal behind the key, or a legacy hired key (a person's key
 * labelled with a hired handle). Anyone else is `agent: false`.
 */
export async function agentIdentity(caller: HireCaller & { apiKeyId?: string | null }): Promise<AgentIdentityView> {
  await memberAccess(caller);
  const db = getDb();
  const nest = (await db.get("SELECT name FROM nests WHERE id = ?", [caller.nestId])) as { name: string | null } | undefined;
  const rows = await keyAgentRows(caller.nestId);
  const p: AgentPrincipal | null = await agentPrincipalOf(caller.userId);
  const row = p ? rows.find((r) => r.user_id === p.id) : caller.apiKeyId ? rows.find((r) => r.id === caller.apiKeyId) : undefined;
  if (!row) {
    return { agent: false, detail: "This credential is a person's, not a hired agent's. Hire one with context_hire_agent { kind: \"key\", handle }." };
  }
  const owner = (await db.get("SELECT email, name FROM users WHERE LOWER(email) = LOWER(?) AND COALESCE(is_service, 0) = 0", [row.hired_by])) as
    | { email: string; name: string | null }
    | undefined;
  return {
    agent: true,
    handle: row.handle,
    name: p?.name ?? row.handle,
    email: p?.email ?? row.user_email ?? undefined,
    nest: { id: caller.nestId, name: nest?.name ?? null },
    owner: owner ? { email: owner.email.toLowerCase(), name: owner.name } : { email: row.hired_by, name: null },
    hired_at: row.created_at,
    legacy: !p,
    webhook: (await listAgentWebhooks(caller.nestId)).some((w) => w.handle === row.handle),
    can: p
      ? [
          "read and write in this nest as an editor (drafts go to review)",
          "read and post in the conversations and private channels it is a member of",
          "read the full text of its own memory under nodes/agents/" + row.handle + "/memory/, in review or not",
          "never approve or reject a review, mint keys, hire, sign in, or reach another nest",
        ]
      : ["acts with the permission of the person whose key it is (legacy)"],
  };
}

// ─── Let go ──────────────────────────────────────────────────────────────

export async function letAgentGo(caller: HireCaller, rawKind: unknown, rawHandle: unknown): Promise<{ deleted: true }> {
  if (await isSystemUser(caller.userId)) throw new ForbiddenError(SYSTEM_DENIED);
  const kind = parseKind(rawKind);
  const handle = kind === "hootie" ? HOOTIE_HANDLE : parseAgentHandle(rawHandle);
  const access = await memberAccess(caller);
  if (access.archived) throw new ForbiddenError("This nest is archived, so it is read-only.");
  const nestId = caller.nestId;
  if (kind === "hootie") {
    if (!isAdminLike(access)) throw new ForbiddenError("Only the nest owner or an admin can let Hootie go.");
    const res = await getDb().run("DELETE FROM hired_agents WHERE nest_id = ? AND kind = 'hootie'", [nestId]);
    if (!res.changes) throw new NotFoundError("Hootie is not hired here.");
  } else if (kind === "watcher") {
    await assertCanManageMetacognition(nestId, caller.userId, access.rawPermission);
    await removeAgent(nestId, watcherNodeId(handle)); // NotFound when it isn't one; the document stays
  } else if (kind === "webhook") {
    await assertCanManageAgentWebhooks(nestId, caller.userId, { write: true });
    await deleteAgentWebhook(nestId, handle);
  } else {
    const row = (await keyAgentRows(nestId)).find((k) => k.handle === handle);
    if (!row) throw new NotFoundError("No key agent with that handle.");
    const principal = principalOfRow(nestId, row);
    // Its owner: the person who hired it (a legacy key: the key's own person).
    const ownerId = principal ? await userIdByEmail(row.hired_by) : row.user_id;
    // The key's own route lets only its owner revoke it; the nest's owner or
    // an admin may too — the key is fenced to the nest they administer. An
    // admin still can't let go what the nest OWNER hired.
    if (ownerId !== caller.userId && !isAdminLike(access)) {
      throw new ForbiddenError("Only the person who hired this agent, or a nest owner or admin, can let it go.");
    }
    if (ownerId !== caller.userId && ownerId === access.ownerId && config.AUTH_MODE !== "open") {
      throw new ForbiddenError("Only the nest owner can let go an agent the owner hired.");
    }
    const db = getDb();
    await db.transaction(async (tx) => {
      if (principal) {
        // Every credential and every grant of access goes; the identity stays
        // (no key, no access) so a re-hire reuses it.
        await tx.run("DELETE FROM api_keys WHERE user_id = ?", [principal.id]);
        await tx.run("DELETE FROM nest_collaborators WHERE user_id = ?", [principal.id]);
        await tx.run("DELETE FROM sessions WHERE user_id = ?", [principal.id]);
        await tx.run("DELETE FROM stewards WHERE user_id = ? OR LOWER(user_email) = LOWER(?)", [principal.id, principal.email]);
      } else {
        await tx.run("DELETE FROM api_keys WHERE id = ?", [row.id]);
      }
      await tx.run("DELETE FROM hired_agents WHERE nest_id = ? AND kind = 'key' AND handle = ?", [nestId, handle]);
    });
  }
  return { deleted: true };
}
