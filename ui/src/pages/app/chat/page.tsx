/**
 * Chat (/chat): one place to talk, across every nest or inside one (One chat).
 * The list on the left is drawn here; a conversation on the right is the same
 * ChatPage a nest uses, so posting, threads and access are the nest's own.
 * Updates is the document stream, Hootie its own panel drawn in place, and My
 * agents what the agents that write under my login have said.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { AtSign, Bot, Hash, MessageSquare, Plus, Rss } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import * as api from "../../../lib/api";
import { useAuth } from "../../../auth/AuthContext";
import { useAppNav } from "../../../lib/app-nav";
import { keyOfConversationId } from "../../../lib/chat-live";
import { relTime } from "../../../lib/dates";
import { chatRows, type ChatPlace, type ChatRow } from "../../../lib/one-chat";
import { plainExcerpt } from "../../../lib/plain-excerpt";
import { keys, reads } from "../../../lib/queries";
import { useChatSummary } from "../../../components/chat/ChatEntry";
import { UnreadBadge } from "../../../components/chat/ChatSidebar";
import { ChatPage } from "../../../components/chat/ChatPage";
import { DocStream } from "../../../components/DocStream";
import { HootiePanel } from "../../../components/HootiePanel";
import { MentionRows } from "../../../components/my-work/MentionRows";
import hootieIcon from "../../../assets/hootie.svg";

const PLACE_KEY = "chat-place";
const SCOPE_KEY = "chat-scope";
const stored = <T,>(key: string, fallback: T): T => {
  try {
    const v = window.sessionStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const keep = (key: string, value: unknown) => {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* a private window: the choice just isn't kept */
  }
};

