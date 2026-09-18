/**
 * Review tab — the nest's activity feed: pending changes to review, your own
 * submissions, deletion flags, and comment activity. Owns the comment feed
 * (first page through reads.feed, more pages on demand), the filter chips
 * and bulk selection/action. The change queue and deletion flags come from
 * NestView — the Documents tab and the tab strip read them too.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Send, Trash2 } from "lucide-react";
import * as api from "../../lib/api";
import { keys, reads } from "../../lib/queries";
import { BULK_REVIEW_LIMIT } from "../../lib/constants";
import { FEED_PAGE, useFeedComments } from "./feed-query";
import { ReviewQueue, ReasonDialog, type ReviewRequest } from "../governance";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";


interface Props {
  nestId: string;
  /** A grant-only nest offers no governance reads. */
  enabled: boolean;
  /** Everything pending in this nest. */
  reviewQueue: ReviewRequest[];
  /** The subset this caller can act on. */
  reviewableQueue: ReviewRequest[];
  myPendingSubmissions: ReviewRequest[];
  pendingDeletions: api.DeletionRequest[];
  canManage: boolean;
  /** The queue is still loading (NestView's read). */
  loading: boolean;
  onRefresh: () => void;
  onOpenDocument: (nodeId: string, opts?: { thread?: string }) => void;
  /** Open the review modal for a request (NestView resolves the node). */
  onSelectRequest: (req: ReviewRequest) => void;
  onResolveDeletion: (request: api.DeletionRequest, action: "delete" | "decline") => void;
  /** Your own pending submission back to Draft. */
  onWithdrawSubmission: (nodeId: string) => void;
}

