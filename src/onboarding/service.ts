/**
 * First-run onboarding (PO-1185): the state behind the welcome screen.
 *
 * A FIRST RUN is a signed-in person who owns no live nest and was let into
 * nobody else's (PO-1391): no collaborator grant, steward assignment, team
 * share or document share. Someone invited to a nest lands on their nest list
 * with that nest in it, not here. Reading a nest through its visibility
 * (public, org) is not an invitation and does not count.
 *
 * A first run who has not dismissed the screen sees it. It then stays open
 * while it walks them through the nest it made ("Create my nest"), until they
 * click Skip or Done. "Getting started" on Home reopens it at any time, for
 * anyone.
 *
 * `show` is decided here and nowhere else: the UI renders it, and
 * context_onboarding reports it.
 *
 * The REST routes (routes.ts) and the MCP tools (mcp/onboarding-tools.ts) call
 * these functions, so the two surfaces cannot drift.
 */
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { ANON_USER_ID } from "../shared/constants.js";
import { createNest, listNestsGrantedTo } from "../nests/service.js";
import { isServerAdminUserId, resolveNestPermission } from "../shared/access.js";
import { isOrgAdmin } from "../surfaces/services/binding-service.js";
import { deserializeClient } from "../shared/client-metadata.js";

import { hostedEnabled } from "../surfaces/flags.js";
import { surfacesEnabled } from "../surfaces/flags.js";
import { resolveModelCredential } from "../shared/model-credential.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";

const iso = () => new Date().toISOString();

interface OnboardingRow {
  user_id: string;
  nest_id: string | null;
  dismissed_at: string | null;
  reopened: number;
}

interface NestRef {
  id: string;
  name: string;
}

export interface SlackConnectorState {
  /** The hosted Slack app is on and its credentials are set. */
  configured: boolean;
  /** This person may connect their own workspace (self-serve or admin). */
  can_connect: boolean;
  /**
   * An active install has this nest as its home, whoever installed it: the
   * tile reports the nest's state (an admin may have connected it for you).
   */
  connected: boolean;
  /** Present only when not configured and the caller is a server admin. */
  admin_settings_path: string | null;
  /** Why the tile cannot connect, in one sentence, when it cannot. */
  reason: string | null;
  disclosure: string;
}

export interface OnboardingState {
  enabled: boolean;
  /** Show the welcome screen now. */
  show: boolean;
  /** Owns no live nest and was let into nobody else's (see shared_nests). */
  first_run: boolean;
  /**
   * Live nests someone else owns that this person was let into: collaborator,
   * steward, team share or a share on one document. Not public or org nests
   * they can merely read.
   */
  shared_nests: number;
  dismissed: boolean;
  /** The nest the screen works on: the one it created, else the newest owned. */
  nest: (NestRef & { mcp_url: string; server_mcp_url: string }) | null;
  can_create_nest: boolean;
  suggested_nest_name: string;
  server_url: string;
  open_mode: boolean;
  mcp_oauth_enabled: boolean;
  hootie_enabled: boolean;
  distill: { enabled: boolean; model_available: boolean; mode: "server" | "agent" };
  connectors: { slack: SlackConnectorState };
}

async function row(userId: string): Promise<OnboardingRow | null> {
  return ((await getDb().get("SELECT user_id, nest_id, dismissed_at, reopened FROM user_onboarding WHERE user_id = ?", [
    userId,
  ])) ?? null) as OnboardingRow | null;
}

async function upsert(userId: string, patch: Partial<Omit<OnboardingRow, "user_id">>): Promise<void> {
  const db = getDb();
  // Insert-if-absent is atomic (the primary key decides), so two concurrent
  // first writes never collide into a 500; the patch is then applied to the row.
  await db.run(
    "INSERT INTO user_onboarding (user_id, nest_id, dismissed_at, reopened, created_at, updated_at) VALUES (?, NULL, NULL, 0, ?, ?) ON CONFLICT (user_id) DO NOTHING",
    [userId, iso(), iso()],
  );
  const existing = (await row(userId))!;
  const next = { ...existing, ...patch };
  await db.run("UPDATE user_onboarding SET nest_id = ?, dismissed_at = ?, reopened = ?, updated_at = ? WHERE user_id = ?", [
    next.nest_id,
    next.dismissed_at,
    next.reopened,
    iso(),
    userId,
  ]);
}

