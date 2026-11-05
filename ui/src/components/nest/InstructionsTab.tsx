/**
 * Instructions tab — the nest's CONTEXT.md (CU-wdqcq05mty).
 *
 * Every agent reads this file first (MCP `context_init`), so it is the most
 * consequential page in a nest, and until now nobody could see it here. Members
 * read it; the owner and nest admins edit it. Every change — made here, by
 * `ctx push`, or by an agent over MCP — lands in the history, where each
 * revision shows what it replaced and can be restored. The server decides who
 * may write and re-checks every save.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bot, History, Lock, Pencil, RotateCcw } from "lucide-react";
import * as api from "../../lib/api";
import { keys, reads } from "../../lib/queries";
import { relTime } from "@/lib/dates";
import {
  baseRevisionOf,
  isStaleSaveError,
  joinFrontmatter,
  sourceLabel,
  splitFrontmatter,
  type InstructionsRevision,
} from "../../lib/instructions";
import { MarkdownEditor } from "../MarkdownEditor";
import { DiffViewer } from "../governance/DiffViewer";
import { unifiedDiff } from "../governance/diff-util";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface InstructionsTabProps {
  nestId: string;
  /** Owner / nest admin on a live nest. */
  canEdit: boolean;
}

function who(r: InstructionsRevision): string {
  return r.authorEmail ?? "Unknown";
}

