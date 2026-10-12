/**
 * MyWorkPage — My Work (/my-work): the cross-nest review inbox, what you are waiting on, and watcher notifications.
 */
import { Fragment, useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import * as api from "../../../lib/api";
import {
  NOTIFICATIONS_PREVIEW_COUNT,
  dismissNotification,
  visibleNotifications,
} from "../../../lib/notifications-preview";
import { useQueryClient } from "@tanstack/react-query";
import { reads } from "../../../lib/queries";
import { useAuth } from "../../../auth/AuthContext";
import { useAppNav } from "../../../lib/app-nav";
import {
  Check, Inbox, Trash2, Loader2, ChevronRight, ChevronLeft, CheckCircle2, XCircle,
} from "lucide-react";
import { BULK_REVIEW_LIMIT } from "../../../lib/constants";
import { splitWorkItems, workItemKey } from "../../../lib/my-work-groups";
import { toast } from "sonner";
import { relTime, formatServerDate } from "../../../lib/dates";
import { Button } from "@/components/ui/button";
import { PageTitle } from "@/components/ui/page-title";
import { APPROVE_BUTTON_CLASS, REJECT_BUTTON_CLASS } from "@/lib/review-actions-style";
import { Checkbox } from "@/components/ui/checkbox";
import { ReasonDialog, ReviewActions } from "../../../components/governance";
import { DueChip, PriorityIcon } from "../../../components/board/CardParts";
import { localToday } from "../../../lib/board-tasks";

export default function MyWorkPage() {
  const { openNest: onSelectNest, openReview: onOpenReview } = useAppNav();
  const { adminStatus } = useAuth();
  const currentUserEmail = adminStatus?.me?.email ?? null;
  const [work, setWork] = useState<{
    items: api.WorkItem[];
    waiting: api.WorkItem[];
    notifications?: api.WatcherNotification[];
    assigned?: api.AssignedItem[];
    pagination?: api.WorkPagination;
  }>({ items: [], waiting: [] });
  // Gates the "My Work" empty state — without it, the empty message flashes
  // on every mount/tab switch before the best-effort /me/work fetch resolves.
  const [workLoading, setWorkLoading] = useState(true);
  const [loadingMoreWork, setLoadingMoreWork] = useState(false);
  // Deletion flag being resolved from the inbox, and which dialog it opens.
  const [deletionTarget, setDeletionTarget] = useState<api.WorkItem | null>(null);
  const [deletionAction, setDeletionAction] = useState<"delete" | "decline">("delete");
  // Access request being denied from the inbox (the note dialog is open).
  const [denyAccessTarget, setDenyAccessTarget] = useState<api.WorkItem | null>(null);
  const [approvingAccessId, setApprovingAccessId] = useState<string | null>(null);
  // Bulk review straight from the inbox, keyed "<nestId>:<nodeId>" since this
  // list spans nests. Deletion rows are never selectable — they resolve
  // through their own flow and carry a different decision.
  const [workSelected, setWorkSelected] = useState<Set<string>>(new Set());
  const [workBulkAction, setWorkBulkAction] = useState<
    "approve" | "reject" | null
  >(null);
  // The notifications strip defaults to a compact 8-row preview (matches the
  // panel's original design); "Show all" reveals the rest of what the server
  // already fetched (up to 50, see /me/work) in a scrollable list instead of
  // discarding them.
  const [notificationsExpanded, setNotificationsExpanded] = useState(false);
  const qc = useQueryClient();
  const goToWorkPage = async (offset: number) => {
    setLoadingMoreWork(true);
    try {
      const next = await qc.fetchQuery(reads.myWork({ offset }));
      setWork((prev) => ({
        items: next.items,
        waiting: next.waiting,
        notifications: next.notifications ?? prev.notifications,
        assigned: next.assigned ?? prev.assigned,
        pagination: next.pagination,
      }));
      // A selection only means anything against the rows on screen. Carrying
      // it across a page turn (or over rows that just got resolved) left the
      // bar counting items the batch would then find nothing to act on.
      const onPage = new Set(next.items.map((w) => `${w.nest_id}:${w.node_id}`));
      setWorkSelected(
        (prev) => new Set([...prev].filter((key) => onPage.has(key))),
      );
    } catch (e) {
      console.error("[Dashboard] goToWorkPage failed", e);
    } finally {
      setLoadingMoreWork(false);
    }
  };


  // First page on mount, and again whenever the signed-in user changes (in
  // open mode the page stays mounted across login). Best-effort: a failed
  // read shows the empty inbox, not an error.
  useEffect(() => {
    qc
      .fetchQuery(reads.myWork())
      .then(setWork)
      .catch(() => setWork({ items: [], waiting: [], notifications: [] }))
      .finally(() => setWorkLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserEmail]);

  // Approve/reject both go through ReviewActions — the same required-feedback
  // dialog used in the in-nest flow (NestView, DocumentEditor) — so rejecting
  // from the inbox can't bypass the note requirement. Both throw on failure so
  // the error lands in the dialog instead of a swallowed console line.
  const approveReviewItem = async (w: api.WorkItem, note?: string) => {
    await api.approveReview(w.nest_id, w.node_id, note);
    dropWorkItem(w);
  };

  const rejectReviewItem = async (w: api.WorkItem, note: string) => {
    await api.rejectReview(w.nest_id, w.node_id, note);
    dropWorkItem(w);
  };

  const { reviews: reviewItems, requests: requestItems } = splitWorkItems(work.items);
  const workKey = (w: api.WorkItem) => `${w.nest_id}:${w.node_id}`;

  // The cap is per call and a call is per nest, so what matters is the biggest
  // per-nest group, not the total selection. How many to deselect, or 0.
  const workSelectionOverflow = (() => {
    const perNest = new Map<string, number>();
    for (const w of reviewItems) {
      if (!workSelected.has(workKey(w))) continue;
      perNest.set(w.nest_id, (perNest.get(w.nest_id) ?? 0) + 1);
    }
    const biggest = Math.max(0, ...perNest.values());
    return Math.max(0, biggest - BULK_REVIEW_LIMIT);
  })();

  // One decision over a selection that spans nests. The batch endpoint is
  // per-nest (a batch is bounded by the vault it writes to), so the selection
  // is grouped and each nest gets one call — the calls run together because
  // they touch different vaults, while items inside a nest stay sequential.
  const runWorkBulkReview = async (
    action: "approve" | "reject",
    note: string,
  ) => {
    const chosen = reviewItems.filter((w) => workSelected.has(workKey(w)));
    // Belt and braces: the selection is pruned as the inbox reloads, so this
    // should not happen — reporting "0 approved" as a success if it ever did
    // would be worse than saying nothing happened.
    if (chosen.length === 0) {
      toast.info("Nothing selected on this page");
      setWorkSelected(new Set());
      setWorkBulkAction(null);
      return;
    }
    const byNest = new Map<string, string[]>();
    for (const w of chosen) {
      byNest.set(w.nest_id, [...(byNest.get(w.nest_id) ?? []), w.node_id]);
    }
    const outcomes = await Promise.all(
      [...byNest].map(([nestId, nodeIds]) =>
        api
          .bulkReview(nestId, action, nodeIds, note || undefined)
          .then((res) => ({ nestId, ...res }))
          // A whole nest's call failing (offline, 403) is reported like any
          // other failure rather than losing the nests that did go through.
          .catch((err: any) => ({
            nestId,
            succeeded: 0,
            failed: nodeIds.length,
            results: nodeIds.map((nodeId) => ({
              nodeId,
              ok: false,
              error: err?.message || "Request failed",
            })),
          })),
      ),
    );
    const succeeded = outcomes.reduce((n, o) => n + o.succeeded, 0);
    const failed = outcomes.reduce((n, o) => n + o.failed, 0);
    const stillFailing = new Set(
      outcomes.flatMap((o) =>
        o.results.filter((r) => !r.ok).map((r) => `${o.nestId}:${r.nodeId}`),
      ),
    );
    const verb = action === "approve" ? "approved" : "rejected";
    if (failed === 0) {
      toast.success(`${succeeded} document${succeeded === 1 ? "" : "s"} ${verb}`);
    } else {
      // Items fail for different reasons ("not a steward", "already
      // resolved"), so name each distinct one rather than whichever came first.
      const reasons = [
        ...new Set(
          outcomes
            .flatMap((o) => o.results)
            .filter((r) => !r.ok)
            .map((r) => r.error || "Unknown reason"),
        ),
      ];
      toast.warning(`${succeeded} ${verb}, ${failed} could not be`, {
        description: reasons.join(" "),
        duration: 10000,
      });
    }
    // Keep the failures selected so a retry is one click, and let the inbox
    // reload decide what is actually left.
    setWorkSelected(stillFailing);
    setWorkBulkAction(null);
    void goToWorkPage(work.pagination?.offset ?? 0);
  };

  // An archive ask rides the deletion queue, but it is reversible and it
  // targets the nest — everything the inbox shows for it has to say archive,
  // not delete (CU-wdqcq01pe5).
  const isArchiveAsk = (w: api.WorkItem) => w.target_type === "nest_archive";
  const workItemKind = (w: api.WorkItem) =>
    w.type === "access"
      ? "Access"
      : w.type !== "deletion"
        ? "Review"
        : isArchiveAsk(w)
          ? "Archive"
          : "Deletion";

  // Access requests (CU-wdqcq041jn): approve grants the access straight away;
  // deny opens a dialog for an optional note to the requester.
  const approveAccessItem = async (w: api.WorkItem) => {
    setApprovingAccessId(w.request_id!);
    try {
      await api.approveAccessRequest(w.nest_id, w.request_id!);
      toast.success(`${w.requested_by} can now ${w.level === "read" ? "view" : "edit"} "${w.title}"`);
      dropWorkItem(w);
    } catch (err: any) {
      toast.error(err?.message || "Couldn't approve the request");
    } finally {
      setApprovingAccessId(null);
    }
  };
  const denyAccessItem = async (note: string) => {
    const w = denyAccessTarget!;
    await api.denyAccessRequest(w.nest_id, w.request_id!, note || undefined);
    dropWorkItem(w);
  };

  // Resolve a deletion flag straight from the inbox. Delete needs a confirm and
  // decline needs a note, so both go through ReasonDialog; the handlers throw
  // on failure so the error lands in the dialog, not a swallowed console line.
  const handleInboxDelete = async () => {
    const w = deletionTarget!;
    await api.approveDeletionRequest(w.nest_id, w.request_id!);
    dropWorkItem(w);
  };
  const handleInboxDecline = async (note: string) => {
    const w = deletionTarget!;
    await api.declineDeletionRequest(w.nest_id, w.request_id!, note);
    dropWorkItem(w);
  };
  // Withdraw your own pending deletion request from the "Waiting on others" list.
  const handleWithdrawDeletion = async (w: api.WorkItem) => {
    await api.withdrawDeletionRequest(w.nest_id, w.request_id!);
    setWork((prev) => ({
      ...prev,
      waiting: prev.waiting.filter(
        (x) => !(x.nest_id === w.nest_id && x.node_id === w.node_id),
      ),
    }));
  };
  // Withdraw your own pending review — the document goes back to Draft
  // instead of the only non-destructive exit being Delete (CU-wdqcq007pe).
  const handleWithdrawReview = async (w: api.WorkItem) => {
    await api.cancelReview(w.nest_id, w.node_id);
    setWork((prev) => ({
      ...prev,
      waiting: prev.waiting.filter(
        (x) => !(x.nest_id === w.nest_id && x.node_id === w.node_id),
      ),
    }));
  };
  // A folder or nest deletion item carries a folder path / nest id in node_id,
  // not a document id — opening the editor on it lands on a page for a node
  // that was never there. Send those to the nest instead.
  const openWorkItem = (w: api.WorkItem) => {
    if (
      (w.type === "deletion" && w.target_type && w.target_type !== "document") ||
      (w.type === "access" && w.target_type !== "node")
    ) {
      onSelectNest(w.nest_id, w.nest_name, false, false);
      return;
    }
    onOpenReview(w.nest_id, w.nest_name, w.node_id);
  };

  // A notification names a document or a nest — clicking it goes there. The
  // document is the target when the row resolves to one; otherwise the nest.
  // The row carries nest_id + nest_name from the server, so no nest list is
  // fetched for this — same shape work items use. Opening it also marks it
  // read, same as the per-row dismiss button, so it doesn't keep sitting in
  // the (unread-only) list — the mutation's own invalidatePath("/me")
  // refreshes the cached /me/work read for everyone else subscribed to it.
  const openNotification = (n: api.WatcherNotification) => {
    api.markNotificationsRead([n.id]).catch(() => {});
    setWork((prev) => ({
      ...prev,
      notifications: dismissNotification(prev.notifications ?? [], n.id),
    }));
    if (n.node_id) onOpenReview(n.nest_id, n.nest_name, n.node_id);
    else onSelectNest(n.nest_id, n.nest_name, false, false);
  };

  const dropWorkItem = (w: api.WorkItem) => {
    setWork((prev) => ({
      ...prev,
      items: prev.items.filter((i) => workItemKey(i) !== workItemKey(w)),
    }));
    // A row resolved on its own can't stay in the batch selection.
    setWorkSelected((prev) => {
      const next = new Set(prev);
      next.delete(`${w.nest_id}:${w.node_id}`);
      return next;
    });
    void goToWorkPage(work.pagination?.offset ?? 0);
  };

  return (
    <div className="space-y-4">
      <PageTitle icon={Inbox} title="My Work" description="Reviews and requests waiting on you, and what you handed off." className="mb-0" />
      <div>
          {/* My Work — cross-nest inbox. Slack/CRM-clean: two tight lists, every
          row clicks straight to the document (circular nav), approve/reject
          inline. "My Work" = waiting on you; "Waiting on" = you handed off. */}
          <div className="space-y-5">
            {/* Board cards assigned to you, across nests — Linear's "My
                issues". Soonest due first; click opens the card. */}
            {(work.assigned?.length ?? 0) > 0 && (
              <div className="rounded-lg border">
                <div className="flex items-center gap-2 px-4 py-2 text-sm font-medium">
                  Assigned to you
                  <span className="text-xs text-muted-foreground">({work.assigned!.length})</span>
                </div>
                <div className="divide-y border-t">
                  {work.assigned!.map((a) => (
                    <button
                      key={`${a.nest_id}:${a.node_id}`}
                      type="button"
                      onClick={() => onOpenReview(a.nest_id, a.nest_name, a.node_id)}
                      className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted/50"
                    >
                      <PriorityIcon priority={a.priority ?? undefined} />
                      <span className="min-w-0 flex-1 truncate">{a.title}</span>
                      {a.due && (
                        <DueChip due={a.due} today={localToday()} editable={false} onChange={() => {}} />
                      )}
                      <span className="shrink-0 text-xs text-muted-foreground">{a.nest_name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div>
              {(work.notifications?.length ?? 0) > 0 && (
                <div className="mb-3 rounded-lg border border-amber-300/50 bg-amber-500/5">
                  <div className="px-4 py-2 flex items-center gap-2 text-sm font-medium">
                    🔔 Notifications
                    <span className="text-xs text-muted-foreground">
                      ({work.notifications!.length})
                    </span>
                    <div className="flex-1" />
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={async () => {
                        await api.markNotificationsRead("all");
                        setWork((prev) => ({ ...prev, notifications: [] }));
                      }}
                    >
                      Mark all read
                    </button>
                  </div>
                  <div
                    className={cn(
                      "divide-y border-t",
                      notificationsExpanded && "max-h-80 overflow-y-auto",
                    )}
                  >
                    {visibleNotifications(
                      work.notifications!,
                      notificationsExpanded,
                    ).map((n) => (
                      <div
                        key={n.id}
                        className="flex items-center gap-2 px-4 py-2 text-xs hover:bg-amber-500/10"
                      >
                        <button
                          type="button"
                          onClick={() => openNotification(n)}
                          className="flex-1 flex items-center gap-2 text-left"
                        >
                          <span className="flex-1">{n.message}</span>
                          <span className="text-muted-foreground shrink-0">
                            {formatServerDate(n.created_at)}
                          </span>
                        </button>
                        {/* Per-row dismiss: "Mark all read" alone forces an
                            all-or-nothing triage (CU-wdqcq007pu). */}
                        <button
                          type="button"
                          title="Mark as read"
                          aria-label="Mark as read"
                          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-amber-500/20 hover:text-foreground"
                          onClick={async () => {
                            try {
                              await api.markNotificationsRead([n.id]);
                              setWork((prev) => ({
                                ...prev,
                                notifications: dismissNotification(
                                  prev.notifications ?? [],
                                  n.id,
                                ),
                              }));
                            } catch (err: any) {
                              // Same feedback the row's siblings give — a
                              // silent failure left the row sitting there
                              // with no explanation.
                              toast.error(
                                err?.message || "Failed to mark as read",
                              );
                            }
                          }}
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                  {work.notifications!.length > NOTIFICATIONS_PREVIEW_COUNT && (
                    <div className="border-t px-4 py-1.5 text-center">
                      <button
                        type="button"
                        className="text-xs text-primary hover:underline"
                        onClick={() =>
                          setNotificationsExpanded((expanded) => !expanded)
                        }
                      >
                        {notificationsExpanded
                          ? "Show less"
                          : `Show all (${work.notifications!.length})`}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {workLoading ? (
                // Loader, not the empty state: "nothing here" while the
                // best-effort /me/work fetch is still in flight reads as an
                // answer, same reasoning as draftsLoading below.
                <div className="rounded-lg border bg-muted/20 px-4 py-6 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading your work…
                </div>
              ) : work.items.length === 0 ? (
                <div className="rounded-lg border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
                  You're all caught up — nothing waiting on you.
                </div>
              ) : (
                <div className="rounded-lg border divide-y overflow-hidden">
                  {/* Batch decision bar — a folder import lands here as many
                      rows carrying the same decision. Reviews only. */}
                  {reviewItems.length > 1 && (
                    <div className="flex flex-wrap items-center gap-2 bg-muted/40 px-4 py-2 text-sm">
                      <Checkbox
                        // Partial selections read as "some", not "none".
                        checked={
                          workSelected.size === 0
                            ? false
                            : workSelected.size === reviewItems.length
                              ? true
                              : "indeterminate"
                        }
                        onCheckedChange={(next: boolean | "indeterminate") =>
                          setWorkSelected(
                            next === true
                              ? new Set(reviewItems.map(workKey))
                              : new Set(),
                          )
                        }
                        aria-label="Select every review waiting on you"
                        data-testid="work-select-all"
                      />
                      <span className="text-muted-foreground">
                        {workSelected.size > 0
                          ? `${workSelected.size} selected`
                          : `Select all ${reviewItems.length} reviews`}
                      </span>
                      {workSelectionOverflow > 0 && (
                        <span className="text-destructive">
                          Up to {BULK_REVIEW_LIMIT} per nest — deselect{" "}
                          {workSelectionOverflow}.
                        </span>
                      )}
                      {workSelected.size > 0 && (
                        <div className="ml-auto flex items-center gap-2">
                          <Button
                            size="sm"
                            disabled={workSelectionOverflow > 0}
                            onClick={() => setWorkBulkAction("approve")}
                            data-testid="work-bulk-approve"
                          >
                            Approve {workSelected.size}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={workSelectionOverflow > 0}
                            onClick={() => setWorkBulkAction("reject")}
                            data-testid="work-bulk-reject"
                          >
                            Reject {workSelected.size}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setWorkSelected(new Set())}
                          >
                            Clear
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                  {[...reviewItems, ...requestItems].map((w, i) => {
                    const key = `${w.nest_id}:${w.node_id}`;
                    return (
                      <Fragment key={workItemKey(w)}>
                      {i === reviewItems.length && (
                        <div className="bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
                          {requestItems.length} {requestItems.length === 1 ? "request" : "requests"} · approve or reject each one
                        </div>
                      )}
                      <div
                        className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40 group"
                      >
                        {reviewItems.length > 1 && (
                          <Checkbox
                            checked={workSelected.has(key)}
                            // Deletion rows keep their own two-way decision, so
                            // they hold the column without being selectable.
                            disabled={w.type !== "review"}
                            onCheckedChange={() =>
                              setWorkSelected((prev) => {
                                const next = new Set(prev);
                                next.has(key) ? next.delete(key) : next.add(key);
                                return next;
                              })
                            }
                            aria-label={`Select ${w.title}`}
                            className={w.type === "review" ? "" : "invisible"}
                          />
                        )}
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide shrink-0 ${w.type === "deletion" && !isArchiveAsk(w)
                              ? "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300"
                              : "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                            }`}
                        >
                          {workItemKind(w)}
                        </span>
                        <button
                          onClick={() => openWorkItem(w)}
                          className="flex items-center gap-2 min-w-0 flex-1 text-left"
                        >
                          <span className="font-medium truncate">{w.title}</span>
                          <span className="text-xs text-muted-foreground truncate">
                            in {w.nest_name} · {w.requested_by} · {relTime(w.requested_at)}
                            {w.reason ? ` · "${w.reason}"` : ""}
                          </span>
                        </button>
                        <div className="flex items-center gap-2 shrink-0">
                          {w.type === "access" ? (
                            <>
                              <Button
                                variant="outline"
                                className={APPROVE_BUTTON_CLASS}
                                onClick={() => void approveAccessItem(w)}
                                disabled={approvingAccessId === w.request_id}
                                data-testid="my-work-access-approve"
                              >
                                <CheckCircle2 className="h-4 w-4 mr-2" /> Approve
                              </Button>
                              <Button
                                variant="outline"
                                className={REJECT_BUTTON_CLASS}
                                onClick={() => setDenyAccessTarget(w)}
                                data-testid="my-work-access-deny"
                              >
                                <XCircle className="h-4 w-4 mr-2" /> Deny
                              </Button>
                            </>
                          ) : w.type === "deletion" ? (
                            <>
                              {/* Honouring an archive ask archives — it is an
                                  approval, not a destruction, so it says so and
                                  wears the same green/red pair as ReviewActions. */}
                              <Button
                                variant="outline"
                                className={
                                  isArchiveAsk(w)
                                    ? APPROVE_BUTTON_CLASS
                                    : "text-destructive hover:text-destructive"
                                }
                                onClick={() => {
                                  setDeletionAction("delete");
                                  setDeletionTarget(w);
                                }}
                              >
                                {isArchiveAsk(w) ? (
                                  <CheckCircle2 className="h-4 w-4 mr-2" />
                                ) : (
                                  <Trash2 className="h-4 w-4 mr-2" />
                                )}
                                {isArchiveAsk(w) ? "Approve" : "Delete"}
                              </Button>
                              <Button
                                variant="outline"
                                className={REJECT_BUTTON_CLASS}
                                onClick={() => {
                                  setDeletionAction("decline");
                                  setDeletionTarget(w);
                                }}
                              >
                                <XCircle className="h-4 w-4 mr-2" /> Reject
                              </Button>
                            </>
                          ) : (
                            <ReviewActions
                              documentTitle={w.title}
                              version={1}
                              onApprove={(note) => approveReviewItem(w, note)}
                              onReject={(note) => rejectReviewItem(w, note)}
                            />
                          )}
                        </div>
                      </div>
                      </Fragment>
                    );
                  })}
                </div>
              )}
            </div>

            {work.waiting.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                    Waiting on others
                  </h3>
                  <span className="rounded-full bg-muted text-muted-foreground text-xs font-semibold px-2 py-0.5">
                    {work.waiting.length}
                  </span>
                </div>
                <div className="rounded-lg border divide-y overflow-hidden">
                  {work.waiting.map((w) => (
                    <div
                      key={workItemKey(w)}
                      className="flex items-center gap-3 px-4 py-2 hover:bg-muted/40 group text-sm"
                    >
                      <button
                        onClick={() => openWorkItem(w)}
                        className="flex items-center gap-3 flex-1 min-w-0 text-left"
                      >
                        <span className="font-medium truncate">{w.title}</span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          in {w.nest_name} ·{" "}
                          {w.type === "review" ? "submitted" : "requested"}{" "}
                          {relTime(w.requested_at)}
                        </span>
                        <span className="flex-1" />
                        <span className="text-xs text-muted-foreground">
                          {w.type === "access"
                            ? "Access Requested"
                            : w.type !== "deletion"
                              ? "Pending Review"
                              : isArchiveAsk(w)
                                ? "Archive Requested"
                                : "Deletion Requested"}
                        </span>
                      </button>
                      {w.type === "deletion" && w.request_id && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="shrink-0 text-muted-foreground h-7 px-2"
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              await handleWithdrawDeletion(w);
                              toast.success(
                                isArchiveAsk(w)
                                  ? "Archive request withdrawn"
                                  : "Deletion request withdrawn",
                              );
                            } catch (err: any) {
                              // Same feedback the nest view and the editor give
                              // for this action — a silent no-op left the row
                              // sitting there with no explanation.
                              toast.error(
                                err?.message || "Failed to withdraw deletion request",
                              );
                            }
                          }}
                          title="Withdraw this deletion request"
                        >
                          Withdraw
                        </Button>
                      )}
                      {w.type === "review" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="shrink-0 text-muted-foreground h-7 px-2"
                          onClick={async (e) => {
                            e.stopPropagation();
                            try {
                              await handleWithdrawReview(w);
                              toast.success(
                                "Submission withdrawn — back to Draft",
                              );
                            } catch (err: any) {
                              toast.error(
                                err?.message || "Failed to withdraw submission",
                              );
                            }
                          }}
                          title="Withdraw this submission and return the document to Draft"
                        >
                          Withdraw
                        </Button>
                      )}
                      <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:translate-x-0.5 transition-transform shrink-0" />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {work.pagination && work.pagination.total > work.pagination.limit && (
              <div className="flex items-center justify-center gap-3 pt-1 text-sm text-muted-foreground">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loadingMoreWork || work.pagination.offset === 0}
                  onClick={() =>
                    goToWorkPage(Math.max(0, work.pagination!.offset - work.pagination!.limit))
                  }
                >
                  <ChevronLeft className="h-3.5 w-3.5 mr-1" />
                  Prev
                </Button>
                <span>
                  Page {Math.floor(work.pagination.offset / work.pagination.limit) + 1} of{" "}
                  {Math.max(1, Math.ceil(work.pagination.total / work.pagination.limit))}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={loadingMoreWork || !work.pagination.has_more}
                  onClick={() =>
                    goToWorkPage(work.pagination!.offset + work.pagination!.limit)
                  }
                >
                  Next
                  <ChevronRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              </div>
            )}
          </div>
      </div>


      {workBulkAction && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setWorkBulkAction(null)}
          title={
            workBulkAction === "approve"
              ? `Approve ${workSelected.size} document${workSelected.size === 1 ? "" : "s"}?`
              : `Reject ${workSelected.size} document${workSelected.size === 1 ? "" : "s"}?`
          }
          description={
            workBulkAction === "approve"
              ? "Approving publishes each one. Anything that changed since this inbox loaded is reported back and left alone."
              : "Each author gets the same reason and the work goes back to them."
          }
          // Rejecting in bulk demands a reason exactly as one at a time does.
          // Approving offers the same comment field, shared across the batch,
          // without demanding one — as the review queue's bulk approve does.
          label={workBulkAction === "reject" ? "Why?" : "Comment (optional)"}
          optionalReason={workBulkAction === "approve"}
          placeholder="Shared with every author in this batch"
          confirmLabel={
            workBulkAction === "approve" ? "Approve all" : "Reject all"
          }
          destructive={workBulkAction === "reject"}
          onConfirm={(reason) => runWorkBulkReview(workBulkAction, reason)}
        />
      )}

      {denyAccessTarget && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setDenyAccessTarget(null)}
          title={`Deny ${denyAccessTarget.requested_by}'s request?`}
          description={`They asked to edit "${denyAccessTarget.title}"${denyAccessTarget.reason ? `: "${denyAccessTarget.reason}"` : ""}. They keep the access they have now and are told your answer.`}
          label="Note to them (optional)"
          optionalReason
          placeholder="e.g. pricing is locked until the quarter closes"
          confirmLabel="Deny"
          destructive
          onConfirm={denyAccessItem}
        />
      )}

      {deletionTarget && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setDeletionTarget(null)}
          title={
            deletionAction !== "delete"
              ? `Reject this ${isArchiveAsk(deletionTarget) ? "archive" : "deletion"} request`
              : isArchiveAsk(deletionTarget)
                ? `Archive "${deletionTarget.title}"?`
                : `Delete "${deletionTarget.title}"?`
          }
          description={`${deletionTarget.requested_by} asked for this: "${deletionTarget.reason ?? ""}". ${deletionAction !== "delete"
              ? isArchiveAsk(deletionTarget)
                ? "The nest stays where it is; your note is the record, and the requester is notified."
                : "The document stays; your note is the record, and the requester is notified."
              : isArchiveAsk(deletionTarget)
                ? "The nest goes read-only and leaves the dashboard; nothing is deleted and you can restore it."
                : "Deleting removes the document, its history, comments and annotations. It cannot be undone."
            }`}
          label={
            deletionAction === "decline" ? "Why are you rejecting?" : undefined
          }
          placeholder="e.g. still referenced by onboarding"
          confirmLabel={
            deletionAction !== "delete"
              ? "Reject"
              : isArchiveAsk(deletionTarget)
                ? "Archive nest"
                : "Delete document"
          }
          destructive={
            deletionAction === "delete" && !isArchiveAsk(deletionTarget)
          }
          onConfirm={
            deletionAction === "delete" ? handleInboxDelete : handleInboxDecline
          }
        />
      )}

    </div>
  );
}
