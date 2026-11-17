/**
 * Channels — agent team stream S1 (PO-1179), experimental.
 *
 * A nest's channels on the left, the selected channel's timeline on the right:
 * top-level posts newest first, each with its reply count; a post opens its
 * thread inline. Agents post over MCP (`context_comment` with the channel's
 * id) and show as "<agent>, on behalf of <person>".
 *
 * Posting is write-tier on the server (a channel takes posts from the nest's
 * writers); readers get the timeline without a composer, the same rule as the
 * server rather than a form that would only be refused.
 *
 * Message bodies render as plain text (whitespace kept), never as HTML, so a
 * post cannot inject markup; @mentions are highlighted as text spans.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, Hash, Lightbulb, ListChecks, Loader2, MessageSquare, Plus, Send } from "lucide-react";
import { toast } from "sonner";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BetaBadge } from "@/components/ui/beta-badge";
import { NestPageHeader } from "./NestPageHeader";
import { deriveNestCaps, isNestArchived } from "../lib/nest-caps";
import { keys, reads } from "../lib/queries";
import * as api from "../lib/api";
import type { ChannelMessage } from "../lib/api";
import { readChannelDeepLink } from "../lib/channel-deep-link";
import { ArtifactCards } from "./ArtifactCards";

const PAGE_SIZE = 50;

interface Props {
  nestId: string;
  nestName: string;
  isArchived?: boolean;
  onBack: () => void;
}

/** "@name" runs as highlighted text; everything stays a text node. */
export function renderMentions(body: string): ReactNode[] {
  return body.split(/(@[\w.+-]+(?:@[\w-]+\.[\w.-]+)?)/g).map((part, i) =>
    part.startsWith("@") && part.length > 1 ? (
      <span key={i} className="font-medium text-primary">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function when(at: string): string {
  const iso = at.includes("T") ? at : `${at.replace(" ", "T")}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString();
}

function Message({ m, children }: { m: ChannelMessage; children?: ReactNode }) {
  return (
    <div className="py-2">
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className="font-medium">{m.actor.agent ?? m.actor.human}</span>
        {m.actor.agent && <span className="text-xs text-muted-foreground">on behalf of {m.actor.human}</span>}
        <span className="text-xs text-muted-foreground">{when(m.created_at)}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm">{renderMentions(m.body)}</p>
      <ArtifactCards cards={m.cards} />
      {children}
    </div>
  );
}

export function ChannelsPage({ nestId, nestName, isArchived, onBack }: Props) {
  const qc = useQueryClient();
  // A My Work mention deep-links here as ?channel=&thread= (PO-1180): open that
  // channel (archived ones listed too, so an archived channel's thread is reachable)
  // and thread. Read once, then dropped from the URL so refresh/Back don't reopen it.
  const [link] = useState(() => readChannelDeepLink(window.location.search));
  useEffect(() => {
    if (!link.channel) return;
    const u = new URL(window.location.href);
    u.searchParams.delete("channel");
    u.searchParams.delete("thread");
    window.history.replaceState(window.history.state, "", u);
  }, [link]);
  const [selected, setSelected] = useState<string | null>(link.channel);
  const [showArchived, setShowArchived] = useState(!!link.channel);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPurpose, setNewPurpose] = useState("");
  const [creating, setCreating] = useState(false);
  const [openThread, setOpenThread] = useState<string | null>(link.thread);
  const [replyDraft, setReplyDraft] = useState("");

  const nestQ = useQuery(reads.nest(nestId));
  const canWrite = useMemo(() => {
    const meta: any = nestQ.data;
    if (!meta) return false;
    const caps = deriveNestCaps({
      roles: meta.roles ?? [],
      permission: meta.permission ?? null,
      myStewards: meta.myStewards ?? [],
      isOwner: meta.permission === "owner",
      isAdmin: meta.permission === "admin",
      isArchived: isArchived || isNestArchived(meta.nest),
    });
    return caps.canManage || caps.collabCanWrite;
  }, [nestQ.data, isArchived]);

  const channelsQ = useQuery(reads.channels(nestId, showArchived));
  const channels = channelsQ.data?.channels ?? [];
  // The pick falls back to the first channel while none (or a vanished one) is selected.
  const current = channels.find((c) => c.name === selected) ?? channels[0] ?? null;

  const timelineQ = useInfiniteQuery({
    queryKey: keys.channelTimeline(nestId, current?.id ?? ""),
    queryFn: ({ pageParam }) => api.getChannelTimeline(nestId, current!.name, { limit: PAGE_SIZE, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.pagination.has_more ? last.pagination.offset + last.posts.length : undefined),
    enabled: !!current,
  });
  const posts = timelineQ.data?.pages.flatMap((p) => p.posts) ?? [];

  // A thread belongs to the selected channel; a deep-linked channel that is gone
  // (current fell back to another one) opens no thread.
  const thread = current && (!selected || current.name === selected) ? openThread : null;
  const threadQ = useQuery({
    ...reads.channelThread(nestId, current?.id ?? "", current?.name ?? "", thread ?? ""),
    enabled: !!thread,
  });
  // The open thread's post isn't on a loaded timeline page (an older deep-linked post).
  const offPagePost = thread && !posts.some((p) => p.id === thread) ? threadQ.data?.thread.post : undefined;
  const replies: ChannelMessage[] = threadQ.data?.thread.replies ?? [];

  const fail = (fallback: string) => (e: any) => toast.error(e?.message || fallback);
  // Post counts in the channel list move with every post.
  const refreshList = () => qc.invalidateQueries({ queryKey: [...keys.nest(nestId), "channels"] });

  const pick = (name: string) => {
    setSelected(name);
    setOpenThread(null);
  };

  const create = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const { channel } = await api.createChannel(nestId, { name: newName, purpose: newPurpose || undefined });
      setNewName("");
      setNewPurpose("");
      pick(channel.name);
    } catch (e) {
      fail("Could not create the channel")(e);
    } finally {
      setCreating(false);
    }
  };

  const send = async () => {
    if (!current || !draft.trim()) return;
    setSending(true);
    try {
      await api.createAnnotation(nestId, current.id, { body: draft, anchor: null });
      setDraft("");
      refreshList();
    } catch (e) {
      fail("Could not post")(e);
    } finally {
      setSending(false);
    }
  };

  const sendReply = async (threadId: string) => {
    if (!current || !replyDraft.trim()) return;
    try {
      await api.replyAnnotation(nestId, current.id, threadId, replyDraft);
      setReplyDraft("");
    } catch (e) {
      fail("Could not reply")(e);
    }
  };

  // Promote a thread to a decision or task node (PO-1181). Writers only —
  // the server refuses anyone else; the reply it posts shows in the thread.
  const promote = async (threadId: string, kind: "decision" | "task") => {
    if (!current) return;
    try {
      const r = await api.promoteThread(nestId, threadId, { kind });
      toast.success(`Promoted to a ${kind}: ${r.node.title}`);
      // The server's reply lands in the thread; drop the channel's timeline and threads.
      qc.invalidateQueries({ queryKey: keys.node(nestId, current.id) });
    } catch (e) {
      fail("Could not promote the thread")(e);
    }
  };

  const setArchived = async (archived: boolean) => {
    if (!current) return;
    try {
      await api.archiveChannel(nestId, current.name, archived);
      toast.success(`${current.title} ${archived ? "archived" : "restored"}`);
      if (archived && !showArchived) setSelected(null);
    } catch (e) {
      fail(`Could not ${archived ? "archive" : "restore"} the channel`)(e);
    }
  };

  const toggleThread = (id: string) => {
    setReplyDraft("");
    setOpenThread(openThread === id ? null : id);
  };

  return (
    <div className="px-4 py-4 md:px-6">
      <NestPageHeader nestName={nestName} onBack={onBack} title="Channels" badges={<BetaBadge />} />
      {channelsQ.isPending ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : channelsQ.error ? (
        <p className="text-sm text-destructive">{(channelsQ.error as Error).message || "Failed to load channels"}</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
          <aside className="min-w-0 space-y-3">
            <nav aria-label="Channels" className="space-y-0.5">
              {channels.length === 0 && <p className="text-sm text-muted-foreground">No channels yet.</p>}
              {channels.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => pick(c.name)}
                  aria-current={c.name === current?.name ? "page" : undefined}
                  className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm ${
                    c.name === current?.name ? "bg-muted font-medium" : "hover:bg-muted/60"
                  } ${c.archived ? "text-muted-foreground" : ""}`}
                >
                  <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{c.name}</span>
                  {c.archived && <span className="text-xs">(archived)</span>}
                  {c.post_count > 0 && <span className="ml-auto text-xs text-muted-foreground">{c.post_count}</span>}
                </button>
              ))}
            </nav>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
              Show archived channels
            </label>
            {canWrite && (
              <div className="space-y-2 border-t pt-3">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="new-channel"
                  aria-label="New channel name"
                />
                <Input
                  value={newPurpose}
                  onChange={(e) => setNewPurpose(e.target.value)}
                  placeholder="What it's for (optional)"
                  aria-label="New channel purpose"
                />
                <Button size="sm" variant="outline" onClick={create} disabled={creating || !newName.trim()} className="w-full">
                  <Plus className="mr-1 h-3.5 w-3.5" /> New channel
                </Button>
              </div>
            )}
          </aside>

          <section className="min-w-0">
            {!current ? (
              <p className="text-sm text-muted-foreground">
                {canWrite ? "Create a channel to start a conversation." : "Nothing to show yet."}
              </p>
            ) : (
              <>
                <div className="mb-3 flex items-start justify-between gap-3 border-b pb-3">
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold">{current.title}</h2>
                    {current.purpose && (
                      <p className="whitespace-pre-wrap text-sm text-muted-foreground">{current.purpose}</p>
                    )}
                  </div>
                  {canWrite &&
                    (current.archived ? (
                      <Button size="sm" variant="ghost" onClick={() => setArchived(false)} title="Unarchive channel">
                        <ArchiveRestore className="h-4 w-4" />
                      </Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => setArchived(true)} title="Archive channel">
                        <Archive className="h-4 w-4" />
                      </Button>
                    ))}
                </div>

                {current.archived && (
                  <p className="mb-4 text-sm text-muted-foreground">This channel is archived. Unarchive it to post again.</p>
                )}

                {canWrite && !current.archived && (
                  <div className="mb-4 flex gap-2">
                    <Textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
                      }}
                      placeholder={`Message ${current.title} — @name to tag someone`}
                      aria-label="Message"
                      rows={2}
                    />
                    <Button onClick={send} disabled={sending || !draft.trim()} aria-label="Post">
                      <Send className="h-4 w-4" />
                    </Button>
                  </div>
                )}

                {timelineQ.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : timelineQ.error ? (
                  <p className="text-sm text-destructive">{(timelineQ.error as Error).message || "Failed to load the channel"}</p>
                ) : posts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No posts yet.</p>
                ) : (
                  <ul className="divide-y">
                    {[...(offPagePost ? [offPagePost] : []), ...posts].map((p) => (
                      <li key={p.id}>
                        <Message m={p}>
                          <button
                            type="button"
                            onClick={() => toggleThread(p.id)}
                            className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                          >
                            <MessageSquare className="h-3.5 w-3.5" />
                            {p.reply_count ? `${p.reply_count} repl${p.reply_count === 1 ? "y" : "ies"}` : "Reply"}
                          </button>
                          {canWrite && (
                            <>
                              <button
                                type="button"
                                onClick={() => promote(p.id, "decision")}
                                className="ml-3 mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                                title="Turn this thread into a decision node that links back here"
                              >
                                <Lightbulb className="h-3.5 w-3.5" /> Decision
                              </button>
                              <button
                                type="button"
                                onClick={() => promote(p.id, "task")}
                                className="ml-3 mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                                title="Turn this thread into a task node that links back here"
                              >
                                <ListChecks className="h-3.5 w-3.5" /> Task
                              </button>
                            </>
                          )}
                          {thread === p.id && (
                            <div className="mt-2 border-l-2 pl-3">
                              {replies.map((r) => (
                                <Message key={r.id} m={r} />
                              ))}
                              {threadQ.isPending && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                              {threadQ.data?.thread.pagination.has_more && (
                                <p className="text-xs text-muted-foreground">
                                  Showing the first {replies.length} of {threadQ.data.thread.pagination.total} replies.
                                </p>
                              )}
                              {canWrite && !current.archived && (
                                <div className="mt-2 flex gap-2">
                                  <Input
                                    value={replyDraft}
                                    onChange={(e) => setReplyDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") sendReply(p.id);
                                    }}
                                    placeholder="Reply in thread"
                                    aria-label="Reply"
                                  />
                                  <Button size="sm" onClick={() => sendReply(p.id)} disabled={!replyDraft.trim()}>
                                    Reply
                                  </Button>
                                </div>
                              )}
                            </div>
                          )}
                        </Message>
                      </li>
                    ))}
                  </ul>
                )}
                {timelineQ.hasNextPage && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={() => timelineQ.fetchNextPage()}
                    disabled={timelineQ.isFetchingNextPage}
                  >
                    {timelineQ.isFetchingNextPage ? "Loading…" : "Load older posts"}
                  </Button>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