export function InstructionsTab({ nestId, canEdit }: InstructionsTabProps) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery(reads.instructions(nestId));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // The revision whose changes fill the main column, picked from History.
  const [openSeq, setOpenSeq] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  const opened = useQuery({
    queryKey: [...keys.instructionsRevisions(nestId), openSeq],
    queryFn: () => api.getInstructionsRevision(nestId, openSeq!),
    enabled: openSeq !== null,
  });

  if (isLoading) {
    return <div className="py-12 text-center text-muted-foreground">Loading...</div>;
  }
  if (error || !data) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        Couldn't load the instructions.
      </div>
    );
  }

  const { frontmatter, body } = splitFrontmatter(data.content);
  const revision = data.revision;
  // Always-include documents (CU-wdqcq05rn0) travel with these instructions;
  // counted from what this reader can read, including any past the budget.
  const standing = data.always_included;
  const alwaysIncluded = standing ? standing.documents.length + standing.overflow.length : 0;
  const standingTitles = standing
    ? [...standing.documents, ...standing.overflow].map((d) => d.title).join(", ")
    : "";

  const startEdit = () => {
    setDraft(body);
    setNote("");
    setStale(false);
    setOpenSeq(null);
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.saveInstructions(nestId, {
        content: joinFrontmatter(frontmatter, draft),
        note: note.trim() || undefined,
        baseRevision: baseRevisionOf(revision),
      });
      toast.success("Instructions saved. Agents get the new text on their next session.");
      setEditing(false);
    } catch (e: any) {
      if (isStaleSaveError(e)) setStale(true);
      else toast.error(e?.message || "Couldn't save the instructions");
    } finally {
      setSaving(false);
    }
  };

  const restore = async (seq: number) => {
    setRestoring(true);
    try {
      await api.restoreInstructionsRevision(nestId, seq, baseRevisionOf(revision));
      toast.success(`Restored revision ${seq}`);
      setOpenSeq(null);
    } catch (e: any) {
      toast.error(
        isStaleSaveError(e)
          ? "The instructions changed since you opened the history. Try again."
          : e?.message || "Couldn't restore",
      );
    } finally {
      setRestoring(false);
    }
  };

  const reload = () => {
    void qc.invalidateQueries({ queryKey: keys.instructions(nestId) });
    setEditing(false);
    setStale(false);
  };

  return (
    <div
      className={cn("grid gap-4", showHistory && "lg:grid-cols-[minmax(0,1fr)_340px]")}
      data-testid="instructions-tab"
    >
      <Card className="min-w-0">
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base">Instructions</CardTitle>
            <CardDescription className="flex items-start gap-1.5">
              <Bot className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                What every agent reads first in this nest (CONTEXT.md, served by{" "}
                <code className="text-xs">context_init</code>). Every change is recorded.
              </span>
            </CardDescription>
            {alwaysIncluded > 0 && (
              <p
                className="text-xs text-muted-foreground"
                data-testid="instructions-always-included"
                title={standingTitles}
              >
                Plus {alwaysIncluded} always-included document
                {alwaysIncluded === 1 ? "" : "s"}, sent with these instructions to
                every agent (approved versions only).
              </p>
            )}
            {revision && (
              <p className="text-xs text-muted-foreground" data-testid="instructions-last-change">
                Revision {revision.seq} · {who(revision)} · {relTime(revision.createdAt)} ·{" "}
                {sourceLabel(revision.source)}
                {revision.note ? ` — ${revision.note}` : ""}
              </p>
            )}
          </div>
          {!editing && (
            <div className="flex shrink-0 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowHistory((v) => !v);
                  setOpenSeq(null);
                }}
                aria-pressed={showHistory}
                data-testid="instructions-history-toggle"
              >
                <History className="mr-1.5 h-4 w-4" />
                History
              </Button>
              {canEdit && (
                <Button size="sm" onClick={startEdit} data-testid="instructions-edit">
                  <Pencil className="mr-1.5 h-4 w-4" />
                  Edit
                </Button>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {editing ? (
            <>
              <MarkdownEditor
                key="instructions-edit"
                content={draft}
                onChange={setDraft}
                editable
                nestId={nestId}
                autofocus="end"
              />
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What changed and why (shown in the history)"
                aria-label="Change note"
                data-testid="instructions-note"
              />
              {stale && (
                <div
                  className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
                  data-testid="instructions-stale"
                >
                  <span className="flex-1">
                    Someone changed the instructions since you opened them. Reload to see
                    the latest, then make your edit again. Copy your text first if you need
                    it.
                  </span>
                  <Button size="sm" variant="outline" onClick={reload}>
                    Reload
                  </Button>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => void save()}
                  disabled={saving || stale || !draft.trim()}
                  data-testid="instructions-save"
                >
                  {saving ? "Saving..." : "Save"}
                </Button>
              </div>
            </>
          ) : openSeq !== null ? (
            <div className="space-y-3" data-testid="instructions-revision-view">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  Revision {openSeq}
                  {opened.data?.previousContent != null
                    ? ` — changes from revision ${openSeq - 1}`
                    : " — full text"}
                </p>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setOpenSeq(null)}>
                    Back to current
                  </Button>
                  {canEdit && openSeq !== baseRevisionOf(revision) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={restoring || !opened.data}
                      onClick={() => void restore(openSeq)}
                      data-testid="instructions-restore"
                    >
                      <RotateCcw className="mr-1.5 h-4 w-4" />
                      Restore this revision
                    </Button>
                  )}
                </div>
              </div>
              {!opened.data ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : opened.data.previousContent !== null ? (
                <DiffViewer
                  patch={unifiedDiff(opened.data.previousContent, opened.data.content)}
                  className="max-h-[70vh]"
                />
              ) : (
                <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-xs">
                  {opened.data.content}
                </pre>
              )}
            </div>
          ) : !body.trim() ? (
            // Empty CONTEXT.md (an imported nest often has one): say so instead
            // of a blank card (CU-wdqcq06259).
            <div className="py-8 text-center" data-testid="instructions-empty">
              <p className="font-medium">No instructions yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                {canEdit
                  ? "Agents read these first when they work in this nest. Tell them what the nest is for and how to use it."
                  : "The nest owner or an admin can add instructions for agents working in this nest."}
              </p>
              {canEdit && (
                <Button size="sm" className="mt-4" onClick={startEdit}>
                  <Pencil className="mr-1.5 h-4 w-4" />
                  Add instructions
                </Button>
              )}
            </div>
          ) : (
            <>
              <MarkdownEditor
                key={`instructions-view:${revision?.seq ?? 0}`}
                content={body}
                onChange={() => {}}
                editable={false}
                nestId={nestId}
              />
              {!canEdit && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Lock className="h-3.5 w-3.5" />
                  Only the nest owner or an admin can change these.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {showHistory && (
        <InstructionsHistory
          nestId={nestId}
          openSeq={openSeq}
          onOpen={(seq) => {
            setEditing(false);
            setOpenSeq(seq);
          }}
        />
      )}
    </div>
  );
}

function InstructionsHistory({
  nestId,
  openSeq,
  onOpen,
}: {
  nestId: string;
  openSeq: number | null;
  onOpen: (seq: number | null) => void;
}) {
  const { data, isLoading } = useQuery(reads.instructionsRevisions(nestId));
  const revisions = data?.revisions ?? [];

  return (
    <Card className="min-w-0 self-start" data-testid="instructions-history">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">History</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : revisions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No changes recorded yet. The first save keeps the current text as revision 1.
          </p>
        ) : (
          <ol className="space-y-1">
            {revisions.map((r) => (
              <li key={r.seq}>
                <button
                  type="button"
                  onClick={() => onOpen(openSeq === r.seq ? null : r.seq)}
                  aria-current={openSeq === r.seq ? "true" : undefined}
                  className={cn(
                    "w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/60",
                    openSeq === r.seq && "border-primary bg-muted/60",
                  )}
                  data-testid="instructions-revision"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">Revision {r.seq}</span>
                    <span className="text-xs text-muted-foreground">{relTime(r.createdAt)}</span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {who(r)} · {sourceLabel(r.source)}
                  </div>
                  {r.note && <div className="mt-0.5 line-clamp-2 text-xs">{r.note}</div>}
                </button>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