async function ownedNests(userId: string): Promise<NestRef[]> {
  return (await getDb().all(
    "SELECT id, name FROM nests WHERE user_id = ? AND archived_at IS NULL ORDER BY created_at DESC",
    [userId],
  )) as NestRef[];
}

/** "<Name>'s nest", from the person's name, else their email's local part. */
export async function suggestedNestName(userId: string): Promise<string> {
  const u = (await getDb().get("SELECT name, email FROM users WHERE id = ?", [userId])) as
    | { name: string | null; email: string | null }
    | undefined;
  const first = (u?.name ?? "").trim().split(/\s+/)[0] || (u?.email ?? "").split("@")[0] || "My";
  // Keep only what a nest name accepts; a name with nothing left falls back.
  const clean = first.replace(/[^\p{L}\p{N}._-]/gu, "").slice(0, 40);
  const display = clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : "My";
  return display === "My" ? "My nest" : `${display}'s nest`;
}

export function nestMcpUrl(baseUrl: string, nestId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/nests/${nestId}/mcp`;
}

async function canCreateNests(userId: string): Promise<boolean> {
  return config.AUTH_MODE === "open" || config.NEST_CREATION === "everyone" || (await isServerAdminUserId(userId));
}

/** Slack is "configured" when the hosted app is on and has its credentials. */
export function slackConfigured(): boolean {
  return (
    hostedEnabled() &&
    !!config.SURFACES_SLACK_HOSTED_CLIENT_ID &&
    !!config.SURFACES_SLACK_HOSTED_CLIENT_SECRET &&
    !!config.SURFACES_SLACK_HOSTED_SIGNING_SECRET
  );
}

export async function slackState(userId: string, nestId: string | null): Promise<SlackConnectorState> {
  // The same check the self-serve route makes, so the tile never offers
  // Connect where the route would refuse.
  const admin = await isOrgAdmin(userId);
  const configured = slackConfigured();
  let connected = false;
  if (nestId && surfacesEnabled()) {
    connected = !!(await getDb()
      .get("SELECT 1 AS x FROM surface_installs WHERE surface = 'slack' AND home_nest_id = ? AND status = 'active'", [nestId])
      .catch((err) => {
        console.warn("[onboarding] Slack install lookup failed", err);
        return undefined;
      }));
  }
  const selfServe = configured && config.SURFACES_SLACK_SELF_SERVE;
  const canConnect = configured && (selfServe || admin) && !!nestId;
  let reason: string | null = null;
  if (!configured) reason = "A server admin must configure the Slack app on this server first.";
  else if (!selfServe && !admin) reason = "Self-serve Slack is not turned on for this server. Contact your server admin to turn it on, or to connect Slack for you.";
  else if (!nestId) reason = "Create your nest first.";
  return {
    configured,
    can_connect: canConnect,
    connected,
    admin_settings_path: !configured && admin ? "/settings" : null,
    reason,
    disclosure: "This server's administrators can read every nest.",
  };
}

/**
 * The first-run rule (PO-1391): nothing of their own and nothing they were
 * let into. An invited person has somewhere to land already.
 */
export function isFirstRun(ownedNests: number, grantedNests: number): boolean {
  return ownedNests === 0 && grantedNests === 0;
}

export async function getOnboardingState(userId: string, baseUrl: string): Promise<OnboardingState> {
  const enabled = config.ONBOARDING_ENABLED && config.AUTH_MODE !== "open" && userId !== ANON_USER_ID;
  const r = await row(userId);
  const owned = await ownedNests(userId);
  let nest: NestRef | null = null;
  if (r?.nest_id) nest = owned.find((n) => n.id === r.nest_id) ?? null;
  if (!nest) nest = owned[0] ?? null;
  const sharedNests = (await listNestsGrantedTo(userId)).length;
  const firstRun = isFirstRun(owned.length, sharedNests);
  const dismissed = !!r?.dismissed_at;
  // After "Create my nest" the screen stays on (nest_id set) so the person can
  // connect and fill it. Reopened from Home, it shows whatever they own.
  const show = enabled && !dismissed && (firstRun || !!r?.nest_id || !!r?.reopened);
  const modelAvailable = !!resolveModelCredential();
  const distillOn = config.DISTILL_ENABLED;
  const base = baseUrl.replace(/\/+$/, "");
  return {
    enabled,
    show,
    first_run: firstRun,
    shared_nests: sharedNests,
    dismissed,
    nest: nest ? { ...nest, mcp_url: nestMcpUrl(base, nest.id), server_mcp_url: `${base}/mcp` } : null,
    can_create_nest: await canCreateNests(userId),
    suggested_nest_name: await suggestedNestName(userId),
    server_url: base,
    open_mode: config.AUTH_MODE === "open",
    mcp_oauth_enabled: config.MCP_OAUTH_ENABLED,
    hootie_enabled: config.HOOTIE_ENABLED,
    distill: { enabled: distillOn, model_available: modelAvailable, mode: distillOn && modelAvailable ? "server" : "agent" },
    connectors: { slack: await slackState(userId, nest?.id ?? null) },
  };
}

export async function dismissOnboarding(userId: string): Promise<void> {
  await upsert(userId, { dismissed_at: iso(), reopened: 0 });
}

export async function reopenOnboarding(userId: string): Promise<void> {
  await upsert(userId, { dismissed_at: null, reopened: 1 });
}

/**
 * One "Create my nest" at a time per person. The check-then-create below spans
 * several awaits, so a double click (or two tabs) would otherwise both see no
 * nest and make two. In-process is enough: the server is single-process, the
 * same assumption as the node write lock.
 */
const createMyNestChains = new Map<string, Promise<unknown>>();

/**
 * "Create my nest": one nest named "<Name>'s nest", owned by the caller,
 * through the ordinary createNest path (nest-creation policy, plan cap and
 * seat check included). Idempotent: a second call returns the nest the first
 * one made, so a double click cannot make two.
 */
export function createMyNest(userId: string, name?: string): Promise<NestRef & { created: boolean }> {
  const prev = (createMyNestChains.get(userId) ?? Promise.resolve()).catch(() => {});
  const run = prev.then(() => createMyNestOnce(userId, name));
  createMyNestChains.set(userId, run);
  void run
    .catch(() => {})
    .finally(() => {
      if (createMyNestChains.get(userId) === run) createMyNestChains.delete(userId);
    });
  return run;
}

async function createMyNestOnce(userId: string, name?: string): Promise<NestRef & { created: boolean }> {
  if (userId === ANON_USER_ID) throw new ForbiddenError("Sign in to create a nest of your own.");
  const r = await row(userId);
  if (r?.nest_id) {
    const existing = (await getDb().get("SELECT id, name FROM nests WHERE id = ? AND user_id = ? AND archived_at IS NULL", [
      r.nest_id,
      userId,
    ])) as NestRef | undefined;
    if (existing) return { ...existing, created: false };
  }
  const wanted = (name ?? "").trim() || (await suggestedNestName(userId));
  if (wanted.length > 120) throw new ValidationError("A nest name is at most 120 characters.");
  // A live nest of exactly this name that the person owns is the one to use:
  // either an earlier call made it and failed to record it below (so a retry
  // must not make a second), or they made it by hand.
  const same = (await ownedNests(userId)).find((n) => n.name === wanted);
  if (same) {
    await upsert(userId, { nest_id: same.id });
    return { ...same, created: false };
  }
  let nest;
  try {
    nest = await createNest(userId, wanted);
  } catch (err) {
    // The person already has a nest of that name (made by hand): pick a free one.
    if (err instanceof ValidationError && /already have a nest/i.test(err.message)) {
      nest = await createNest(userId, `${wanted} ${new Date().toISOString().slice(0, 10)}`);
    } else throw err;
  }
  await upsert(userId, { nest_id: nest.id });
  return { id: nest.id, name: nest.name, created: true };
}

/** The caller must be able to read the nest; one message for every miss. */
export async function assertCanReadNest(userId: string, nestId: string): Promise<void> {
  const perm = await resolveNestPermission(nestId, userId).catch(() => null);
  if (!perm || perm === "none") throw new NotFoundError("Nest not found.");
}

export interface ConnectionEvidence {
  connected: boolean;
  /** When the most recent agent read landed. */
  at: string | null;
  /** How it read: "mcp" (a read tool), "api" (a keyed REST read) or "hootie". */
  via: "mcp" | "api" | "hootie" | null;
  /** What the client called itself (MCP clientInfo / key label). Self-reported. */
  client: string | null;
  tool: string | null;
}

/** MCP tools that read a nest's content. A write or nest_index is not proof. */
export const READ_PROOF_TOOLS = [
  "context_get",
  "context_query",
  "context_search",
  "context_list",
  "context_overview",
  "context_resolve",
  "context_export",
  "context_init",
];

/**
 * REST reads of a nest's content, for the keyed-GET branch of the proof:
 * documents, search, context and the like, not members, settings or traces.
 */
const CONTENT_READ_PATHS = ["context", "search", "overview", "export", "graph", "folders", "instructions", "query", "resolve", "nodes"];

/**
 * The connect proof: did an agent, acting as this person, really read this
 * nest at or after `since`? Answered from the activity trace (api_events),
 * which logs every MCP tool call and every REST request with the nest and the
 * authenticated user. Counted:
 *   - an MCP read tool on this nest (per-nest /nests/:id/mcp, or the
 *     server-level /mcp with this nest as its target or in its fan-out);
 *   - a REST read of this nest's content (CONTENT_READ_PATHS) made with an
 *     agent's key (a key label or a client block names the agent; a browser
 *     session names none);
 *   - a Hootie answer over this nest (POST /nests/:id/chat).
 * Nothing the agent says about itself is trusted to decide this: the row's
 * nest and user are the authenticated facts. The onboarding tools themselves
 * (context_onboarding polls this proof) are not in READ_PROOF_TOOLS, and the
 * /onboarding REST routes are not traced, so checking never proves itself.
 * Which agent read is self-reported (`client`); the UI names the tile's agent
 * only when `client` matches it, and says "An agent read your nest" otherwise.
 */
export async function connectionEvidence(userId: string, nestId: string, since?: string | null): Promise<ConnectionEvidence> {
  const after = since && !Number.isNaN(Date.parse(since)) ? new Date(Date.parse(since)).toISOString() : "1970-01-01T00:00:00.000Z";
  const placeholders = READ_PROOF_TOOLS.map(() => "?").join(", ");
  const contentPlaceholders = CONTENT_READ_PATHS.map(() => "?").join(", ");
  const rows = (await getDb().all(
    `SELECT ts, kind, method, path, tool, client_json FROM api_events
      WHERE nest_id = ? AND user_id = ? AND ts >= ? AND status < 400
        AND (
          (kind = 'mcp' AND tool IN (${placeholders}))
          OR (kind = 'api' AND method = 'POST' AND path = ?)
          OR (kind = 'api' AND client_json IS NOT NULL AND method = 'GET' AND (path IN (${contentPlaceholders}) OR path LIKE ?))
        )
      ORDER BY ts DESC LIMIT 1`,
    [nestId, userId, after, ...READ_PROOF_TOOLS, `/nests/${nestId}/chat`, ...CONTENT_READ_PATHS.map((p) => `/nests/${nestId}/${p}`), `/nests/${nestId}/nodes/%`],
  )) as Array<{ ts: string; kind: string; method: string | null; path: string | null; tool: string | null; client_json: string | null }>;
  const hit = rows[0];
  if (!hit) return { connected: false, at: null, via: null, client: null, tool: null };
  const client = deserializeClient(hit.client_json);
  const via = hit.kind === "mcp" ? "mcp" : hit.path === `/nests/${nestId}/chat` ? "hootie" : "api";
  return {
    connected: true,
    at: hit.ts,
    via,
    client: via === "hootie" ? "Hootie" : (client?.agent ?? null),
    tool: hit.tool,
  };
}
