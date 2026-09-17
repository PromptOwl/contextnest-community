/**
 * AnnotationsPanel — threaded comments on a document, backed by the existing
 * /annotations API. Supports anchored comments (highlight text in the doc → a
 * comment pinned to that quote, with line + 250c context) and whole-document
 * threads, plus replies and resolve/reopen. For artifacts the server also
 * projects these into a derived markdown node so the feedback flows into the
 * context/MCP path; plain documents keep their comments in SQLite only.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, Check, RotateCcw, Loader2, Quote, X, CornerDownRight, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Switch } from "./ui/switch";
import * as api from "../lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { reads } from "../lib/queries";
import { MentionTextarea, CommentBody } from "./MentionTextarea";
import type { MentionMember } from "./MarkdownEditor/picker-match";
import { formatServerDate } from "../lib/dates";

interface Props {
  nestId: string;
  nodeId: string;
  /** Hide composer/actions for read-only (public) viewers. */
  readOnly?: boolean;
  /** Anchor staged by a text selection in the document, if any. */
  pendingAnchor?: api.AnnotationAnchor | null;
  /** Clear the staged anchor (after submit or cancel). */
  onClearAnchor?: () => void;
  /** Jump to a thread's anchored quote in the document. */
  onFocusAnchor?: (anchor: api.AnnotationAnchor) => void;
  /** Report the loaded threads upward (so the doc can paint highlights). */
  onThreadsChange?: (threads: api.AnnotationThread[]) => void;
  /** Thread to visually emphasize + scroll to (set when its doc highlight is clicked). */
  activeThreadId?: string | null;
  /** Whether the document is in comment mode (rendered view + overlay). */
  commentMode?: boolean;
  /** Turn comment mode on/off from inside the panel. */
  onSetCommentMode?: (on: boolean) => void;
}

function when(ts: string): string {
  return formatServerDate(ts) || ts;
}

