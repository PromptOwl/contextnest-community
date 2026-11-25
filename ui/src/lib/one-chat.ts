/** Chat across every nest (One chat 2): what is open, and the rows. Pure. */
import type { ChatUnread, ConversationView } from "./api";
import { keyOfConversationId } from "./chat-live";

export type ChatPlace =
  | { kind: "hootie" }
  | { kind: "updates" }
  | { kind: "mentions" }
  | { kind: "agents" }
  | { kind: "channel"; nestId: string; nestName: string; channel: string; thread: string | null };

export interface ChatRow {
  key: string;
  nestId: string;
  nestName: string;
  /** A channel name, or a conversation's `~uuid` key. */
  channel: string;
  label: string;
  unread: number;
  kind: "channel" | "conversation";
}

/** The rows of one scope ("all", or one nest), filtered by what was typed. */
export function chatRows(
  summary: ChatUnread | undefined,
  conversations: ReadonlyMap<string, readonly ConversationView[]>,
  scope: string,
  query: string,
): { direct: ChatRow[]; nests: Array<{ nestId: string; nestName: string; channels: ChatRow[] }>; elsewhere: number } {
  const q = query.trim().toLowerCase().replace(/^[#@]/, "");
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  const direct: ChatRow[] = [];
  const nests: Array<{ nestId: string; nestName: string; channels: ChatRow[] }> = [];
  let elsewhere = 0;
  for (const n of summary?.nests ?? []) {
    if (scope !== "all" && n.nest_id !== scope) {
      elsewhere += n.unread;
      continue;
    }
    for (const c of conversations.get(n.nest_id) ?? []) {
      const key = keyOfConversationId(c.id);
      if (key && match(c.title)) direct.push({ key: `${n.nest_id}/${key}`, nestId: n.nest_id, nestName: n.nest_name, channel: key, label: c.title, unread: c.unread, kind: "conversation" });
    }
    const channels = n.channels
      .filter((c) => match(c.name))
      .sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || a.name.localeCompare(b.name))
      .map((c): ChatRow => ({ key: `${n.nest_id}/${c.name}`, nestId: n.nest_id, nestName: n.nest_name, channel: c.name, label: c.name, unread: c.unread, kind: "channel" }));
    if (channels.length || !q) nests.push({ nestId: n.nest_id, nestName: n.nest_name, channels });
  }
  direct.sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || a.label.localeCompare(b.label));
  return { direct, nests, elsewhere };
}
