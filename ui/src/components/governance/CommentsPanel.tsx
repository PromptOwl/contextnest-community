import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  MessageSquare,
  CornerDownRight,
  Check,
  Loader2,
  Send,
  Pencil,
  FilePlus2,
  CheckCircle2,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import * as api from "@/lib/api";
import type { Comment, ActivityEntry, ActivityType } from "@/lib/api";

interface CommentsPanelProps {
  nestId: string;
  nodeId: string;
  currentEmail: string;
  /** Text the user had selected when opening — prefilled as the anchor quote. */
  quote?: string;
  /** Version the doc is currently on, pinned onto new comments. */
  version?: number;
}

function fmt(dateStr?: string) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? dateStr : d.toLocaleString();
}

// One comment plus its (already-sorted) replies.
interface Thread {
  root: Comment;
  replies: Comment[];
}

function buildThreads(comments: Comment[]): Thread[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const repliesByParent = new Map<string, Comment[]>();
  const roots: Comment[] = [];
  for (const c of comments) {
    if (c.parentId && byId.has(c.parentId)) {
      const arr = repliesByParent.get(c.parentId) ?? [];
      arr.push(c);
      repliesByParent.set(c.parentId, arr);
    } else {
      roots.push(c);
    }
  }
  return roots.map((root) => ({
    root,
    replies: repliesByParent.get(root.id) ?? [],
  }));
}

// Module-scope so their component identity is stable across renders. Defining
// them inside CommentsPanel made React treat each render's copy as a new type,
// remounting every row on each keystroke (e.g. the reply textarea lost focus).
function Avatar({ email }: { email: string }) {
  return (
    <div className="h-6 w-6 shrink-0 rounded-full bg-muted flex items-center justify-center text-[10px] font-semibold uppercase text-muted-foreground">
      {email?.[0] || "?"}
    </div>
  );
}