function Row({ icon, label, sub, count, active, onClick, testId }: { icon: ReactNode; label: string; sub?: string; count?: number; active: boolean; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      data-testid={testId}
      className={cn(
        "flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        active && "bg-primary/10 font-medium text-primary hover:bg-primary/10",
        !!count && !active && "font-semibold",
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      <span className="truncate">{label}</span>
      {sub && <span className="truncate text-xs font-normal text-muted-foreground">{sub}</span>}
      {/* What is open is being read: its count would only lag behind. */}
      <UnreadBadge count={active ? 0 : (count ?? 0)} className="ml-auto" />
    </button>
  );
}

const ICON = "h-4 w-4";

export default function ChatHome() {
  const { openReview, openNest } = useAppNav();
  const { adminStatus, hootieEnabled, hootieBrand, runnerKeyConfigured, isAdmin, docStreamEnabled, agentStreamEnabled } = useAuth();
  const qc = useQueryClient();
  const summary = useChatSummary();
  const nests = summary.data?.nests ?? [];
  const [scope, setScopeState] = useState<string>(() => stored(SCOPE_KEY, "all"));
  const setScope = (s: string) => {
    setScopeState(s);
    keep(SCOPE_KEY, s);
  };
  const hootie = hootieEnabled && (runnerKeyConfigured || isAdmin);
  const [place, setPlaceState] = useState<ChatPlace | null>(() => stored<ChatPlace | null>(PLACE_KEY, null));
  const setPlace = (p: ChatPlace) => {
    setPlaceState(p);
    keep(PLACE_KEY, p);
  };
  const [query, setQuery] = useState("");
  // Conversations carry the other members' names, which the summary does not.
  const convReads = useQueries({
    queries: nests.filter((n) => n.conversations.length > 0).map((n) => ({ ...reads.conversations(n.nest_id), refetchInterval: 30_000, retry: false })),
  });
  const withConvs = nests.filter((n) => n.conversations.length > 0);
  const convMap = useMemo(
    () => new Map(withConvs.map((n, i) => [n.nest_id, (convReads[i]?.data as { conversations?: api.ConversationView[] } | undefined)?.conversations ?? []])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [summary.data, convReads.map((r) => r.dataUpdatedAt).join()],
  );
  const scoped = scope !== "all" && nests.some((n) => n.nest_id === scope) ? scope : "all";
  const rows = useMemo(() => chatRows(summary.data, convMap, scoped, query), [summary.data, convMap, scoped, query]);
  const mentions = useQuery(reads.myMentions());
  const agents = useQuery({ ...reads.myAgents(), enabled: agentStreamEnabled, refetchInterval: 60_000 });
  const myMentions = (mentions.data?.mentions ?? []).filter((m) => scoped === "all" || m.nest_id === scoped);
  const myAgents = (agents.data?.threads ?? []).filter((t) => scoped === "all" || t.nest_id === scoped);
  // A reply waiting on me comes before my agents' own last words.
  const agentThreads = [...myAgents].sort((a, b) => Number(b.answered) - Number(a.answered));
  const [done, setDone] = useState<string | null>(null);

  // Where to land: the channel with something new, else the first, else Hootie, else Updates.
  const current: ChatPlace | null = place && (place.kind !== "channel" || nests.some((n) => n.nest_id === place.nestId)) ? place : null;
  useEffect(() => {
    if (current || summary.isLoading) return;
    const all = nests.flatMap((n) => n.channels.map((c) => ({ n, c })));
    const pick = all.find((x) => x.c.unread > 0) ?? all[0];
    if (pick) setPlaceState({ kind: "channel", nestId: pick.n.nest_id, nestName: pick.n.nest_name, channel: pick.c.name, thread: null });
    else if (hootie) setPlaceState({ kind: "hootie" });
    else if (docStreamEnabled) setPlaceState({ kind: "updates" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, summary.isLoading, summary.data]);

  const openRow = (r: ChatRow) => setPlace({ kind: "channel", nestId: r.nestId, nestName: r.nestName, channel: r.channel, thread: null });
  const openThread = (nestId: string, nestName: string, channel: string, thread: string) => setPlace({ kind: "channel", nestId, nestName, channel, thread });
  const openMention = (m: api.MentionItem) => {
    const conv = m.kind === "conversation" ? keyOfConversationId(m.node_id) : null;
    if (conv ?? m.channel) openThread(m.nest_id, m.nest_name, (conv ?? m.channel)!, m.thread_id);
    else openReview(m.nest_id, m.nest_name, m.node_id, { thread: m.thread_id });
  };
  const openAgentThread = (t: api.MyAgentThread) => {
    const channel = t.kind === "conversation" ? keyOfConversationId(t.node_id) : t.channel;
    if (channel) openThread(t.nest_id, t.nest_name, channel, t.thread_id);
    else openReview(t.nest_id, t.nest_name, t.node_id, { thread: t.thread_id });
  };
  const at = (kind: ChatPlace["kind"]) => current?.kind === kind;
  const answered = myAgents.filter((t) => t.answered).length;

  const list = (tools?: { newChannel: (() => void) | null; newMessage: (() => void) | null }) => (
    <nav className="flex h-full min-h-0 flex-col" aria-label="Chat" data-testid="one-chat-list">
      <div className="space-y-2 px-3 pt-3">
        {nests.length > 1 && (
          <select value={scoped} onChange={(e) => setScope(e.target.value)} aria-label="Nests shown" data-testid="one-chat-scope" className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm">
            <option value="all">All nests</option>
            {nests.map((n) => (
              <option key={n.nest_id} value={n.nest_id}>
                {n.nest_name}
              </option>
            ))}
          </select>
        )}
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a channel or person" aria-label="Find a channel or person" data-testid="one-chat-find" className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm placeholder:text-muted-foreground" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {!query && (
          <div className="space-y-px pt-2">
            {hootie && <Row testId="one-chat-hootie" icon={<img src={hootieBrand.logo_url || hootieIcon} alt="" referrerPolicy="no-referrer" className={ICON} />} label={hootieBrand.name} active={at("hootie")} onClick={() => setPlace({ kind: "hootie" })} />}
            {docStreamEnabled && <Row testId="one-chat-updates" icon={<Rss className={ICON} />} label="Updates" active={at("updates")} onClick={() => setPlace({ kind: "updates" })} />}
            <Row testId="one-chat-mentions" icon={<AtSign className={ICON} />} label="Mentions" count={myMentions.length} active={at("mentions")} onClick={() => setPlace({ kind: "mentions" })} />
            {agentStreamEnabled && <Row testId="one-chat-agents" icon={<Bot className={ICON} />} label="My agents" count={answered} active={at("agents")} onClick={() => setPlace({ kind: "agents" })} />}
          </div>
        )}
        {(rows.direct.length > 0 || tools?.newMessage) && (
          <Section title="Direct messages" action={tools?.newMessage ? { label: "New message", run: tools.newMessage } : null}>
            {rows.direct.map((r) => (
              <Row key={r.key} icon={<MessageSquare className={ICON} />} label={r.label} sub={scoped === "all" && nests.length > 1 ? r.nestName : undefined} count={r.unread} active={current?.kind === "channel" && current.nestId === r.nestId && current.channel === r.channel} onClick={() => openRow(r)} />
            ))}
          </Section>
        )}
        {rows.nests.map((n) => (
          <Section key={n.nestId} title={n.nestName} action={tools?.newChannel && current?.kind === "channel" && current.nestId === n.nestId ? { label: `New channel in ${n.nestName}`, run: tools.newChannel } : null}>
            {n.channels.map((r) => (
              <Row key={r.key} testId="one-chat-channel" icon={<Hash className={ICON} />} label={r.label} count={r.unread} active={current?.kind === "channel" && current.nestId === r.nestId && current.channel === r.channel} onClick={() => openRow(r)} />
            ))}
            {n.channels.length === 0 && !query && <p className="px-2 py-1 text-xs text-muted-foreground">No channels yet.</p>}
          </Section>
        ))}
        {summary.isError && (
          <p className="px-2 py-3 text-sm text-muted-foreground">
            Couldn&rsquo;t load your conversations.{" "}
            <button type="button" className="text-primary underline" onClick={() => void summary.refetch()}>
              Retry
            </button>
          </p>
        )}
        {rows.elsewhere > 0 && (
          <button type="button" onClick={() => setScope("all")} className="mt-3 px-2 text-xs text-muted-foreground hover:text-foreground">
            {rows.elsewhere} unread in other nests
          </button>
        )}
      </div>
    </nav>
  );

  if (current?.kind === "channel") {
    return (
      <div className="-mx-8 -my-6" data-testid="one-chat">
        <ChatPage
          key={current.nestId}
          nestId={current.nestId}
          nestName={current.nestName}
          onBack={() => {}}
          channel={current.channel}
          thread={current.thread}
          onLocation={(loc) => setPlace({ ...current, channel: loc.channel ?? current.channel, thread: loc.thread ?? null })}
          onOpenNode={(nodeId) => openReview(current.nestId, current.nestName, nodeId)}
          onOpenDocumentThread={(nodeId, thread) => openReview(current.nestId, current.nestName, nodeId, { thread })}
          sidebar={list}
        />
      </div>
    );
  }

  return (
    <div className="-mx-8 -my-6 flex flex-col md:h-[calc(100dvh-65px)] md:flex-row" data-testid="one-chat">
      <aside className="max-h-72 shrink-0 border-b bg-muted/20 md:max-h-none md:w-[16.5rem] md:border-b-0 md:border-r">{list()}</aside>
      <main className="min-h-0 min-w-0 flex-1">
        {at("hootie") && (
          <HootiePanel
            inline
            page={scoped === "all" ? null : { nestId: scoped, nestName: nests.find((n) => n.nest_id === scoped)!.nest_name }}
            onOpenNode={(nestId, nodeId) => openReview(nestId, nests.find((n) => n.nest_id === nestId)?.nest_name ?? "", nodeId)}
          />
        )}
        {at("updates") && (
          <Pane title="Updates" hint="What people and agents changed, in every nest you can read.">
            <DocStream key={scoped} pinnedNestId={scoped === "all" ? undefined : scoped} onOpen={(item, threadId) => openReview(item.nestId, item.nestName, item.nodeId, threadId ? { thread: threadId } : undefined)} />
          </Pane>
        )}
        {at("mentions") && (
          <Pane title="Mentions" hint="Open mentions of you. The same list as My Work.">
            {myMentions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{mentions.isLoading ? "Loading…" : mentions.isError ? "Couldn't load your mentions." : "No mentions waiting on you."}</p>
            ) : (
              <MentionRows
                mentions={myMentions}
                viewer={adminStatus?.me ?? null}
                loading={false}
                busyThread={done}
                onOpen={openMention}
                onPage={() => {}}
                onDone={async (m) => {
                  setDone(m.thread_id);
                  try {
                    await api.markMentionDone(m.thread_id);
                    await qc.invalidateQueries({ queryKey: keys.myWorkAll() });
                  } catch (e: any) {
                    toast.error(e?.message || "Could not mark the mention done");
                  } finally {
                    setDone(null);
                  }
                }}
              />
            )}
          </Pane>
        )}
        {at("agents") && (
          <Pane title="My agents" hint="What agents wrote under your name, in every nest you can read. Open one to answer it, or to talk to it with an @mention.">
            {agents.isError ? (
              <p className="text-sm text-muted-foreground">
                Couldn&rsquo;t load your agents.{" "}
                <button type="button" className="text-primary underline" onClick={() => void agents.refetch()}>
                  Retry
                </button>
              </p>
            ) : myAgents.length === 0 ? (
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>{agents.isLoading ? "Loading…" : "No agent has written in chat or comments under your name yet. Connect one to a nest and it shows here when it speaks."}</p>
                {!agents.isLoading && nests[0] && (
                  <Button size="sm" variant="outline" onClick={() => openNest(nests[0].nest_id, nests[0].nest_name, false, false)}>
                    Open {nests[0].nest_name}
                  </Button>
                )}
              </div>
            ) : (
              <ul className="max-w-3xl divide-y rounded-lg border" data-testid="my-agents">
                {agentThreads.map((t) => (
                  <li key={t.thread_id} className="flex items-start gap-3 px-4 py-3">
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                      <Bot className="h-4 w-4" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">
                        <span className="font-semibold">{t.agents.join(" and ")}</span>
                        <span className="ml-2 rounded border px-1 text-xs text-muted-foreground">for you</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {t.nest_name}
                          {t.channel ? `, #${t.channel}` : t.kind === "conversation" ? ", direct message" : ", document comment"} · {relTime(t.at)}
                        </span>
                      </p>
                      <p className="mt-0.5 break-words text-sm text-muted-foreground">{plainExcerpt(t.excerpt, [adminStatus?.me ?? null].flatMap((x) => (x ? [x] : [])) as any)}</p>
                    </div>
                    <Button size="sm" variant={t.answered ? "default" : "outline"} onClick={() => openAgentThread(t)} data-testid="my-agents-open">
                      {t.answered ? "Read the reply" : "Open"}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Pane>
        )}
        {!current && <p className="p-8 text-sm text-muted-foreground">{summary.isLoading ? "Loading chat…" : "Nothing to talk in yet. Ask a nest owner to add you, or to turn chat on."}</p>}
      </main>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action: { label: string; run: () => void } | null; children: ReactNode }) {
  return (
    <div className="pt-4">
      <div className="flex h-6 items-center justify-between px-2">
        <h3 className="truncate text-xs font-semibold text-muted-foreground">{title}</h3>
        {action && (
          <button type="button" onClick={action.run} aria-label={action.label} title={action.label} className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>
      <div className="mt-0.5 space-y-px">{children}</div>
    </div>
  );
}

function Pane({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b px-6 py-3">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
    </div>
  );
}
