/**
 * App-wide unread (team chat harness C2, PO-1197): `GET /me/chat/unread`,
 * the `chat` section of My Work and of `context_my_work`.
 *
 * Per nest the caller is a person on (with chat on there): the channels they
 * can read and the conversations they are in, each with its unread (messages
 * by others since their mark — the same number the channel list shows), and
 * the open @mentions of theirs in chat containers; summed per nest and in
 * total. One aggregate query per nest over the message index; the channel
 * set comes from the cached document listing, as the channel list's does.
 */
import { config } from "../config.js";
import { engineCache } from "../nodes/engine.js";
import { filterAccessible } from "../governance/access-guard.js";
import { listVisibleNests } from "../nests/service.js";
import { listOpenMentions } from "../mentions/mention-index.js";
import { ARCHIVED_TAG, channelNameOf, hasTag, isChannelDoc, isChannelId } from "../channels/channel-node.js";
import { channelStats, isNestMember } from "../channels/channel-service.js";
import { isConversationId, memberContainers } from "./containers.js";
import { nestChatEnabled } from "./settings.js";

export interface ChatUnread {
  total: number;
  mentions: number;
  nests: Array<{
    nest_id: string;
    nest_name: string;
    unread: number;
    mentions: number;
    channels: Array<{ id: string; name: string; unread: number }>;
    conversations: Array<{ id: string; unread: number }>;
  }>;
}

/** A summary is served from memory for this long per person. The dashboard
 *  polls it from every open tab, and on a Cloud Storage mount one build can
 *  take minutes, so the TTL matches the document-discovery cache
 *  (DISCOVERY_TTL_MS in nodes/engine.ts). */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; value: ChatUnread }>();
/** The build in flight per key. Concurrent polls join it instead of each
 *  starting their own: without this, every poll that arrived during a slow
 *  build started another one, and together they filled every request slot. */
const inflight = new Map<string, Promise<ChatUnread>>();

export async function chatUnreadSummary(params: {
  userId: string;
  email: string;
  onlyNestId?: string | null;
  actingAs?: string | null;
}): Promise<ChatUnread> {
  const out: ChatUnread = { total: 0, mentions: 0, nests: [] };
  if (!config.TEAM_CHAT_ENABLED) return out;
  const { userId, email } = params;
  const cacheKey = `${userId}\u0000${params.onlyNestId ?? ""}\u0000${params.actingAs ?? ""}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.at > Date.now() - CACHE_MS) return hit.value;
  if (cache.size > 2000) for (const [k, v] of cache) if (v.at <= Date.now() - CACHE_MS) cache.delete(k);
  const running = inflight.get(cacheKey);
  if (running) return running;
  const run = build(params, out)
    .then((value) => {
      cache.set(cacheKey, { at: Date.now(), value });
      return value;
    })
    .finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, run);
  return run;
}

/** Tests only. */
export function _resetUnreadCache(): void {
  cache.clear();
  inflight.clear();
}

async function build(
  params: { userId: string; email: string; onlyNestId?: string | null; actingAs?: string | null },
  out: ChatUnread,
): Promise<ChatUnread> {
  const { userId, email } = params;
  // Every nest at once, not one after another: the per-nest checks are
  // independent, and in sequence their latencies added up per visible nest.
  const visible = (await listVisibleNests(userId)).filter((n) => !params.onlyNestId || n.id === params.onlyNestId);
  const eligible = await Promise.all(
    visible.map(async (n) => (await nestChatEnabled(n.id)) && (await isNestMember(n.id, userId))),
  );
  const nestNames = new Map<string, string>();
  visible.forEach((n, i) => {
    if (eligible[i]) nestNames.set(n.id, n.name ?? n.id);
  });
  if (nestNames.size === 0) return out;

  // Open mentions in chat containers, per nest (access-checked by the index read).
  const mentionsByNest = new Map<string, number>();
  const mentions = (await listOpenMentions({ userId, email, nestNames, actingAs: params.actingAs ?? null })).items;
  for (const m of mentions) {
    if (!isChannelId(m.node_id) && !isConversationId(m.node_id)) continue;
    mentionsByNest.set(m.nest_id, (mentionsByNest.get(m.nest_id) ?? 0) + 1);
  }

  const perNest = await Promise.all([...nestNames].map(async ([nestId, nestName]) => {
    const caller = { nestId, userId, userEmail: email };
    let channelIds: string[] = [];
    try {
      const { storage } = await engineCache.get(nestId);
      const docs = (await storage.discoverDocuments()).filter((d) => isChannelDoc(d) && !hasTag(d, ARCHIVED_TAG));
      channelIds = (await filterAccessible(nestId, userId, email, docs)).map((d) => d.id);
    } catch {
      channelIds = [];
    }
    const convIds = [...(await memberContainers(nestId, userId))].filter(isConversationId);
    const stats = await channelStats(caller, [...channelIds, ...convIds]);
    const channels = channelIds.map((id) => ({ id, name: channelNameOf(id) ?? id, unread: stats.get(id)?.unread ?? 0 }));
    const conversations = convIds.map((id) => ({ id, unread: stats.get(id)?.unread ?? 0 }));
    const unread = [...channels, ...conversations].reduce((s, c) => s + c.unread, 0);
    const mentions = mentionsByNest.get(nestId) ?? 0;
    return { nest_id: nestId, nest_name: nestName, unread, mentions, channels, conversations };
  }));
  // Promise.all keeps input order, so the nests list in the same order as before.
  for (const n of perNest) {
    out.nests.push(n);
    out.total += n.unread;
    out.mentions += n.mentions;
  }
  return out;
}

/** One line per nest, for an agent. */
export function chatUnreadText(u: ChatUnread): string {
  if (u.nests.length === 0) return "\n## Chat\nNo chat anywhere you are a member.";
  const lines = u.nests.map((n) => {
    const chans = n.channels.filter((c) => c.unread).map((c) => `#${c.name} ${c.unread}`);
    const convs = n.conversations.filter((c) => c.unread).map((c) => `dm ${c.id.split("/").pop()} ${c.unread}`);
    const detail = [...chans, ...convs].join(", ");
    return `- ${n.nest_name}: ${n.unread} unread, ${n.mentions} mention${n.mentions === 1 ? "" : "s"}${detail ? ` (${detail})` : ""}`;
  });
  return `\n## Chat (${u.total} unread, ${u.mentions} mentions)\n${lines.join("\n")}\nRead what is new with context_channel_read { channel, since } or context_conversation_read { conversation, since }.`;
}
