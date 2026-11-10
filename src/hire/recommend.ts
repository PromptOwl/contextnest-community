/**
 * Which agent would help this nest (PO-1201, team chat C10): the rows behind
 * each rule, gathered for ONE caller, then the pure rules (rules.ts).
 *
 * Never a model call: every recommendation is a count over rows that already
 * exist — unanswered questions, promotes, mentions that matched nobody,
 * failed wake-up deliveries, idle keys.
 *
 * What the caller sees is bounded by what they can read: the channel rules
 * (1–3) only look at the channels `listChannels` already filtered for them
 * (filterAccessible, members only), and evidence links point only there. The
 * webhook and key rules (4–5) read admin surfaces (delivery outcomes, other
 * people's keys), so they are computed only for the nest owner or an admin —
 * and, for a key, its own owner.
 *
 * Dismissals are the caller's own mark in `stream_marks` (kind
 * 'recommendation', ref = the recommendation id): the per-person store the
 * channel read mark already uses, so no table of its own.
 */
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { ValidationError } from "../shared/errors.js";
import { resolveNestAccess } from "../shared/access.js";
import { safeJson } from "../shared/json.js";
import { channelNameOf } from "../channels/channel-node.js";
import { knownAgents } from "../channels/message-meta.js";
import { listAgents } from "../metacognition/store.js";
import { metacognitionEnabled } from "../metacognition/manage.js";
import { inFolders } from "../metacognition/config.js";
import { HOOTIE_HANDLE, keyAgentRows, memberAccess, type HireCaller } from "./service.js";
import {
  MAX_RECOMMENDATIONS,
  FAILING_WINDOW,
  ruleFailingWebhooks,
  ruleIdleKeys,
  rulePromoteHotspots,
  ruleUnansweredQuestions,
  ruleUnmatchedMentions,
  type MentionRow,
  type PromoteRow,
  type QuestionThread,
  type Recommendation,
} from "./rules.js";

export type { Recommendation } from "./rules.js";

const DISMISS_KIND = "recommendation";
/** A recommendation id as the rules mint them. */
const REC_ID_RE = /^(hootie:unanswered|watcher:[a-z0-9][a-z0-9-]{0,62}|mention:[a-z0-9][a-z0-9._-]{0,62}|webhook-fix:[a-z0-9][a-z0-9._-]{0,62}|key-idle:[a-z0-9][a-z0-9._-]{0,62})$/;
/** Most rows one computation reads per rule. */
const SCAN = 500;

export interface ChannelRef {
  id: string;
  name: string;
}

async function dismissedIds(caller: HireCaller): Promise<Set<string>> {
  const rows = (await getDb().all(
    "SELECT ref FROM stream_marks WHERE user_id = ? AND nest_id = ? AND kind = ? AND subject = ''",
    [caller.userId, caller.nestId, DISMISS_KIND],
  )) as Array<{ ref: string }>;
  return new Set(rows.map((r) => r.ref));
}

const inList = (n: number) => Array(n).fill("?").join(", ");

async function questionThreads(nestId: string, channels: ChannelRef[]): Promise<QuestionThread[]> {
  if (channels.length === 0) return [];
  const nameOf = new Map(channels.map((c) => [c.id, c.name]));
  const rows = (await getDb().all(
    `SELECT t.id, t.node_id, t.created_at, t.status, c.body
       FROM annotation_threads t
       JOIN annotation_comments c ON c.thread_id = t.id
      WHERE t.nest_id = ? AND t.status = 'open' AND t.node_id IN (${inList(channels.length)})
        AND (SELECT COUNT(*) FROM annotation_comments x WHERE x.thread_id = t.id) = 1
      ORDER BY t.created_at DESC
      LIMIT ${SCAN}`,
    [nestId, ...channels.map((c) => c.id)],
  )) as Array<{ id: string; node_id: string; created_at: string; status: string; body: string }>;
  return rows.map((r) => ({ thread_id: r.id, channel: nameOf.get(r.node_id)!, body: r.body, created_at: r.created_at, replies: 0, status: r.status }));
}

