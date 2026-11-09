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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Archive, Hash, Lightbulb, ListChecks, Loader2, MessageSquare, Plus, Send } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { BetaBadge } from "@/components/ui/beta-badge";
import { NestPageHeader } from "./NestPageHeader";
import { deriveNestCaps, isNestArchived } from "../lib/nest-caps";
import { reads } from "../lib/queries";
import * as api from "../lib/api";
import type { ChannelMessage, ChannelPost, ChannelSummary } from "../lib/api";
import { readChannelDeepLink } from "../lib/channel-deep-link";
import { ArtifactCards } from "./ArtifactCards";

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
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(() => readChannelDeepLink(window.location.search).channel);
  const [posts, setPosts] = useState<ChannelPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [canWrite, setCanWrite] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPurpose, setNewPurpose] = useState("");
  const [creating, setCreating] = useState(false);
  const [openThread, setOpenThread] = useState<string | null>(null);
  // A My Work mention's deep link (?channel=&thread=, PO-1180): select that
  // channel, and open that thread once its timeline has loaded.
  const [deepLink] = useState(() => readChannelDeepLink(window.location.search));
  const pendingThread = useRef<string | null>(deepLink.thread);
  const [replies, setReplies] = useState<ChannelMessage[]>([]);
  const [replyDraft, setReplyDraft] = useState("");

  const current = useMemo(() => channels.find((c) => c.name === selected) ?? null, [channels, selected]);

  useEffect(() => {
    let ignore = false;
    qc.fetchQuery(reads.nest(nestId))
      .then((meta: any) => {
        if (ignore) return;
        const caps = deriveNestCaps({
          roles: meta?.roles ?? [],
          permission: meta?.permission ?? null,
          myStewards: meta?.myStewards ?? [],
          isOwner: meta?.permission === "owner",
          isAdmin: meta?.permission === "admin",
          isArchived: isArchived || isNestArchived(meta?.nest),
        });
        setCanWrite(caps.canManage || caps.collabCanWrite);
      })
      .catch(() => !ignore && setCanWrite(false));
    return () => {
      ignore = true;
    };
  }, [nestId, qc, isArchived]);

  const loadChannels = useCallback(async () => {
    try {
      const { channels } = await api.listChannels(nestId);
      setChannels(channels);
      setSelected((s) => (s && channels.some((c) => c.name === s) ? s : channels[0]?.name ?? null));
    } catch (e: any) {
      toast.error(e?.message || "Failed to load channels");
    } finally {
      setLoading(false);
    }
  }, [nestId]);

  const loadTimeline = useCallback(async () => {
    if (!selected) {
      setPosts([]);
      return;
    }
    try {
      const t = await api.getChannelTimeline(nestId, selected, { limit: 100 });
      setPosts(t.posts);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load the channel");
    }
  }, [nestId, selected]);

  const loadThread = useCallback(
    async (threadId: string) => {
      if (!selected) return;
      try {
        const t = await api.getChannelThread(nestId, selected, threadId);
        setReplies(t.thread.replies);
      } catch (e: any) {
        toast.error(e?.message || "Failed to load the thread");
      }
    },
    [nestId, selected],
  );

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);
  useEffect(() => {
    setOpenThread(null);
    loadTimeline().then(() => {
      const t = pendingThread.current;
      if (!t || !selected || selected !== deepLink.channel) return;
      pendingThread.current = null;
      setOpenThread(t);
      setReplies([]);
      loadThread(t);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadTimeline]);

  const create = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const { channel } = await api.createChannel(nestId, { name: newName, purpose: newPurpose || undefined });
      setNewName("");
      setNewPurpose("");
      await loadChannels();
      setSelected(channel.name);
    } catch (e: any) {
      toast.error(e?.message || "Could not create the channel");
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
      await Promise.all([loadTimeline(), loadChannels()]);
    } catch (e: any) {
      toast.error(e?.message || "Could not post");
    } finally {
      setSending(false);
    }
  };

  const sendReply = async (threadId: string) => {
    if (!current || !replyDraft.trim()) return;
    try {
      await api.replyAnnotation(nestId, current.id, threadId, replyDraft);
      setReplyDraft("");
      await Promise.all([loadThread(threadId), loadTimeline()]);
    } catch (e: any) {
      toast.error(e?.message || "Could not reply");
    }
  };

  // Promote a thread to a decision or task node (PO-1181). Writers only —
  // the server refuses anyone else; the reply it posts shows in the thread.
  const promote = async (threadId: string, kind: "decision" | "task") => {
    try {
      const r = await api.promoteThread(nestId, threadId, { kind });
      toast.success(`Promoted to a ${kind}: ${r.node.title}`);
      await Promise.all([openThread === threadId ? loadThread(threadId) : Promise.resolve(), loadTimeline()]);
    } catch (e: any) {
      toast.error(e?.message || "Could not promote the thread");
    }
  };

  const archive = async () => {
    if (!current) return;
    try {
      await api.archiveChannel(nestId, current.name, true);
      toast.success(`${current.title} archived`);
      setSelected(null);
      await loadChannels();
    } catch (e: any) {
      toast.error(e?.message || "Could not archive the channel");
    }
  };

  const toggleThread = (id: string) => {
    if (openThread === id) {
      setOpenThread(null);
      return;
    }
    setOpenThread(id);
    setReplies([]);
    setReplyDraft("");
    loadThread(id);
  };

  return (
    <div className="px-4 py-4 md:px-6">
      <NestPageHeader nestName={nestName} onBack={onBack} title="Channels" badges={<BetaBadge />} />
      {loading ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : (
        <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
          <aside className="min-w-0 space-y-3">
            <nav aria-label="Channels" className="space-y-0.5">
              {channels.length === 0 && <p className="text-sm text-muted-foreground">No channels yet.</p>}
              {channels.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setSelected(c.name)}
                  aria-current={c.name === selected ? "page" : undefined}
                  className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm ${
                    c.name === selected ? "bg-muted font-medium" : "hover:bg-muted/60"
                  }`}
                >
                  <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{c.name}</span>
                  {c.post_count > 0 && <span className="ml-auto text-xs text-muted-foreground">{c.post_count}</span>}
                </button>
              ))}
            </nav>
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
                  {canWrite && (
                    <Button size="sm" variant="ghost" onClick={archive} title="Archive channel">
                      <Archive className="h-4 w-4" />
                    </Button>
                  )}
                </div>

                {canWrite && (
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

                {posts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No posts yet.</p>
                ) : (
                  <ul className="divide-y">
                    {posts.map((p) => (
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
                          {openThread === p.id && (
                            <div className="mt-2 border-l-2 pl-3">
                              {replies.map((r) => (
                                <Message key={r.id} m={r} />
                              ))}
                              {canWrite && (
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
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
