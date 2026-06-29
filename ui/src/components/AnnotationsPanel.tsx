/**
 * AnnotationsPanel — threaded comments on a document, backed by the existing
 * /annotations API. Whole-document threads (no text anchor) plus replies and
 * resolve/reopen. The server projects these into a derived markdown node so the
 * feedback also flows into the context/MCP path.
 */
import { useEffect, useState } from "react";
import { MessageSquare, Check, RotateCcw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import * as api from "../lib/api";

interface Props {
  nestId: string;
  nodeId: string;
  /** Hide composer/actions for read-only (public) viewers. */
  readOnly?: boolean;
}

function when(ts: string): string {
  const d = new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export function AnnotationsPanel({ nestId, nodeId, readOnly }: Props) {
  const [threads, setThreads] = useState<api.AnnotationThread[] | null>(null);
  const [draft, setDraft] = useState("");
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const { threads } = await api.listAnnotations(nestId, nodeId);
      setThreads(threads);
    } catch {
      setThreads([]);
    }
  };

  useEffect(() => {
    setThreads(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nestId, nodeId]);

  const newThread = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    try {
      await api.createAnnotation(nestId, nodeId, body);
      setDraft("");
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
      await api.addAnnotationComment(nestId, nodeId, threadId, body);
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
      await api.setAnnotationStatus(
        nestId,
        nodeId,
        t.id,
        t.status === "open" ? "resolve" : "reopen",
      );
      await load();
    } catch (e: any) {
      toast.error(e?.message || "Failed to update thread");
    } finally {
      setBusy(false);
    }
  };

  const count = threads?.length ?? 0;

  return (
    <section className="rounded-lg border border-border bg-card p-4" data-testid="annotations-panel">
      <div className="flex items-center gap-2 mb-3">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">
          Comments{threads ? ` (${count})` : ""}
        </h3>
      </div>

      {!readOnly && (
        <div className="mb-4">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a comment…"
            rows={2}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
            data-testid="annotations-new"
          />
          <div className="flex justify-end mt-2">
            <Button size="sm" onClick={newThread} disabled={busy || !draft.trim()}>
              Comment
            </Button>
          </div>
        </div>
      )}

      {threads === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading comments…
        </div>
      ) : count === 0 ? (
        <p className="text-sm text-muted-foreground py-2">No comments yet.</p>
      ) : (
        <ul className="space-y-3">
          {threads.map((t) => (
            <li
              key={t.id}
              className={`rounded-md border p-3 ${
                t.status === "resolved"
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
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => toggleStatus(t)}
                    disabled={busy}
                  >
                    {t.status === "open" ? (
                      <>
                        <Check className="h-3 w-3 mr-1" /> Resolve
                      </>
                    ) : (
                      <>
                        <RotateCcw className="h-3 w-3 mr-1" /> Reopen
                      </>
                    )}
                  </Button>
                )}
              </div>

              <ul className="space-y-2">
                {t.comments.map((c) => (
                  <li key={c.id} className="text-sm">
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{c.author}</span>{" "}
                      · {when(c.createdAt)}
                    </div>
                    <div className="whitespace-pre-wrap">{c.body}</div>
                  </li>
                ))}
              </ul>

              {!readOnly &&
                (replyFor === t.id ? (
                  <div className="mt-2">
                    <textarea
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      placeholder="Reply…"
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
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 mt-1 text-xs"
                    onClick={() => {
                      setReplyFor(t.id);
                      setReplyText("");
                    }}
                  >
                    Reply
                  </Button>
                ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