async function promotes(nestId: string, channels: ChannelRef[]): Promise<PromoteRow[]> {
  if (channels.length === 0) return [];
  const nameOf = new Map(channels.map((c) => [c.id, c.name]));
  const db = getDb();
  const nodes = (await db.all(
    `SELECT node_id, title, updated_at, frontmatter_json FROM node_index
      WHERE nest_id = ? AND frontmatter_json LIKE '%"source_thread"%' ORDER BY updated_at DESC LIMIT ${SCAN}`,
    [nestId],
  )) as Array<{ node_id: string; title: string; updated_at: string | null; frontmatter_json: string }>;
  const parsed = nodes
    .map((r) => {
      const fm = safeJson(r.frontmatter_json) as any;
      const threadId = fm?.metadata?.source_thread?.thread_id;
      return typeof threadId === "string"
        ? { node_id: r.node_id, title: r.title || r.node_id, threadId, at: String(fm?.created_at ?? fm?.updated_at ?? r.updated_at ?? "") }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  if (parsed.length === 0) return [];
  const threadIds = [...new Set(parsed.map((p) => p.threadId))];
  const threads = (await db.all(
    `SELECT id, node_id FROM annotation_threads WHERE nest_id = ? AND id IN (${inList(threadIds.length)})`,
    [nestId, ...threadIds],
  )) as Array<{ id: string; node_id: string }>;
  const channelOfThread = new Map(threads.map((t) => [t.id, nameOf.get(t.node_id)]));
  return parsed
    .map((p) => ({ channel: channelOfThread.get(p.threadId), at: p.at, node_id: p.node_id, title: p.title }))
    .filter((p): p is PromoteRow => !!p.channel);
}

async function unmatchedMentions(nestId: string, channels: ChannelRef[]): Promise<MentionRow[]> {
  if (channels.length === 0) return [];
  const nameOf = new Map(channels.map((c) => [c.id, c.name]));
  const rows = (await getDb().all(
    `SELECT handle, node_id, thread_id, created_at FROM comment_mentions
      WHERE nest_id = ? AND mentioned_user_id IS NULL AND node_id IN (${inList(channels.length)})
      ORDER BY created_at DESC LIMIT ${SCAN}`,
    [nestId, ...channels.map((c) => c.id)],
  )) as Array<{ handle: string; node_id: string; thread_id: string; created_at: string }>;
  return rows.map((r) => ({ handle: r.handle.toLowerCase(), channel: nameOf.get(r.node_id)!, thread_id: r.thread_id, at: r.created_at }));
}

/** Handles that already answer to a name here: webhooks, declared agent
 *  labels, key agents, a hired Hootie, watchers. */
async function knownHandles(nestId: string): Promise<Set<string>> {
  const known = new Set<string>((await knownAgents(nestId)).map((a) => a.handle));
  for (const k of await keyAgentRows(nestId)) known.add(k.handle);
  const hootie = await getDb().get("SELECT 1 AS ok FROM hired_agents WHERE nest_id = ? AND kind = 'hootie'", [nestId]);
  if (hootie) known.add(HOOTIE_HANDLE);
  for (const a of await listAgents(nestId)) {
    const m = /^nodes\/agents\/(.+)$/.exec(a.node_id);
    if (m) known.add(m[1]);
  }
  return known;
}

async function webhookHealth(nestId: string): Promise<Array<{ handle: string; recent: Array<"ok" | "failed" | "pending"> }>> {
  const db = getDb();
  const hooks = (await db.all("SELECT handle FROM agent_webhooks WHERE nest_id = ?", [nestId])) as Array<{ handle: string }>;
  if (hooks.length === 0) return [];
  const rows = (await db.all(
    `SELECT handle, status FROM agent_wake_deliveries WHERE nest_id = ? ORDER BY created_at DESC LIMIT ${SCAN}`,
    [nestId],
  )) as Array<{ handle: string; status: string }>;
  const recent = new Map<string, Array<"ok" | "failed" | "pending">>();
  for (const r of rows) {
    const list = recent.get(r.handle) ?? [];
    if (list.length >= FAILING_WINDOW) continue;
    list.push(r.status === "sent" ? "ok" : r.status === "failed" ? "failed" : "pending");
    recent.set(r.handle, list);
  }
  return hooks.map((h) => ({ handle: h.handle, recent: recent.get(h.handle) ?? [] }));
}

/** Is some enabled watcher already reading this channel? */
async function watchedChannels(nestId: string): Promise<(channel: string) => boolean> {
  if (!metacognitionEnabled()) return () => true; // nothing to recommend when it can't be hired
  const scopes = (await listAgents(nestId)).filter((a) => a.enabled).map((a) => a.config.scope?.read ?? []);
  return (channel) => scopes.some((read) => inFolders(`nodes/channels/${channel}/x`, read));
}

/**
 * Every recommendation for this caller over these channels (the ones they
 * can read), dismissed ones removed, at most MAX_RECOMMENDATIONS.
 */
export async function computeRecommendations(caller: HireCaller, channels: ChannelRef[]): Promise<Recommendation[]> {
  const nestId = caller.nestId;
  const now = Date.now();
  const access = await resolveNestAccess(nestId, caller.userId);
  const adminLike = config.AUTH_MODE === "open" || access.rawPermission === "owner" || access.rawPermission === "admin";
  const dismissed = await dismissedIds(caller);
  const hootieHired = !!(await getDb().get("SELECT 1 AS ok FROM hired_agents WHERE nest_id = ? AND kind = 'hootie'", [nestId]));

  const out: Recommendation[] = [];
  if (config.HOOTIE_ENABLED) {
    const q = ruleUnansweredQuestions(await questionThreads(nestId, channels), { now, nestId, hootieHired });
    if (q) out.push(q);
  }
  out.push(...rulePromoteHotspots(await promotes(nestId, channels), { now, nestId, watched: await watchedChannels(nestId) }));
  out.push(...ruleUnmatchedMentions(await unmatchedMentions(nestId, channels), { nestId, known: await knownHandles(nestId) }));
  if (adminLike) out.push(...ruleFailingWebhooks(await webhookHealth(nestId), { nestId }));
  const keys = (await keyAgentRows(nestId)).filter((k) => adminLike || k.user_id === caller.userId);
  out.push(...ruleIdleKeys(keys, { now, nestId }));
  return out.filter((r) => !dismissed.has(r.id)).slice(0, MAX_RECOMMENDATIONS);
}

/** Open recommendations per channel name, for the channel list's badge. */
export async function recommendationCountsForChannels(caller: HireCaller, channels: ChannelRef[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const r of await computeRecommendations(caller, channels)) {
    for (const c of r.channels) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return counts;
}

export async function listRecommendations(caller: HireCaller): Promise<{ recommendations: Recommendation[] }> {
  await memberAccess(caller);
  // Loaded on use: channel-service imports this module for the badge.
  const { listChannels } = await import("../channels/channel-service.js");
  const { channels } = await listChannels(caller);
  return { recommendations: await computeRecommendations(caller, channels.map((c) => ({ id: c.id, name: channelNameOf(c.id) ?? c.name }))) };
}

export function parseRecommendationId(raw: unknown): string {
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!REC_ID_RE.test(id)) throw new ValidationError("id is a recommendation id as listed, e.g. mention:grok.");
  return id;
}

export async function dismissRecommendation(caller: HireCaller, rawId: unknown): Promise<{ dismissed: string }> {
  const id = parseRecommendationId(rawId);
  await memberAccess(caller);
  await getDb().run(
    `INSERT INTO stream_marks (user_id, nest_id, kind, ref, subject, at) VALUES (?, ?, ?, ?, '', ?)
     ON CONFLICT (user_id, nest_id, kind, ref, subject) DO UPDATE SET at = excluded.at`,
    [caller.userId, caller.nestId, DISMISS_KIND, id, new Date().toISOString()],
  );
  return { dismissed: id };
}
