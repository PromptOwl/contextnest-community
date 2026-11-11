/**
 * Hire an agent, list the hired, let one go (PO-1201, team chat C10).
 *
 * "Dont remake what we already have as a backend": a hire CREATES THE
 * EXISTING THING through the existing service, under the existing gate —
 *
 *   hootie   → a per-nest hire row (migration 092 `hired_agents`; Hootie is a
 *              server switch with no per-nest row today, so this is the one
 *              row this module owns);
 *   watcher  → an agent document (nodes/service createNode) configured as a
 *              metacognition agent (metacognition/manage configureAgent):
 *              owner/admin, like every metacognition action;
 *   webhook  → stream/agent-webhooks putAgentWebhook: owner/admin, the same
 *              URL fence (public https only), the secret returned once;
 *   key      → auth/keys insertApiKey: a WRITE key scoped to this nest,
 *              labelled with the handle, owned by the hirer and returned
 *              once, plus a `hired_agents` marker row carrying the key's id.
 *              A key agent is one that was HIRED: a member's personal key is
 *              never inferred from its label (security review). The
 *              underlying route lets any member mint one; hiring asks for a
 *              writer (stricter, never looser).
 *
 * The hired list is DERIVED from those rows (agent_webhooks, api_keys,
 * metacognition_agents, hired_agents) — nothing is copied. What a member
 * sees of it follows the existing rules: who hired (an email) only for a
 * caller who may see the roster (`canSeeRoster`); delivery outcomes and the
 * `failing` status only for the nest owner or an admin, as the agent-webhooks
 * panel itself. Letting go goes through the same delete paths.
 *
 * Idempotent on (kind, handle): hiring what exists returns it with
 * `created: false` and no secret or key. `announce` posts one welcome line
 * per channel AS THE HIRING PERSON through the ordinary thread path (so it
 * fans out like any message of theirs) — never model text.
 *
 * Gates: named system keys never hire (automation wiring, like
 * agent-webhooks); a nest-scoped key can't hire a key agent (the key route's
 * own rule: a nest key can't mint keys); an archived nest hires nobody.
 */
import { v4 as uuid } from "uuid";
import { DocumentNotFoundError } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { insertOrIgnore } from "../db/sql.js";
import { config } from "../config.js";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { permissionLevel, resolveNestAccess, type NestAccess } from "../shared/access.js";
import type { ClientMetadata } from "../shared/client-metadata.js";
import { isSystemUser } from "../auth/systems.js";
import { insertApiKey, verifyKeyRequest } from "../auth/keys.js";
import { engineCache } from "../nodes/engine.js";
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
}

export interface HireResult {
  hired: HiredAgentView;
  created: boolean;
  /** webhook: the signing secret, only when minted. */
  secret?: string;
  /** key: the plaintext key, only when minted. */
  api_key?: string;
  announced: Array<{ channel: string; thread_id: string }>;
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
  /** The key's owner (the hirer). */
  user_id: string;
  hired_by: string;
  created_at: string;
  last_used_at: string | null;
}

/** The nest's key agents: the hire markers joined to the keys they minted.
 *  A marker whose key was revoked elsewhere (DELETE /auth/keys) is dropped. */
export async function keyAgentRows(nestId: string): Promise<KeyAgentRow[]> {
  return (await getDb().all(
    `SELECT h.handle, k.id, k.user_id, h.hired_by, h.created_at, k.last_used_at
       FROM hired_agents h JOIN api_keys k ON k.id = h.ref AND k.nest_id = h.nest_id
      WHERE h.nest_id = ? AND h.kind = 'key'
      ORDER BY h.created_at ASC`,
    [nestId],
  )) as KeyAgentRow[];
}

function keyView(r: KeyAgentRow): HiredAgentView {
  return {
    kind: "key",
    handle: r.handle,
    hired_by: r.hired_by,
    hired_at: r.created_at,
    status: "active",
    detail: null,
    channels: [],
    manage: catalogEntry("key").manage,
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
      ...(await keyAgentRows(nestId)).map(keyView),
    ],
  };
}

// ─── Hire ────────────────────────────────────────────────────────────────

export interface HireInput {
  kind: unknown;
  handle?: unknown;
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
  const nestId = caller.nestId;

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
      const { storage } = await engineCache.get(nestId);
      let exists = true;
      try {
        await storage.readDocument(nodeId);
      } catch (err) {
        if (!(err instanceof DocumentNotFoundError)) throw err;
        exists = false;
      }
      if (!exists) {
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
        created = true;
      } catch (err) {
        // Two admins hiring the same handle at once: the second insert hits
        // the (nest, handle) key — "already hired", not a failure. Decided by
        // re-reading the row, not by the driver's wording.
        if (err instanceof AppError) throw err;
        if (!(await listAgentWebhooks(nestId)).some((w) => w.handle === handle)) throw err;
      }
    }
  } else {
    // key: the marker and the key in ONE transaction, the marker carrying the
    // key's id from the start. The marker's primary key serialises two hires
    // of one handle (the loser sees "already hired" and mints nothing), and
    // a crash can't leave a marker without a key.
    const db = getDb();
    const check = await verifyKeyRequest(db, caller.userId, { action: "generate", label: handle });
    const stale = (await db.get("SELECT ref FROM hired_agents WHERE nest_id = ? AND kind = 'key' AND handle = ?", [nestId, handle])) as
      | { ref: string | null }
      | undefined;
    // A marker without a key (an older write that died halfway) or whose key
    // was revoked through /auth/keys is spent: clear it, it blocks nothing.
    if (stale && (!stale.ref || !(await db.get("SELECT 1 AS ok FROM api_keys WHERE id = ?", [stale.ref])))) {
      await db.run("DELETE FROM hired_agents WHERE nest_id = ? AND kind = 'key' AND handle = ?", [nestId, handle]);
    }
    const keyId = uuid();
    const minted = await db.transaction(async (tx) => {
      const marker = await tx.run(
        insertOrIgnore(db, "INSERT INTO hired_agents (nest_id, kind, handle, hired_by, created_at, ref) VALUES (?, ?, ?, ?, ?, ?)"),
        [nestId, "key", handle, caller.userEmail, new Date().toISOString(), keyId],
      );
      if (!marker.changes) return null; // already hired
      if (!check.ok) throw new AppError(check.status, check.error); // rolls the marker back
      return insertApiKey(tx, { id: keyId, userId: caller.userId, nestId, label: check.label, capability: "write", origin: "manual" });
    });
    if (minted) {
      apiKey = minted.apiKey;
      created = true;
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
    // The key's own route lets only its owner revoke it; the nest's owner or
    // an admin may too — the key is fenced to the nest they administer. An
    // admin still can't touch the nest OWNER's credentials.
    if (row.user_id !== caller.userId && !isAdminLike(access)) {
      throw new ForbiddenError("Only the person who hired this agent, or a nest owner or admin, can let it go.");
    }
    if (row.user_id !== caller.userId && row.user_id === access.ownerId && config.AUTH_MODE !== "open") {
      throw new ForbiddenError("Only the nest owner can let go an agent the owner hired.");
    }
    const db = getDb();
    await db.run("DELETE FROM api_keys WHERE id = ?", [row.id]);
    await db.run("DELETE FROM hired_agents WHERE nest_id = ? AND kind = 'key' AND handle = ?", [nestId, handle]);
  }
  return { deleted: true };
}