/** Trim a quote for compact display in the rail. */
function shortQuote(q: string, max = 80): string {
  const s = q.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function AnnotationsPanel({
  nestId,
  nodeId,
  readOnly,
  pendingAnchor,
  onClearAnchor,
  onFocusAnchor,
  onThreadsChange,
  activeThreadId,
  commentMode,
  onSetCommentMode,
}: Props) {
  // The toggle only matters when the parent wired comment mode in.
  const hasModeToggle = typeof onSetCommentMode === "function";
  const commenting = !hasModeToggle || !!commentMode;
  const [threads, setThreads] = useState<api.AnnotationThread[] | null>(null);
  const [draft, setDraft] = useState("");
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  // The nest's people, for the `@` picker and for telling a real mention from
  // a typo. The read-tier roster, not /collaborators: a read-only reviewer is
  // the person most likely to tag someone, and that read would 403 for them.
  // Skipped for public read-only viewers, who have no composer at all.
  const { data: roster } = useQuery({
    ...reads.mentionable(nestId),
    enabled: !!nestId && !readOnly,
  });
  const members: MentionMember[] = useMemo(
    () => (roster?.people ?? []).filter((p) => !!p.email),
    [roster],
  );
  const itemRefs = useRef<Record<string, HTMLLIElement | null>>({});

  const load = async () => {
    try {
      const { threads } = await qc.fetchQuery(reads.nodeAnnotations(nestId, nodeId));
      setThreads(threads);
      onThreadsChange?.(threads);
    } catch {
      setThreads([]);
      onThreadsChange?.([]);
    }
  };

  useEffect(() => {
    setThreads(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nestId, nodeId]);

  // When a selection stages an anchor, pull focus to the composer so the user
  // can type their comment immediately (Notion/Docs-style).
  useEffect(() => {
    if (pendingAnchor) composerRef.current?.focus();
  }, [pendingAnchor]);

  // Scroll the active thread (its doc highlight was clicked) into view.
  useEffect(() => {
    if (activeThreadId && itemRefs.current[activeThreadId]) {
      itemRefs.current[activeThreadId]?.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
  }, [activeThreadId]);

  const newThread = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try {
      await api.createAnnotation(nestId, nodeId, { body, anchor: pendingAnchor ?? null });
      setDraft("");
      onClearAnchor?.();
      await load();
    } catch (e: any) {
      toast.error(e?.message || "Failed to add comment");
    } finally {
      setBusy(false);
    }
  };

  const reply = async (threadId: string) => {
    const body = replyText.trim();
    if (!body) return;
    setBusy(true);
    try {
      await api.replyAnnotation(nestId, nodeId, threadId, body);
      setReplyText("");
      setReplyFor(null);
      await load();
    } catch (e: any) {
      toast.error(e?.message || "Failed to reply");
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (t: api.AnnotationThread) => {
    setBusy(true);
    try {
      if (t.status === "open") {
        await api.resolveAnnotation(nestId, nodeId, t.id);
      } else {
        await api.reopenAnnotation(nestId, nodeId, t.id);
      }
      await load();
    } catch (e: any) {
      toast.error(e?.message || "Failed to update thread");
    } finally {
      setBusy(false);
    }
  };

  const count = threads?.length ?? 0;
  // Newest thread first in the rail (replies inside a thread stay chronological).
  // UI-only ordering — the server list + derived projection keep their own order.
  const ordered = threads
    ? [...threads].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : threads;

  return (
    <section className="flex flex-col flex-1 min-h-0 max-h-[calc(100vh-2rem)] rounded-lg border border-border bg-card p-5" data-testid="annotations-panel">
      <div className="flex items-center gap-2 mb-4 border-b pb-3 shrink-0">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">
          Comments{threads ? ` (${count})` : ""}
        </h3>
        {/* Single, obvious control: comment mode lives in the comment box. */}
        {!readOnly && hasModeToggle && (
          <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            Comment mode
            <Switch
              checked={!!commentMode}
              onCheckedChange={(v) => onSetCommentMode?.(v)}
              data-testid="annotations-comment-mode"
            />
          </label>
        )}
      </div>

      {!readOnly && (
        <div className="mb-4 shrink-0">
          {/* Staged anchor chip — shows which highlighted text this comment
              will be pinned to, or a hint to select text. */}
          {commenting &&
            (pendingAnchor ? (
              <div
                className="mb-2 rounded-md border border-amber-200 bg-amber-50/60 dark:bg-amber-950/20 px-2 py-1.5 text-xs"
                data-testid="annotations-pending-anchor"
              >
                <div className="flex items-start gap-1.5">
                  <Quote className="h-3 w-3 mt-0.5 shrink-0 text-amber-700" />
                  <span className="flex-1 italic text-foreground/80">
                    “{shortQuote(pendingAnchor.quote)}”
                  </span>
                  <button
                    type="button"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    title="Comment on the whole document instead"
                    onClick={() => onClearAnchor?.()}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            ) : (
              <p className="mb-2 text-[11px] text-muted-foreground">
                Tip: select text in the document to pin a comment to it.
              </p>
            ))}
          <MentionTextarea
            ref={composerRef}
            members={members}
            value={commenting ? draft : ""}
            onValueChange={setDraft}
            // When comment mode is off, the box is a greyed affordance: clicking
            // (or focusing) it flips the toggle on instead of typing.
            readOnly={!commenting}
            onMouseDown={
              commenting
                ? undefined
                : (e) => {
                    e.preventDefault();
                    onSetCommentMode?.(true);
                  }
            }
            onFocus={commenting ? undefined : () => onSetCommentMode?.(true)}
            // Off-mode copy names the click, not a prerequisite: the box turns
            // comment mode on itself, so "turn on comment mode to comment" sent
            // people looking for a switch they had already reached.
            placeholder={
              commenting
                ? pendingAnchor
                  ? "Comment on the highlighted text…"
                  : "Add a comment… use @ to tag someone"
                : "Click here to start commenting…"
            }
            title={commenting ? undefined : "Click to turn on comment mode"}
            rows={2}
            className={`w-full rounded-md border px-3 py-2 text-sm resize-y ${
              commenting
                ? "border-input bg-background"
                : "border-dashed border-input bg-muted/50 text-muted-foreground cursor-pointer"
            }`}
            data-testid="annotations-new"
          />
          {commenting && (
            <div className="flex justify-end mt-2">
              <Button size="sm" onClick={newThread} disabled={busy || !draft.trim()}>
                {pendingAnchor ? "Comment on selection" : "Comment"}
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto -mr-2 pr-2">
        {threads === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading comments…
          </div>
        ) : count === 0 ? (
          <p className="text-sm text-muted-foreground py-2">No comments yet.</p>
        ) : (
          <ul className="space-y-3">
            {ordered!.map((t) => (
              <li
                key={t.id}
                ref={(el) => {
                  itemRefs.current[t.id] = el;
                }}
                className={`rounded-md border p-3 transition-shadow ${
                  activeThreadId === t.id
                    ? "border-amber-400 ring-2 ring-amber-300/60"
                    : t.status === "resolved"
                      ? "border-emerald-200 bg-emerald-50/40 dark:bg-emerald-950/20"
                      : "border-border"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded ${
                      t.status === "resolved"
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-amber-100 text-amber-800"
                    }`}
                  >
                    {t.status}
                  </span>
                </div>

                {/* Anchored quote — what this thread is pinned to. Click to jump. */}
                {t.anchor?.quote && (
                  <button
                    type="button"
                    onClick={() => onFocusAnchor?.(t.anchor!)}
                    className="group mb-2 block w-full text-left rounded border-l-2 border-amber-400 bg-amber-50/50 dark:bg-amber-950/20 px-2 py-1 text-xs italic text-foreground/75 hover:bg-amber-100/70"
                    title="Jump to this text in the document"
                  >
                    <Quote className="inline h-3 w-3 mr-1 text-amber-600 align-[-1px]" />
                    {shortQuote(t.anchor.quote)}
                  </button>
                )}

                {/* First comment is the thread root; the rest are replies,
                    nested under it with a connector rail. */}
                {t.comments.length > 0 && (
                  <div className="text-sm">
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {t.comments[0].author}
                      </span>{" "}
                      · {when(t.comments[0].createdAt)}
                    </div>
                    <CommentBody body={t.comments[0].body} members={members} />
                  </div>
                )}
                {t.comments.length > 1 && (
                  <ul className="mt-2 ml-2 space-y-2 border-l-2 border-border pl-3">
                    {t.comments.slice(1).map((c) => (
                      <li key={c.id} className="text-sm">
                        <div className="text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">{c.author}</span>{" "}
                          replied · {when(c.createdAt)}
                        </div>
                        <CommentBody body={c.body} members={members} />
                      </li>
                    ))}
                  </ul>
                )}

                {/* Resolve audit line — who closed the thread and when. */}
                {t.status === "resolved" && t.resolvedBy && (
                  <div className="mt-2 flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                    <span>
                      Resolved by{" "}
                      <span className="font-medium">{t.resolvedBy}</span>
                      {t.resolvedAt && <> · {when(t.resolvedAt)}</>}
                    </span>
                  </div>
                )}

                {!readOnly &&
                  (replyFor === t.id ? (
                    <div className="mt-2">
                      <MentionTextarea
                        members={members}
                        value={replyText}
                        onValueChange={setReplyText}
                        placeholder="Reply… use @ to tag someone"
                        rows={2}
                        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
                        autoFocus
                      />
                      <div className="flex justify-end gap-2 mt-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setReplyFor(null);
                            setReplyText("");
                          }}
                        >
                          Cancel
                        </Button>
                        <Button size="sm" onClick={() => reply(t.id)} disabled={busy || !replyText.trim()}>
                          Reply
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                        onClick={() => {
                          setReplyFor(t.id);
                          setReplyText("");
                        }}
                      >
                        <CornerDownRight className="h-3 w-3" /> Reply
                      </button>
                      {t.status === "open" ? (
                        <button
                          type="button"
                          disabled={busy}
                          className="inline-flex items-center gap-1 rounded-md border border-emerald-600 bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
                          onClick={() => toggleStatus(t)}
                        >
                          <Check className="h-3.5 w-3.5" /> Resolve
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                          onClick={() => toggleStatus(t)}
                        >
                          <RotateCcw className="h-3 w-3" /> Reopen
                        </button>
                      )}
                    </div>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
