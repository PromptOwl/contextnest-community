/**
 * The rules behind the C2 screens of the harness (PO-1200, contract
 * PO-1197), as plain functions: who sees chat at all, what a conversation
 * offers next to a channel, direct messages, the members panel, the channel
 * menu, and the first-run explainer. The components read one answer each.
 */
import type { ChannelSummary, ChatMember, ConversationView } from "./api";

// ─── Who sees chat ───────────────────────────────────────────────────────

/**
 * Chat shows when the nest says so: `GET /nests/:id` carries `chat` (the
 * server switch, the nest's own setting, and membership, in one answer). An
 * older server without the field falls back to switch and membership.
 */
export function chatOn(meta: { chat?: boolean; member?: boolean } | null | undefined, streamOn: boolean): boolean {
  if (!meta) return false;
  if (typeof meta.chat === "boolean") return meta.chat;
  return streamOn && meta.member === true;
}

// ─── What a container offers ─────────────────────────────────────────────

/** The C1 message routes are addressed by channel name and answer 404 in a
 *  conversation (API.md), so a conversation offers none of them. */
export function messageFeatures(channel: Pick<ChannelSummary, "conversation"> | null | undefined): {
  messageActions: boolean;
  pins: boolean;
  broadcast: boolean;
} {
  const on = !!channel && !channel.conversation;
  return { messageActions: on, pins: on, broadcast: on };
}

// ─── Direct messages ─────────────────────────────────────────────────────

/** The one other member of a dm (for its presence dot and avatar). */
export function dmPeer(c: Pick<ConversationView, "kind" | "members">, me: string | null): ChatMember | null {
  if (c.kind !== "dm") return null;
  const mine = (me ?? "").toLowerCase();
  return c.members.find((m) => m.kind === "agent" || m.email.toLowerCase() !== mine) ?? null;
}

/** Latest activity first; one with none after the rest; ties by title. */
export function orderConversations<C extends Pick<ConversationView, "title" | "last_activity_at">>(rows: readonly C[]): C[] {
  return [...rows].sort((a, b) => {
    const ta = a.last_activity_at ?? "";
    const tb = b.last_activity_at ?? "";
    if (ta !== tb) return ta > tb ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

/** How a member is named to the server: a person by email, an agent by @handle. */
export function memberSpec(m: { kind: "person"; email: string } | { kind: "agent"; handle: string }): string {
  return m.kind === "agent" ? `@${m.handle}` : m.email;
}

// ─── Members panel ───────────────────────────────────────────────────────

export interface MemberRow {
  key: string;
  kind: "person" | "agent";
  label: string;
  /** The login, for a person. */
  email: string | null;
  online: boolean;
  you: boolean;
}

/** Who is around first, then people by name, then agents by handle. */
export function memberRows(members: readonly ChatMember[], online: ReadonlySet<string>, me: string | null): MemberRow[] {
  const mine = (me ?? "").toLowerCase();
  const rows: MemberRow[] = members.map((m) =>
    m.kind === "agent"
      ? { key: `agent:${m.handle}`, kind: "agent", label: `@${m.handle}`, email: null, online: false, you: false }
      : {
          key: `person:${m.email.toLowerCase()}`,
          kind: "person",
          label: m.name || m.email,
          email: m.email,
          online: online.has(m.email.toLowerCase()),
          you: m.email.toLowerCase() === mine,
        },
  );
  const rank = (r: MemberRow) => (r.kind === "agent" ? 2 : r.online ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

/** The panel's count line: the joined, and the full reach when it is wider. */
export function membersSummary(joined: readonly MemberRow[], others: readonly MemberRow[]): string {
  const around = [...joined, ...others].filter((r) => r.online).length;
  const count = others.length
    ? `${joined.length + others.length} with access · ${joined.length} joined`
    : `${joined.length} ${joined.length === 1 ? "member" : "members"}`;
  return around ? `${count} · ${around} around now` : count;
}

// ─── The channel menu ────────────────────────────────────────────────────

export type ChannelMenuItem = "notifications" | "members" | "make-private" | "make-public" | "join" | "leave" | "archive" | "restore";

/**
 * What the header's menu offers for this container. A dm can't be left (the
 * server answers 409); a group can. Making a channel private or public is
 * the nest's owner or an admin; archive and restore are writers.
 */
export function channelMenu(
  c: Pick<ChannelSummary, "private" | "member" | "archived" | "conversation">,
  who: { canManage: boolean; isAdmin: boolean },
): ChannelMenuItem[] {
  if (c.conversation) return c.conversation.kind === "group" ? ["notifications", "members", "leave"] : ["notifications", "members"];
  if (c.archived) return who.canManage ? ["members", "restore"] : ["members"];
  const out: ChannelMenuItem[] = ["notifications", "members"];
  if (who.isAdmin) out.push(c.private ? "make-public" : "make-private");
  out.push(c.member === false && !c.private ? "join" : "leave");
  if (who.canManage) out.push("archive");
  return out;
}

// ─── First-run explainer ─────────────────────────────────────────────────

type Store = { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void };

export const INTRO_KEY = (email: string) => `chat-intro-seen:${email.toLowerCase()}`;

/** Seen before? When storage can't be read, say yes: no nagging. */
export function introSeen(store: Store | null | undefined, email: string): boolean {
  if (!store) return true;
  try {
    return store.getItem(INTRO_KEY(email)) === "1";
  } catch {
    return true;
  }
}

export function markIntroSeen(store: Store | null | undefined, email: string): void {
  try {
    store?.setItem(INTRO_KEY(email), "1");
  } catch {
    /* a blocked store: it shows again next time, nothing worse */
  }
}

/** `window.localStorage`, or null where reading it throws. */
export function browserStore(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

// ─── Finding chat (entries and badges) ───────────────────────────────────

type UnreadSummary = { total: number; mentions: number; nests: Array<{ nest_id: string; nest_name: string; unread: number; mentions: number }> };

/**
 * This nest's chat entry, from `GET /me/chat/unread`: the summary lists a
 * nest exactly when chat is on there and the caller is a member, so it is
 * both the gate and the badge, in one read for every nest.
 */
export function nestChat(summary: UnreadSummary | undefined | null, nestId: string): { unread: number; mentions: number } | null {
  const n = summary?.nests.find((x) => x.nest_id === nestId);
  return n ? { unread: n.unread, mentions: n.mentions } : null;
}

/** Where the rail's Chat goes: the nest on screen when it has chat, else
 *  where my mentions wait, else the most unread, else the first. */
export function railChatTarget(summary: UnreadSummary | undefined | null, currentNestId: string | null): { nestId: string; nestName: string } | null {
  const nests = summary?.nests ?? [];
  if (!nests.length) return null;
  const pick =
    nests.find((n) => n.nest_id === currentNestId) ??
    [...nests].sort((a, b) => b.mentions - a.mentions || b.unread - a.unread)[0];
  return { nestId: pick.nest_id, nestName: pick.nest_name };
}

/** The badge on an entry: mentions (they wait on me) before plain unread. */
export function chatBadge(c: { unread: number; mentions: number } | null | undefined): { count: number; tone: "mention" | "unread" } | null {
  if (!c) return null;
  if (c.mentions > 0) return { count: c.mentions, tone: "mention" };
  if (c.unread > 0) return { count: c.unread, tone: "unread" };
  return null;
}
