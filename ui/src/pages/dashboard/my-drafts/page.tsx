/**
 * MyDraftsPage — My Drafts (/my-drafts): every draft you started and never handed off.
 */
import React, { useState, useEffect } from "react";
import * as api from "../../../lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { reads } from "../../../lib/queries";
import { useAuth } from "../../../auth/AuthContext";
import { useAppNav } from "../../../lib/app-nav";
import {
  Trash2, Loader2, CheckCircle2, Folder, ChevronRight, ChevronLeft,
} from "lucide-react";
import { toast } from "sonner";
import { relTime } from "../../../lib/dates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { SubmitForReviewModal } from "../../../components/governance";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";


export default function MyDraftsPage() {
  const { openReview: onOpenReview } = useAppNav();
  const { adminStatus } = useAuth();
  const currentUserEmail = adminStatus?.me?.email ?? null;
  // Drafts you never submitted — their own tab, not folded into My Work.
  const [drafts, setDrafts] = useState<api.MyDraft[]>([]);
  const [draftsPage, setDraftsPage] = useState<api.WorkPagination | null>(null);
  const [draftsLoading, setDraftsLoading] = useState(true);
  // Drafts awaiting the submit dialog (priority + note) — same modal the editor
  // uses, so submitting from here isn't a second, weaker path. A list: one row's
  // button and the bulk bar hand it the same shape (CU-wdqcq01pe7).
  const [submitTargets, setSubmitTargets] = useState<api.MyDraft[] | null>(null);
  // Find/sort/select for the drafts list. Search and sort are server-side (the
  // list spans pages, so filtering the page in hand would lie); `draftSearch`
  // is the debounced value actually sent.
  const [draftQuery, setDraftQuery] = useState("");
  const [draftSearch, setDraftSearch] = useState("");
  const [draftSort, setDraftSort] = useState<"updated" | "title">("updated");
  const [draftsSelected, setDraftsSelected] = useState<Set<string>>(new Set());
  const [draftsBusy, setDraftsBusy] = useState(false);
  // Drafts awaiting the discard confirmation — one row, or a whole selection.
  const [discardTargets, setDiscardTargets] = useState<api.MyDraft[] | null>(null);
  const qc = useQueryClient();
  // Jump to a page of drafts. Same replace-the-page contract as the work
  // inbox below, so submitting one can reload the page the user is standing on.
  const goToDraftsPage = async (offset: number) => {
    setDraftsLoading(true);
    try {
      const next = await qc.fetchQuery(
        reads.myDrafts({ offset, q: draftSearch || undefined, sort: draftSort }),
      );
      // Clearing the last page of a list leaves the offset past the end, which
      // paints "no drafts" while the badge still counts some. Fall back to the
      // first page rather than stranding the reader on a blank one.
      if (next.drafts.length === 0 && offset > 0 && next.pagination.total > 0) {
        return void (await goToDraftsPage(0));
      }
      setDrafts(next.drafts);
      setDraftsPage(next.pagination);
    } catch (e) {
      console.error("[Dashboard] goToDraftsPage failed", e);
      setDrafts([]);
    } finally {
      setDraftsLoading(false);
    }
  };

  // Jump to a page of pending reviews (Prev/Next). Replaces the current page
  // rather than appending — offset is clamped ≥ 0 by the caller.
  // Submit a draft straight from the list — the whole point of the tab is that
  // the doc was stranded, so the fix (hand it to a reviewer) is one click away.
  // It leaves the drafts list and shows up under "Waiting on others". Throws on
  // failure so the error surfaces in the dialog instead of a swallowed console
  // line; the dialog also owns the busy state.
  const submitDrafts = async (
    targets: api.MyDraft[],
    note: string,
    priority: string,
  ) => {
    // Serial, like the bulk discard beneath: writes against the same nests, a
    // handful of rows, and each one stands alone — a failure part-way leaves
    // the ones before it submitted and is reported, not rolled back.
    const done: api.MyDraft[] = [];
    const failed: api.MyDraft[] = [];
    for (const d of targets) {
      try {
        await api.submitForReview(d.nest_id, d.node_id, note, priority);
        done.push(d);
      } catch (e) {
        failed.push(d);
        console.error("[Dashboard] submitForReview failed", d.node_id, e);
      }
    }
    // Optimistic drop, then reload the page the user is on — a row leaving
    // pulls one up from the next page, and the total shifts.
    setDrafts((prev) => prev.filter((x) => !done.some((d) => draftKey(d) === draftKey(x))));
    setDraftsSelected(new Set());
    void goToDraftsPage(draftsPage?.offset ?? 0);
    if (failed.length) {
      // Narrow the dialog to what is left to do: retrying the original list
      // would resubmit the drafts that already went to review, and they would
      // fail the second time for being pending — reporting titles that in fact
      // succeeded.
      setSubmitTargets(failed);
      // Thrown so the dialog shows it and stays open. The ones that landed are
      // already gone from the list, so the message counts them too — a batch
      // where 9 of 10 went through is not an unqualified failure.
      const landed = done.length ? `${done.length} submitted. ` : "";
      throw new Error(
        `${landed}Couldn't submit ${failed.length}: ${failed
          .map((d) => d.title)
          .join(", ")}`,
      );
    }
    if (done.length > 1) toast.success(`${done.length} submitted for review`);
  };

  const draftKey = (d: api.MyDraft) => `${d.nest_id}:${d.node_id}`;

  // Debounced so a search is one request per pause, not one per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDraftSearch(draftQuery.trim()), 250);
    return () => clearTimeout(t);
  }, [draftQuery]);

  // First page on mount, and again whenever the signed-in user changes (in
  // open mode the page stays mounted across login).
  useEffect(() => {
    void goToDraftsPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserEmail]);

  // A new search or sort replaces the list from page one. Skipped on the first
  // run — the mount effect above already fetched that page.
  const draftFiltersReady = React.useRef(false);
  useEffect(() => {
    if (!draftFiltersReady.current) {
      draftFiltersReady.current = true;
      return;
    }
    setDraftsSelected(new Set());
    void goToDraftsPage(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftSearch, draftSort]);

  /**
   * Throw drafts away, once the dialog below has confirmed. What that means per
   * document is the server's call — a document that was approved before goes
   * back to that version, one that never was is deleted — so the dialog names
   * both outcomes rather than promising the wrong one.
   */
  const discardDrafts = async (targets: api.MyDraft[]) => {
    if (targets.length === 0) return;
    setDiscardTargets(null);
    setDraftsBusy(true);
    let reverted = 0;
    let deleted = 0;
    const failed: string[] = [];
    // Serial: these are writes against the same nests, and a handful of rows
    // is the realistic batch. Each one stands alone, so a failure part-way
    // leaves the ones before it discarded and is reported, not rolled back.
    for (const d of targets) {
      try {
        const res = await api.discardDraft(d.nest_id, d.node_id);
        if (res.deleted) deleted++;
        else reverted++;
      } catch (e) {
        failed.push(d.title);
        console.error("[Dashboard] discardDraft failed", d.node_id, e);
      }
    }
    setDraftsBusy(false);
    setDraftsSelected(new Set());

    if (reverted || deleted) {
      toast.success(
        [
          reverted ? `${reverted} restored to the approved version` : "",
          deleted ? `${deleted} deleted` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      );
    }
    if (failed.length) {
      toast.error(`Couldn't discard: ${failed.join(", ")}`);
    }
    void goToDraftsPage(draftsPage?.offset ?? 0);
  };

  // Optimistic drop + reconcile, same as approveReviewItem.
  return (
    <div className="space-y-4">

        {/* My Drafts — everything you started and never handed off. A draft
            that was never submitted has no review request, so before this it
            appeared in no queue at all and was only findable by search. */}
      <div>
          <div>
            {/* Find and order the list. Both run on the server: the list spans
                pages, so filtering the page in hand would quietly search a
                subset. */}
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <Input
                value={draftQuery}
                onChange={(e) => setDraftQuery(e.target.value)}
                placeholder="Search drafts by title or nest…"
                className="h-8 max-w-xs"
                aria-label="Search your drafts"
                data-testid="drafts-search"
              />
              {/* Segmented control, not three look-alike words. The label is
                  muted and carries its colon; both options sit inside one
                  bordered group so each reads as a control whether or not it is
                  the selected one, and the selection is the filled pill. */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  Sort:
                </span>
                <div
                  className="inline-flex items-center rounded-md border bg-muted/40 p-0.5"
                  role="group"
                  aria-label="Sort drafts"
                >
                  {(
                    [
                      ["updated", "Recently edited"],
                      ["title", "Title"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={draftSort === value}
                      onClick={() => setDraftSort(value)}
                      className={`h-6 rounded px-2 text-xs transition-colors ${
                        draftSort === value
                          ? "bg-background font-medium text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      data-testid={`drafts-sort-${value}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {draftsLoading ? (
              // Loader, not the empty state: "nothing here" while the request is
              // still in flight reads as an answer, and this list existing at
              // all is the fix for a draft nobody knew about.
              <div className="rounded-lg border bg-muted/20 px-4 py-6 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading your drafts…
              </div>
            ) : drafts.length === 0 ? (
              <div className="rounded-lg border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
                {draftSearch
                  ? `No drafts match "${draftSearch}".`
                  : "No unsubmitted drafts — everything you've written is in review or approved."}
              </div>
            ) : (
              <div className="rounded-lg border divide-y overflow-hidden">
                {/* Batch bar — the reason this tab was unusable at 66 drafts is
                    that every one of them had to be opened to be cleaned up. */}
                {drafts.length > 1 && (
                  <div className="flex flex-wrap items-center gap-2 bg-muted/40 px-4 py-2 text-sm">
                    <Checkbox
                      // Partial selections read as "some", not "none".
                      checked={
                        draftsSelected.size === 0
                          ? false
                          : draftsSelected.size === drafts.length
                            ? true
                            : "indeterminate"
                      }
                      onCheckedChange={(next: boolean | "indeterminate") =>
                        setDraftsSelected(
                          next === true ? new Set(drafts.map(draftKey)) : new Set(),
                        )
                      }
                      aria-label="Select every draft on this page"
                      data-testid="drafts-select-all"
                    />
                    <span className="text-muted-foreground">
                      {draftsSelected.size > 0
                        ? `${draftsSelected.size} selected`
                        : `Select all ${drafts.length} on this page`}
                    </span>
                    {draftsSelected.size > 0 && (
                      <div className="ml-auto flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={draftsBusy}
                          onClick={() =>
                            setSubmitTargets(
                              drafts.filter((d) => draftsSelected.has(draftKey(d))),
                            )
                          }
                          data-testid="drafts-bulk-submit"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                          Submit {draftsSelected.size} for review
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={draftsBusy}
                          onClick={() =>
                            setDiscardTargets(
                              drafts.filter((d) => draftsSelected.has(draftKey(d))),
                            )
                          }
                          data-testid="drafts-bulk-discard"
                        >
                          {draftsBusy ? (
                            <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5 mr-1" />
                          )}
                          Discard {draftsSelected.size}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDraftsSelected(new Set())}
                        >
                          Clear
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                {drafts.map((d) => {
                  const key = `${d.nest_id}:${d.node_id}`;
                  return (
                    <div
                      key={key}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40 group"
                    >
                      {drafts.length > 1 && (
                        <Checkbox
                          checked={draftsSelected.has(key)}
                          onCheckedChange={() =>
                            setDraftsSelected((prev) => {
                              const next = new Set(prev);
                              next.has(key) ? next.delete(key) : next.add(key);
                              return next;
                            })
                          }
                          aria-label={`Select ${d.title}`}
                        />
                      )}
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide shrink-0 ${d.status === "rejected"
                            ? "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300"
                            : "bg-muted text-muted-foreground"
                          }`}
                      >
                        {d.status === "rejected" ? "Rejected" : "Draft"}
                      </span>
                      {/* Two lines: the title gets the full width (these run
                          long), its location sits under it. Inline, both
                          competed for the same row and each truncated the
                          other — the location being readable is the point. */}
                      <button
                        onClick={() => onOpenReview(d.nest_id, d.nest_name, d.node_id)}
                        className="flex flex-col min-w-0 flex-1 text-left gap-0.5"
                      >
                        <span className="font-medium truncate">{d.title}</span>
                        <span
                          className="text-xs text-muted-foreground truncate"
                          title={`${d.nest_name} / ${d.node_id}`}
                        >
                          <Folder className="h-3 w-3 inline mr-1 -mt-0.5" />
                          {d.nest_name}
                          {d.folder ? ` / ${d.folder}` : ""} · edited{" "}
                          {relTime(d.updated_at)}
                        </span>
                      </button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => setSubmitTargets([d])}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                        Submit for review
                      </Button>
                      {/* The action the list was missing: cleaning one up took
                          opening the document and finding Delete in its menu. */}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={draftsBusy}
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        title="Discard this draft — back to the last approved version, or delete it if there isn't one"
                        onClick={() => setDiscardTargets([d])}
                        data-testid="draft-discard"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
            {draftsPage && draftsPage.total > draftsPage.limit && (
              <div className="flex items-center justify-center gap-3 pt-3 text-sm text-muted-foreground">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={draftsLoading || draftsPage.offset === 0}
                  onClick={() =>
                    goToDraftsPage(Math.max(0, draftsPage.offset - draftsPage.limit))
                  }
                >
                  <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                  Prev
                </Button>
                <span>
                  Page {Math.floor(draftsPage.offset / draftsPage.limit) + 1} of{" "}
                  {Math.max(1, Math.ceil(draftsPage.total / draftsPage.limit))}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={draftsLoading || !draftsPage.has_more}
                  onClick={() =>
                    goToDraftsPage(draftsPage.offset + draftsPage.limit)
                  }
                >
                  Next
                  <ChevronRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              </div>
            )}
          </div>
      </div>


      {/* One version number only describes one draft — a bulk submit names
          none, and the modal drops the version line. */}
      {submitTargets && submitTargets.length > 0 && (
        <SubmitForReviewModal
          isOpen
          onClose={() => setSubmitTargets(null)}
          documentTitle={
            submitTargets.length === 1
              ? submitTargets[0].title
              : `${submitTargets.length} drafts`
          }
          currentVersion={
            submitTargets.length === 1 ? submitTargets[0].version : null
          }
          onSubmit={(note, priority) =>
            submitDrafts(submitTargets, note, priority)
          }
        />
      )}

      {/* Discard confirmation — the app's own dialog, like every other
          destructive action. It names both outcomes because only the server
          knows which applies per document. */}
      <AlertDialog
        open={!!discardTargets}
        onOpenChange={(open) => !open && setDiscardTargets(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {discardTargets?.length === 1
                ? `Discard "${discardTargets[0].title}"?`
                : `Discard ${discardTargets?.length ?? 0} drafts?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {discardTargets?.length === 1 ? "The document goes" : "Each document goes"}{" "}
              back to its last approved version. A document that was never
              approved is deleted instead. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void discardDrafts(discardTargets ?? [])}
              data-testid="drafts-discard-confirm"
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