function CommentRow({
  c,
  isReply,
  currentEmail,
  onReply,
  onResolve,
}: {
  c: Comment;
  isReply?: boolean;
  currentEmail: string;
  onReply?: () => void;
  onResolve?: () => void;
}) {
  const mine = c.author?.toLowerCase() === currentEmail;
  return (
    <div className={isReply ? "pl-8" : ""}>
      <div className="flex items-start gap-2">
        {isReply && (
          <CornerDownRight className="h-3.5 w-3.5 mt-1.5 text-muted-foreground shrink-0" />
        )}
        <Avatar email={c.author} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">
              {c.author}
              {mine && (
                <span className="text-muted-foreground font-normal"> (you)</span>
              )}
            </span>
            <span className="text-xs text-muted-foreground">
              {fmt(c.createdAt)}
            </span>
            {c.status === "resolved" && (
              <Badge variant="outline" className="text-emerald-600 border-emerald-200">
                Resolved
              </Badge>
            )}
          </div>
          {c.anchor?.text && (
            <div className="mt-1 border-l-2 border-amber-300 bg-amber-50 px-2 py-1 text-xs italic text-amber-800 rounded-r">
              “{c.anchor.text}”
            </div>
          )}
          <p className="mt-1 text-sm whitespace-pre-wrap break-words">{c.body}</p>
          {!isReply && (
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={onReply}
              >
                <CornerDownRight className="h-3 w-3" /> Reply
              </button>
              {c.status !== "resolved" && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md border border-emerald-600 bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700"
                  onClick={onResolve}
                >
                  <Check className="h-3.5 w-3.5" /> Resolve
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const ACTIVITY_META: Record<
  ActivityType,
  { icon: typeof Pencil; verb: string; tone: string }
> = {
  comment: { icon: MessageSquare, verb: "commented", tone: "text-blue-600" },
  comment_resolved: { icon: Check, verb: "resolved a comment", tone: "text-emerald-600" },
  edit: { icon: Pencil, verb: "edited", tone: "text-foreground" },
  edit_proposed: { icon: FilePlus2, verb: "proposed an edit", tone: "text-amber-600" },
  review_requested: { icon: Clock, verb: "requested review", tone: "text-violet-600" },
  review_resolved: { icon: CheckCircle2, verb: "resolved a review", tone: "text-emerald-600" },
};

export function CommentsPanel({
  nestId,
  nodeId,
  currentEmail,
  quote,
  version,
}: CommentsPanelProps) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);

  // New top-level comment composer.
  const [draft, setDraft] = useState("");
  const [anchorText, setAnchorText] = useState(quote?.trim() || "");
  const [posting, setPosting] = useState(false);

  // Reply composer (one open at a time).
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");

  const reload = useCallback(async () => {
    try {
      const [c, a] = await Promise.all([
        api.getNodeComments(nestId, nodeId),
        api.getNodeActivity(nestId, nodeId),
      ]);
      setComments(c.comments);
      setActivity(a.activity);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load comments");
    } finally {
      setLoading(false);
    }
  }, [nestId, nodeId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    setAnchorText(quote?.trim() || "");
  }, [quote]);

  const threads = useMemo(() => {
    const visible = showResolved
      ? comments
      : comments.filter((c) => c.status !== "resolved");
    return buildThreads(visible);
  }, [comments, showResolved]);

  const openCount = comments.filter((c) => c.status !== "resolved").length;

  async function addComment() {
    const body = draft.trim();
    if (!body) return;
    setPosting(true);
    try {
      await api.createComment(nestId, nodeId, {
        body,
        version,
        // Text-only anchor: we have the quoted selection but not its document
        // character offsets yet (no editor offset mapping). Send just the text
        // rather than fabricating 0/length offsets. Real offsets are a TipTap
        // follow-up.
        anchor: anchorText ? { text: anchorText } : undefined,
      });
      setDraft("");
      setAnchorText("");
      await reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to add comment");
    } finally {
      setPosting(false);
    }
  }

  async function addReply(parentId: string) {
    const body = replyDraft.trim();
    if (!body) return;
    try {
      await api.createComment(nestId, nodeId, { body, parentId, version });
      setReplyTo(null);
      setReplyDraft("");
      await reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to reply");
    }
  }

  async function resolve(commentId: string) {
    try {
      await api.resolveComment(nestId, nodeId, commentId);
      await reload();
    } catch (e: any) {
      toast.error(e?.message || "Failed to resolve");
    }
  }

  return (
    <Tabs defaultValue="comments" className="flex flex-col">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="comments" className="gap-2">
          <MessageSquare className="h-4 w-4" />
          Comments
          {openCount > 0 && (
            <Badge variant="secondary" className="ml-1">
              {openCount}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="activity" className="gap-2">
          <Clock className="h-4 w-4" />
          Activity
        </TabsTrigger>
      </TabsList>

      {/* ── Comments ── */}
      <TabsContent value="comments" className="mt-3">
        {/* Composer */}
        <div className="border rounded-lg p-2 mb-3 bg-muted/20">
          {anchorText && (
            <div className="mb-2 flex items-start gap-2 border-l-2 border-amber-300 bg-amber-50 px-2 py-1 text-xs italic text-amber-800 rounded-r">
              <span className="flex-1">“{anchorText}”</span>
              <button
                type="button"
                className="not-italic text-amber-600 hover:text-amber-800"
                onClick={() => setAnchorText("")}
                title="Remove quote"
              >
                ✕
              </button>
            </div>
          )}
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              anchorText ? "Comment on the highlighted text…" : "Add a comment…"
            }
            rows={2}
            className="resize-none text-sm"
          />
          <div className="mt-2 flex justify-end">
            <Button size="sm" onClick={addComment} disabled={!draft.trim() || posting}>
              {posting ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5 mr-1" />
              )}
              Comment
            </Button>
          </div>
        </div>

        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">
            {openCount} open comment{openCount !== 1 ? "s" : ""}
          </span>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowResolved((v) => !v)}
          >
            {showResolved ? "Hide resolved" : "Show resolved"}
          </button>
        </div>

        <div className="max-h-[48vh] overflow-y-auto pr-1">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
            </div>
          ) : threads.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No comments yet. Highlight text in the document, then add the first
              one.
            </div>
          ) : (
            <div className="space-y-3">
              {threads.map(({ root, replies }) => (
                <div key={root.id} className="border rounded-lg p-3">
                  <CommentRow
                    c={root}
                    currentEmail={currentEmail}
                    onReply={() => {
                      setReplyTo(replyTo === root.id ? null : root.id);
                      setReplyDraft("");
                    }}
                    onResolve={() => resolve(root.id)}
                  />
                  {replies.length > 0 && (
                    <div className="mt-3 space-y-3">
                      {replies.map((r) => (
                        <CommentRow
                          key={r.id}
                          c={r}
                          isReply
                          currentEmail={currentEmail}
                        />
                      ))}
                    </div>
                  )}
                  {replyTo === root.id && (
                    <div className="mt-2 pl-8">
                      <Textarea
                        value={replyDraft}
                        onChange={(e) => setReplyDraft(e.target.value)}
                        placeholder="Reply…"
                        rows={2}
                        className="resize-none text-sm"
                        autoFocus
                      />
                      <div className="mt-1 flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setReplyTo(null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => addReply(root.id)}
                          disabled={!replyDraft.trim()}
                        >
                          Reply
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </TabsContent>

      {/* ── Activity ── */}
      <TabsContent value="activity" className="mt-3">
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
            </div>
          ) : activity.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              No activity yet.
            </div>
          ) : (
            <ol className="space-y-1">
              {activity.map((e, i) => {
                const meta = ACTIVITY_META[e.type] ?? {
                  icon: MessageSquare,
                  verb: e.type,
                  tone: "text-foreground",
                };
                const Icon = meta.icon;
                return (
                  <li
                    key={`${e.refId || e.type}-${i}`}
                    className="flex items-start gap-3 rounded-md px-2 py-2 hover:bg-muted/50"
                  >
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
                      <Icon className={`h-3.5 w-3.5 ${meta.tone}`} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-snug">
                        <span className="font-medium">{e.actor}</span>{" "}
                        <span className="text-muted-foreground">{meta.verb}</span>
                        {e.detail && (
                          <span className="text-muted-foreground"> — {e.detail}</span>
                        )}
                      </p>
                      <span className="text-xs text-muted-foreground">{fmt(e.at)}</span>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </TabsContent>
    </Tabs>
  );
}