export function ReviewTab({
  nestId,
  enabled,
  reviewQueue,
  reviewableQueue,
  myPendingSubmissions,
  pendingDeletions,
  canManage,
  loading,
  onRefresh,
  onOpenDocument,
  onSelectRequest,
  onResolveDeletion,
  onWithdrawSubmission,
}: Props) {
  const qc = useQueryClient();
  const [feedFilter, setFeedFilter] = useState<"all" | "changes" | "comments">("all");
  // First page from the cache; later pages accumulate here. A write that
  // drops keys.feed re-reads page one and resets the rest.
  const firstPage = useFeedComments(nestId, enabled);
  const [morePages, setMorePages] = useState<api.FeedCommentItem[]>([]);
  const [feedLoadingMore, setFeedLoadingMore] = useState(false);
  const firstComments = (firstPage.data?.items ?? []).filter(
    (i): i is api.FeedCommentItem => i.type === "comment",
  );
  const feedComments = (() => {
    const seen = new Set(firstComments.map((c) => c.id));
    return [...firstComments, ...morePages.filter((c) => !seen.has(c.id))];
  })();
  // Authoritative total (an older server without counts falls back to the
  // page length, which is at least not wrong for single-page nests).
  const feedCommentsTotal = firstPage.data?.counts?.comments ?? firstComments.length;
  const loadMoreComments = async () => {
    setFeedLoadingMore(true);
    try {
      const res = await qc.fetchQuery(reads.feed(nestId, "comments", FEED_PAGE, feedComments.length));
      const fresh = res.items.filter((i): i is api.FeedCommentItem => i.type === "comment");
      setMorePages((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...fresh.filter((c) => !seen.has(c.id))];
      });
    } catch (e: any) {
      console.error("[ReviewTab] getNestFeed load-more failed", nestId, e);
      toast.error(e?.message || "Failed to load more comments");
    } finally {
      setFeedLoadingMore(false);
    }
  };

  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<"approve" | "reject" | null>(null);
  const runBulkReview = async (action: "approve" | "reject", note: string) => {
    const nodeIds = [...bulkSelected];
    const { succeeded, failed, results } = await api.bulkReview(nestId, action, nodeIds, note || undefined);
    const verb = action === "approve" ? "approved" : "rejected";
    if (failed === 0) {
      toast.success(`${succeeded} document${succeeded === 1 ? "" : "s"} ${verb}`);
      setBulkSelected(new Set());
    } else {
      // Each distinct reason, not just the first — a mixed batch fails for
      // more than one.
      const reasons = [...new Set(results.filter((r) => !r.ok).map((r) => r.error || "Unknown reason"))];
      toast.warning(`${succeeded} ${verb}, ${failed} could not be`, {
        description: reasons.join(" "),
        duration: 10000,
      });
      setBulkSelected(new Set(results.filter((r) => !r.ok).map((r) => r.nodeId)));
    }
    setBulkAction(null);
    void qc.invalidateQueries({ queryKey: keys.nest(nestId) });
    onRefresh();
  };

  return (
    <>
      {/* Feed filter chips — All shows changes + comments interleaved;
          Changes is the legacy queue; Comments is discussion only. */}
      <div className="flex items-center gap-1.5" data-testid="feed-filter-chips">
        {(
          [
            { key: "all", label: "All" },
            { key: "changes", label: `Changes (${reviewableQueue.length})` },
            // Authoritative server count — the loaded array is paged.
            { key: "comments", label: `Comments (${feedCommentsTotal})` },
          ] as const
        ).map((chip) => (
          <button
            key={chip.key}
            type="button"
            onClick={() => setFeedFilter(chip.key)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${feedFilter === chip.key
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            data-testid={`feed-filter-${chip.key}`}
          >
            {chip.label}
          </button>
        ))}
      </div>
      {/* The caller's own submissions, kept out of the actionable queue
          by separation-of-duties. Shown read-only so "submit for review"
          visibly lands somewhere. */}
      {feedFilter !== "comments" && myPendingSubmissions.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Send className="h-4 w-4 text-blue-600" />
              Submitted by you — awaiting review
            </CardTitle>
            <CardDescription>
              Your edits are awaiting review by another user. You can't
              approve your own work due to separation of duties.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {myPendingSubmissions.map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted/50"
              >
                <button
                  onClick={() => onOpenDocument(r.nodeId)}
                  className="flex-1 min-w-0 text-left truncate"
                >
                  {r.title || r.nodeId}
                </button>
                <Badge variant="secondary" className="text-[10px] shrink-0">
                  Awaiting review
                </Badge>
                {/* Your own submission, so the non-destructive exit
                    belongs here too (CU-wdqcq007pe). */}
                <Button
                  size="sm"
                  variant="ghost"
                  className="shrink-0 h-7 px-2 text-muted-foreground"
                  title="Withdraw this submission and return the document to Draft"
                  onClick={() => onWithdrawSubmission(r.nodeId)}
                >
                  Withdraw
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {/* Deletion flags raised by everyone below admin. Only nest
          admins/owners — the tier that deletes — resolve them. */}
      {canManage && pendingDeletions.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-destructive" />
              Deletion requests
            </CardTitle>
            <CardDescription>
              Documents flagged as stale. Delete them, or reject with a
              note.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {pendingDeletions.map((r) => (
              <div
                key={r.id}
                data-testid="deletion-request-item"
                className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
              >
                <button
                  className="flex-1 min-w-0 text-left"
                  onClick={() => onOpenDocument(r.nodeId)}
                >
                  <span className="font-medium truncate block">
                    {r.title || r.nodeId}
                    {r.targetType && r.targetType !== "document" && (
                      <span className="ml-2 rounded bg-muted px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {r.targetType === "folder"
                          ? "Folder"
                          : r.targetType === "nest_archive"
                            ? "Archive nest"
                            : "Nest"}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {r.requestedBy} — &ldquo;{r.reason}&rdquo;
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onResolveDeletion(r, "decline")
                  }
                >
                  Reject
                </Button>
                {/* Honouring an archive ask archives — reversible, so it
                    is an approval, not a destructive action. */}
                <Button
                  variant="ghost"
                  size="sm"
                  className={
                    r.targetType === "nest_archive"
                      ? ""
                      : "text-destructive hover:text-destructive hover:bg-destructive/10"
                  }
                  onClick={() =>
                    onResolveDeletion(r, "delete")
                  }
                >
                  {r.targetType === "nest_archive" ? "Approve" : "Delete"}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {/* Bulk bar — only with something selectable, and it stays out of
          the way until the first row is picked. */}
      {feedFilter !== "comments" && reviewableQueue.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          <Checkbox
            // Partial selections read as "some", not "none".
            checked={
              bulkSelected.size === 0
                ? false
                : bulkSelected.size === reviewableQueue.length
                  ? true
                  : "indeterminate"
            }
            onCheckedChange={(next: boolean | "indeterminate") =>
              setBulkSelected(
                next === true
                  ? new Set(reviewableQueue.map((r) => r.nodeId))
                  : new Set(),
              )
            }
            aria-label="Select every document you can review"
            data-testid="review-queue-select-all"
          />
          <span className="text-muted-foreground">
            {bulkSelected.size > 0
              ? `${bulkSelected.size} selected`
              : `Select all ${reviewableQueue.length}`}
          </span>
          {bulkSelected.size > BULK_REVIEW_LIMIT && (
            <span className="text-destructive">
              Up to {BULK_REVIEW_LIMIT} at a time — deselect{" "}
              {bulkSelected.size - BULK_REVIEW_LIMIT}.
            </span>
          )}
          {bulkSelected.size > 0 && (
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                disabled={bulkSelected.size > BULK_REVIEW_LIMIT}
                onClick={() => setBulkAction("approve")}
                data-testid="bulk-approve"
              >
                Approve {bulkSelected.size}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={bulkSelected.size > BULK_REVIEW_LIMIT}
                onClick={() => setBulkAction("reject")}
                data-testid="bulk-reject"
              >
                Reject {bulkSelected.size}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setBulkSelected(new Set())}
              >
                Clear
              </Button>
            </div>
          )}
        </div>
      )}
      <ReviewQueue
        requests={feedFilter === "comments" ? [] : reviewableQueue}
        selectedNodeIds={bulkSelected}
        // Rows only offer a checkbox when there is a batch to make — one
        // reviewable document has no bar to act on the selection, so a
        // box there is a dead end.
        onToggleSelect={
          reviewableQueue.length > 1
            ? (nodeId) =>
                setBulkSelected((prev) => {
                  const next = new Set(prev);
                  next.has(nodeId) ? next.delete(nodeId) : next.add(nodeId);
                  return next;
                })
            : undefined
        }
        // Feed mode (interleaved comment rows) except on the Changes
        // chip, which renders the legacy changes-only queue untouched.
        comments={feedFilter === "changes" ? undefined : feedComments}
        onSelectComment={(cm) =>
          onOpenDocument(cm.nodeId, { thread: cm.threadId })
        }
        loading={loading}
        onRefresh={onRefresh}
        onSelect={onSelectRequest}
      />
      {/* Comment activity is paged (50/page) — fetch the next page when
          more exists than what's loaded. Changes need no pager: they're
          the actionable pending set the queue already shows in full. */}
      {feedFilter !== "changes" &&
        feedComments.length < feedCommentsTotal && (
          <div className="flex justify-center">
            <Button
              variant="outline"
              size="sm"
              onClick={loadMoreComments}
              disabled={feedLoadingMore}
              data-testid="feed-load-more"
            >
              {feedLoadingMore ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : null}
              Load more comments (
              {feedCommentsTotal - feedComments.length} remaining)
            </Button>
          </div>
        )}
      {/* When the raw queue has entries but the reviewable filter
          emptied it, the queue card says "All caught up!" — which
          is wrong. Surface the gap so the user knows items exist
          but aren't actionable by them (scope or SoD). */}
      {feedFilter !== "comments" &&
        reviewQueue.length > 0 && reviewableQueue.length === 0 && (
          <p className="text-xs text-muted-foreground text-center">
            {reviewQueue.length === 1
              ? "1 pending review in this nest, but it doesn't require your action — it's either outside your steward scope or was submitted by you."
              : `${reviewQueue.length} pending reviews in this nest, but none require your action — they're either outside your steward scope or were submitted by you.`}
          </p>
        )}
      {bulkAction && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setBulkAction(null)}
          title={
            bulkAction === "approve"
              ? `Approve ${bulkSelected.size} document${bulkSelected.size === 1 ? "" : "s"}?`
              : `Reject ${bulkSelected.size} document${bulkSelected.size === 1 ? "" : "s"}?`
          }
          description={
            bulkAction === "approve"
              ? "Approving publishes each one. Anything you can't review, or that changed since this queue loaded, is reported back and left alone."
              : "Each author gets the same reason and the work goes back to them."
          }
          // Reject demands a reason in bulk exactly as it does one at a time.
          // Approve offers the same comment field the one-at-a-time flow has —
          // shared across the batch — without demanding one.
          label={bulkAction === "reject" ? "Why?" : "Comment (optional)"}
          optionalReason={bulkAction === "approve"}
          placeholder="Shared with every author in this batch"
          confirmLabel={bulkAction === "approve" ? "Approve all" : "Reject all"}
          destructive={bulkAction === "reject"}
          onConfirm={(reason) => runBulkReview(bulkAction, reason)}
        />
      )}
    </>
  );
}
