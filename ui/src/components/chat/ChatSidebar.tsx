/**
 * The harness sidebar (PO-1200, AC-C3-02, AC-C3-15): a search box that
 * filters channels and conversations and searches messages, Channels by
 * latest activity with unread counts (a lock for private ones) and archived
 * ones folded away, Direct messages with who is around, Saved, and my open
 * Mentions in this nest. The same component is the phone's sheet.
 */
import { useState, type ReactNode } from "react";
import { Archive, AtSign, Bookmark, ChevronRight, Hash, Lock, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChannelSummary, MentionItem } from "../../lib/api";
import { unreadLabel } from "../../lib/channels";
import { orderConversations } from "../../lib/chat-harness";
import type { Seam } from "../../lib/chat-seams";
import { filterChannels, orderByActivity } from "../../lib/chat-sidebar";
import { relTime } from "../../lib/dates";
import { plainExcerpt } from "../../lib/plain-excerpt";
import { mentionPlace } from "../../lib/my-work-inbox";
import { mentionAuthor } from "../my-work/MentionRows";
import { ConversationIcon } from "./Presence";

export function UnreadBadge({ count, className }: { count: number; className?: string }) {
  const label = unreadLabel(count);
  if (!label) return null;
  return (
    <span className={cn("min-w-5 rounded-full bg-primary px-1.5 text-center text-[11px] font-semibold leading-5 text-primary-foreground", className)} aria-label={`${count} unread`} data-testid="channel-unread">
      {label}
    </span>
  );
}

function Section({ title, action, children, testId }: { title: string; action?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div className="px-2 pt-4 first:pt-2" data-testid={testId}>
      <div className="flex h-6 items-center justify-between px-2">
        <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
        {action}
      </div>
      <div className="mt-0.5 space-y-px">{children}</div>
    </div>
  );
}

const ROW = "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export interface ChatSidebarProps {
  nestId: string;
  channels: ChannelSummary[];
  archived: ChannelSummary[];
  selected: string | null;
  canManage: boolean;
  mentions: MentionItem[];
  /** The signed-in person, so "@their@address" in an excerpt reads as their name. */
  viewer?: { email: string; name: string | null } | null;
  onSelect: (name: string) => void;
  onNew: () => void;
  onRestore: (channel: ChannelSummary) => void;
  onOpenMention: (m: MentionItem) => void;
  /** Saved items, when C1's contract is on this base. */
  saved?: Seam<{ count: number; onOpen: () => void; open: boolean }>;
  /** The search box's second job once C1 lands: message search. */
  onSearchMessages?: (query: string) => void;
  /** C2: my direct and group messages here (rows read as channels, key `~uuid`),
   *  who is around, and "New message". Absent while the nest's chat is off. */
  dms?: Seam<{ rows: ChannelSummary[]; online: ReadonlySet<string>; onNew: () => void }>;
}

