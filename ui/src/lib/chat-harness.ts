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