export function ChatSidebar(p: ChatSidebarProps) {
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const dms = p.dms;
  const dmRows = dms?.available ? filterDms(dms.rows, query) : [];
  const live = filterChannels(orderByActivity(p.channels), query);
  const archived = filterChannels(p.archived, query);
  // An archived channel that is open shows its section, so the highlight is visible.
  const archivedOpen = showArchived || archived.some((c) => c.name === p.selected) || (!!query && archived.length > 0);

  return (
    <nav className="flex h-full min-h-0 flex-col" aria-label="Chat" data-testid="chat-sidebar">
      <div className="px-3 pt-3">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && p.onSearchMessages && query.trim().length >= 2) p.onSearchMessages(query.trim());
            }}
            placeholder={p.onSearchMessages ? "Search" : "Find a channel"}
            aria-label={p.onSearchMessages ? "Search channels and messages" : "Find a channel"}
            data-testid="chat-search"
            className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </label>
        {p.onSearchMessages && query.trim().length >= 2 && (
          <button type="button" onClick={() => p.onSearchMessages!(query.trim())} className="mt-1 flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-muted" data-testid="chat-search-messages">
            <Search className="h-3 w-3" aria-hidden /> Search messages for “{query.trim()}” <kbd className="ml-auto font-sans">Enter</kbd>
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <Section
          title="Channels"
          testId="chat-channels"
          action={
            p.canManage && (
              <button type="button" onClick={p.onNew} aria-label="New channel" title="New channel" data-testid="channel-new" className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
                <Plus className="h-3.5 w-3.5" aria-hidden />
              </button>
            )
          }
        >
          {live.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">{query ? "No channel matches." : "No channels yet."}</p>
          )}
          {live.map((c) => {
            const active = c.name === p.selected;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => p.onSelect(c.name)}
                aria-current={active ? "page" : undefined}
                className={cn(ROW, active ? "bg-muted font-medium" : c.unread > 0 && "font-semibold text-foreground")}
                data-testid="channel-row"
              >
                {c.private ? (
                  <Lock className={cn("h-3.5 w-3.5 shrink-0", active ? "text-foreground" : "text-muted-foreground")} aria-label="Private" />
                ) : (
                  <Hash className={cn("h-3.5 w-3.5 shrink-0", active ? "text-foreground" : "text-muted-foreground")} aria-hidden />
                )}
                <span className="truncate">{c.name}</span>
                {!active && <UnreadBadge count={c.unread} className="ml-auto" />}
              </button>
            );
          })}
          {archived.length > 0 && (
            <div className="pt-1" data-testid="channel-archived">
              <button
                type="button"
                onClick={() => setShowArchived(!archivedOpen)}
                aria-expanded={archivedOpen}
                className={cn(ROW, "h-7 text-xs text-muted-foreground")}
              >
                <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", archivedOpen && "rotate-90")} aria-hidden />
                Archived ({archived.length})
              </button>
              {archivedOpen &&
                archived.map((c) => {
                  const active = c.name === p.selected;
                  return (
                    <div key={c.id} className="group flex items-center">
                      <button type="button" onClick={() => p.onSelect(c.name)} aria-current={active ? "page" : undefined} className={cn(ROW, "text-muted-foreground", active && "bg-muted font-medium text-foreground")}>
                        <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        <span className="truncate">{c.name}</span>
                      </button>
                      {p.canManage && (
                        <button type="button" onClick={() => p.onRestore(c)} aria-label={`Restore ${c.title}`} className="shrink-0 rounded px-1.5 text-xs font-medium text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100">
                          Restore
                        </button>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </Section>

        {dms?.available && (
          <Section
            title="Direct messages"
            testId="chat-dms"
            action={
              <button type="button" onClick={dms.onNew} aria-label="New message" title="New message" data-testid="dm-new" className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
                <Plus className="h-3.5 w-3.5" aria-hidden />
              </button>
            }
          >
            {dmRows.length === 0 && (
              <button type="button" onClick={dms.onNew} className={cn(ROW, "text-xs text-muted-foreground")}>
                {query ? "No conversation matches." : "Message a teammate or an agent"}
              </button>
            )}
            {dmRows.map((c) => {
              const active = c.name === p.selected;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => p.onSelect(c.name)}
                  aria-current={active ? "page" : undefined}
                  className={cn(ROW, active ? "bg-muted font-medium" : c.unread > 0 && "font-semibold text-foreground")}
                  data-testid="dm-row"
                >
                  {c.conversation && <ConversationIcon conversation={c.conversation} me={p.viewer?.email ?? null} online={dms.online} />}
                  <span className="truncate">{c.title}</span>
                  {!active && <UnreadBadge count={c.unread} className="ml-auto" />}
                </button>
              );
            })}
          </Section>
        )}

        {p.saved?.available && (
          <Section title="Saved" testId="chat-saved">
            <button type="button" onClick={p.saved.onOpen} aria-current={p.saved.open ? "page" : undefined} className={cn(ROW, p.saved.open && "bg-muted font-medium")}>
              <Bookmark className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">Saved messages</span>
              {p.saved.count > 0 && <span className="ml-auto text-xs text-muted-foreground">{p.saved.count}</span>}
            </button>
          </Section>
        )}

        <Section title="Mentions" testId="chat-mentions">
          {p.mentions.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">Nothing waiting on you here.</p>
          ) : (
            p.mentions.map((m) => (
              <button key={`${m.nest_id}:${m.thread_id}`} type="button" onClick={() => p.onOpenMention(m)} className={cn(ROW, "h-auto items-start py-1.5")} data-testid="chat-mention">
                <AtSign className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 truncate text-sm font-medium">{mentionAuthor(m)}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{relTime(m.mentioned_at)}</span>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {mentionPlace(m)}
                    {" · "}
                    {plainExcerpt(m.excerpt, [...(p.viewer ? [p.viewer] : []), { email: m.author, name: m.author_name }])}
                  </span>
                </span>
              </button>
            ))
          )}
        </Section>

      </div>
    </nav>
  );
}

/** Conversations whose title contains every word typed, latest first. */
function filterDms(rows: readonly ChannelSummary[], query: string): ChannelSummary[] {
  const words = query.toLowerCase().replace(/^[#@]+/, "").split(/\s+/).filter(Boolean);
  const ordered = orderConversations(rows);
  return words.length ? ordered.filter((c) => words.every((w) => c.title.toLowerCase().includes(w))) : ordered;
}
