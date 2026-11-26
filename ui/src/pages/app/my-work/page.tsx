/**
 * MyWorkPage — My Work (/my-work): tasks assigned to you, the cross-nest review inbox, what you are waiting on, and watcher notifications.
 */
import { useState, useEffect, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import * as api from "../../../lib/api";
import {
  NOTIFICATIONS_PREVIEW_COUNT,
  dismissNotification,
  visibleNotifications,
} from "../../../lib/notifications-preview";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { reads } from "../../../lib/queries";
import { useAuth } from "../../../auth/AuthContext";
import { useAppNav } from "../../../lib/app-nav";
import {
  ArrowLeft, Bell, Check, Inbox, Trash2, Loader2, ChevronRight, ChevronLeft, CheckCircle2, FileText, Pencil, Send, XCircle,
} from "lucide-react";
import { BULK_REVIEW_LIMIT } from "../../../lib/constants";
import { splitWorkItems, workItemKey } from "../../../lib/my-work-groups";
import { toast } from "sonner";
import { relTime, formatServerDate } from "../../../lib/dates";
import { Button } from "@/components/ui/button";
import { APPROVE_BUTTON_CLASS, REJECT_BUTTON_CLASS } from "@/lib/review-actions-style";
import { Checkbox } from "@/components/ui/checkbox";
import { ReasonDialog, ReviewPane, SubmitForReviewModal } from "../../../components/governance";
import { MyWorkReviewPane } from "../../../components/MyWorkReviewPane";
import { localToday } from "../../../lib/board-tasks";
import { MentionRows } from "../../../components/my-work/MentionRows";
import { keyOfConversationId } from "../../../lib/chat-live";
import { QueueRow } from "../../../components/my-work/QueueRow";
import { splitDrafts, upToDateReviews, type ReviewQueueKey } from "../../../lib/review-queues";
import { AssignedTasks } from "../../../components/my-work/AssignedTasks";
import { emptyPageStepBack, mergeLiveWork } from "../../../lib/my-work-inbox";
import { openTasks, type TaskStatusFilter } from "../../../lib/my-work-tasks";

type WorkTab = "reviews" | "tasks" | "mentions" | "notifications";

function RowBadge({ tone, children }: { tone: "red" | "amber"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 text-[10px] font-semibold uppercase tracking-wide",
        tone === "red"
          ? "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300"
          : "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
      )}
    >
      {children}
    </span>
  );
}

/** Sizes the workspace to the space under the app header. */
function fitTop(el: HTMLDivElement | null) {
  if (el) el.style.setProperty("--my-work-top", `${Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY))}px`);
}

export default function MyWorkPage() {
  const { openNest: onSelectNest, openReview: onOpenReview, openChannel, goBack, initialReview } = useAppNav();
  const { adminStatus } = useAuth();
  const currentUserEmail = adminStatus?.me?.email ?? null;
  const [rawWork, setWork] = useState<{
    items: api.WorkItem[];
    waiting: api.WorkItem[];
    notifications?: api.WatcherNotification[];
    assigned?: api.AssignedItem[];
    pagination?: api.WorkPagination;
    mentions?: api.MentionItem[];
    mentions_pagination?: api.WorkPagination;
  }>({ items: [], waiting: [] });
  const [loadingMentions, setLoadingMentions] = useState(false);
  // One nest, or all of them.
  const [nestFilter, setNestFilter] = useState<string>("all");
  const nestOptions = (() => {
    const m = new Map<string, string>();
    for (const w of [...rawWork.items, ...rawWork.waiting]) m.set(w.nest_id, w.nest_name);
    for (const a of rawWork.assigned ?? []) m.set(a.nest_id, a.nest_name);
    for (const n of rawWork.notifications ?? []) m.set(n.nest_id, n.nest_name);
    for (const x of rawWork.mentions ?? []) m.set(x.nest_id, x.nest_name);
    return [...m].sort((a, b) => a[1].localeCompare(b[1]));
  })();
  const inNest = (id: string) => nestFilter === "all" || id === nestFilter;
  const work = {
    ...rawWork,
    items: rawWork.items.filter((w) => inNest(w.nest_id)),
    waiting: rawWork.waiting.filter((w) => inNest(w.nest_id)),
    assigned: (rawWork.assigned ?? []).filter((a) => inNest(a.nest_id)),
    notifications: (rawWork.notifications ?? []).filter((n) => inNest(n.nest_id)),
    mentions: rawWork.mentions?.filter((m) => inNest(m.nest_id)),
  };
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
  const [queue, setQueue] = useState<ReviewQueueKey>("review");
  const { data: draftData } = useQuery(reads.myDrafts({ limit: 100 }));
  const [submitDraft, setSubmitDraft] = useState<api.MyDraft | null>(null);
  const [discardTarget, setDiscardTarget] = useState<api.MyDraft | null>(null);
  // What kind of work is showing; reviews first.
  const [tab, setTab] = useState<WorkTab>("reviews");
  // Finished tasks load only when the Tasks filter asks for Done or All.
  const [withDone, setWithDone] = useState(false);
  const [loadingDone, setLoadingDone] = useState(false);
  // The change open beside the list.
  const [openRev, setOpenRev] = useState<{ nestId: string; nodeId: string; requestId?: string } | null>(initialReview ?? null);
  // A new change handed in while the page is open (See changes, an old link).
  useEffect(() => {
    if (initialReview) setOpenRev(initialReview);
  }, [initialReview]);
  // Clicking My Work in the nav while a change is open goes back to the list.
  useEffect(() => {
    const home = () => setOpenRev(null);
    window.addEventListener("my-work:home", home);
    return () => window.removeEventListener("my-work:home", home);
  }, []);
  // The page on screen, watched: re-read on focus and every half minute, so a
  // decision made elsewhere leaves the list and its counts.
  const { data: liveWork } = useQuery(
    reads.myWork({ offset: rawWork.pagination?.offset || undefined, doneTasks: withDone || undefined }),
  );
  useEffect(() => {
    if (!liveWork) return;
    setWork((prev) => mergeLiveWork(prev, liveWork));
    pruneSelection(liveWork.items);
    const back = emptyPageStepBack(liveWork);
    if (back !== null) void goToWorkPage(back);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveWork]);
  // A selection only means anything against the rows on screen. Carrying it
  // across a page turn (or over rows that just got resolved) left the bar
  // counting items the batch would then find nothing to act on.
  const pruneSelection = (items: api.WorkItem[]) => {
    const onPage = new Set(items.map((w) => `${w.nest_id}:${w.node_id}`));
    setWorkSelected((prev) => new Set([...prev].filter((key) => onPage.has(key))));
  };
  const goToWorkPage = async (offset: number) => {
    setLoadingMoreWork(true);
    try {
      const next = await qc.fetchQuery(reads.myWork({ offset: offset || undefined, doneTasks: withDone || undefined }));
      setWork((prev) => ({
        items: next.items,
        waiting: next.waiting,
        notifications: next.notifications ?? prev.notifications,
        assigned: next.assigned ?? prev.assigned,
        pagination: next.pagination,
        // Review paging leaves the mentions page where it was.
        mentions: prev.mentions,
        mentions_pagination: prev.mentions_pagination,
      }));
      pruneSelection(next.items);
    } catch (e) {
      console.error("[Dashboard] goToWorkPage failed", e);
    } finally {
      setLoadingMoreWork(false);
    }
  };


  // Mentions page on their own cursor (mentions_offset); the rest of the
  // inbox stays as it is.
  const goToMentionsPage = async (mentionsOffset: number) => {
    setLoadingMentions(true);
    try {
      const next = await qc.fetchQuery(reads.myWork({ mentionsOffset }));
      setWork((prev) => ({ ...prev, mentions: next.mentions, mentions_pagination: next.mentions_pagination }));
    } catch (e) {
      console.error("[MyWork] goToMentionsPage failed", e);
    } finally {
      setLoadingMentions(false);
    }
  };

  // Jump to the thread: a channel post opens the channel timeline with the
  // thread open; a document comment opens the document with it focused.
  const openMention = (m: api.MentionItem) => {
    const conv = m.kind === "conversation" ? keyOfConversationId(m.node_id) : null;
    if (conv) {
      openChannel(m.nest_id, m.nest_name, conv, m.thread_id);
      return;
    }
    if (m.kind === "channel" && m.channel) {
      // In-app, like every other row: no full page load (PO-1189).
      openChannel(m.nest_id, m.nest_name, m.channel, m.thread_id);
      return;
    }
    onOpenReview(m.nest_id, m.nest_name, m.node_id, { thread: m.thread_id });
  };

  // "Mark done": the row leaves the list at once; the sidebar badge follows
  // from the same write (it drops the cached /me/work reads). The message and
  // the thread are untouched, and the row returns only on a new mention.
  const [doneThread, setDoneThread] = useState<string | null>(null);
  const markMentionDone = async (m: api.MentionItem) => {
    setDoneThread(m.thread_id);
    try {
      await api.markMentionDone(m.thread_id);
      setWork((prev) => {
        const mentions = (prev.mentions ?? []).filter((x) => x.thread_id !== m.thread_id);
        const page = prev.mentions_pagination;
        return {
          ...prev,
          mentions,
          mentions_pagination: page ? { ...page, total: Math.max(0, page.total - 1) } : page,
        };
      });
      // The page just emptied but more remain: show them rather than nothing.
      const page = work.mentions_pagination;
      if (page && (work.mentions?.length ?? 0) === 1 && page.total > 1) {
        void goToMentionsPage(Math.max(0, page.offset - (page.has_more ? 0 : page.limit)));
      }
    } catch (e: any) {
      toast.error(e?.message || "Could not mark the mention done");
    } finally {
      setDoneThread(null);
    }
  };

  // Done / All asks the server for finished tasks once; Open needs nothing
  // new (the list filters client-side from then on).
  const onTaskStatusChange = async (status: TaskStatusFilter) => {
    if (status === "open" || withDone) return;
    setLoadingDone(true);
    try {
      const next = await qc.fetchQuery(reads.myWork({ doneTasks: true }));
      setWork((prev) => ({ ...prev, assigned: next.assigned ?? prev.assigned }));
      setWithDone(true);
    } catch (e: any) {
      toast.error(e?.message || "Could not load finished tasks");
    } finally {
      setLoadingDone(false);
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

  const { reviews: reviewItems, requests: requestItems } = splitWorkItems(work.items);
  const workKey = (w: api.WorkItem) => `${w.nest_id}:${w.node_id}`;
  const listItems = [...reviewItems, ...requestItems];
  const openTaskCount = openTasks(work.assigned).length;
  // After a decision in the pane: drop the row, then move on to the next review.
  const afterDecision = () => {
    if (!openRev) return;
    const idx = reviewItems.findIndex((w) => w.nest_id === openRev.nestId && w.node_id === openRev.nodeId);
    const next = reviewItems[idx + 1] ?? reviewItems[idx - 1];
    if (idx >= 0) dropWorkItem(reviewItems[idx]);
    setOpenRev(next ? { nestId: next.nest_id, nodeId: next.node_id } : null);
  };

  // Skip: the next approval after the open one, wrapping round. Only your own
  // approvals count, so it never lands on a row you cannot decide.
  const skipTarget = (() => {
    if (!openRev || reviewItems.length < 2) return null;
    const i = reviewItems.findIndex((w) => w.nest_id === openRev.nestId && w.node_id === openRev.nodeId);
    return i === -1 ? null : reviewItems[(i + 1) % reviewItems.length]!;
  })();

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
    // A change waiting on you is decided in the Review tab's side pane, which
    // opens on its changes — the same screen the nest's queue opens.
    if (w.type === "review") {
      setOpenRev({ nestId: w.nest_id, nodeId: w.node_id });
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

  const mentionCount = work.mentions_pagination?.total ?? work.mentions?.length ?? 0;
  const { drafts: draftRows, sentBack } = splitDrafts((draftData?.drafts ?? []).filter((d) => inNest(d.nest_id)));
  const draftList = queue === "sent_back" ? sentBack : draftRows;
  const onePage = !work.pagination || work.pagination.total <= work.pagination.limit;
  const reviewCount =
    onePage || nestFilter !== "all" ? listItems.length : Math.max(0, work.pagination!.total - work.waiting.length);
  const queues: Array<{ key: ReviewQueueKey; label: string; count: number }> = [
    { key: "review", label: "Review", count: reviewCount },
    { key: "sent_back", label: "Sent back", count: sentBack.length },
    { key: "drafts", label: "Drafts", count: draftRows.length },
    { key: "mine", label: "Mine", count: work.waiting.length },
  ];
  const sections: Array<{ key: WorkTab; label: string; count: number }> = [
    { key: "reviews", label: "Reviews", count: reviewCount },
    { key: "tasks", label: "Tasks", count: openTaskCount },
    { key: "mentions", label: "Mentions", count: mentionCount },
    { key: "notifications", label: "Notifications", count: work.notifications?.length ?? 0 },
  ];
  const upToDate = upToDateReviews(reviewItems);
  const workRows = queue === "mine" ? work.waiting : listItems;
  const isOpen = (w: { nest_id: string; node_id: string }, requestId?: string) =>
    openRev?.nestId === w.nest_id && openRev.nodeId === w.node_id && (openRev.requestId ?? "") === (requestId ?? "");
  const rowRequestId = (w: api.WorkItem) => (w.type === "review" ? undefined : w.request_id);
  const openRow = (w: api.WorkItem) => setOpenRev({ nestId: w.nest_id, nodeId: w.node_id, requestId: rowRequestId(w) });
  const openItem = openRev
    ? [...work.items, ...work.waiting].find((w) => isOpen(w, rowRequestId(w))) ?? null
    : null;
  const openDraft = openRev && (queue === "drafts" || queue === "sent_back") ? draftList.find((d) => isOpen(d)) ?? null : null;
  const isMine = (w: api.WorkItem) => work.waiting.some((x) => workItemKey(x) === workItemKey(w) && x.type === w.type);
  const openNestName =
    openItem?.nest_name ?? openDraft?.nest_name ?? nestOptions.find(([id]) => id === openRev?.nestId)?.[1] ?? "";
  // The pane is never empty while the queue has something in it: on a screen
  // with room for both, the first row opens by itself.
  const firstRow = queue === "review" || queue === "mine" ? workRows[0] : draftList[0];
  const firstKey = firstRow ? `${firstRow.nest_id}:${firstRow.node_id}` : "";
  useEffect(() => {
    if (openRev || !firstRow || tab !== "reviews" || !window.matchMedia("(min-width: 1024px)").matches) return;
    if ("request_id" in firstRow || "requested_by" in firstRow) openRow(firstRow as api.WorkItem);
    else setOpenRev({ nestId: firstRow.nest_id, nodeId: firstRow.node_id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRev, firstKey, queue, tab]);

  // A draft that was submitted or discarded has left its queue: let go of it.
  useEffect(() => {
    if ((queue === "drafts" || queue === "sent_back") && openRev && draftData && !openDraft) setOpenRev(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, openRev, draftData]);

  const refreshDrafts = () => qc.invalidateQueries({ queryKey: ["me", "drafts"] });
  const withdraw = async (w: api.WorkItem) => {
    try {
      if (w.type === "review") await handleWithdrawReview(w);
      else await handleWithdrawDeletion(w);
      toast.success(
        w.type === "review"
          ? "Submission withdrawn — back to Draft"
          : isArchiveAsk(w)
            ? "Archive request withdrawn"
            : "Deletion request withdrawn",
      );
      setOpenRev(null);
      void refreshDrafts();
    } catch (err: any) {
      toast.error(err?.message || "Failed to withdraw");
    }
  };
  const discard = async (d: api.MyDraft) => {
    const res = await api.discardDraft(d.nest_id, d.node_id);
    toast.success(res.deleted ? "Draft deleted" : "Restored to the approved version");
    setOpenRev(null);
    void refreshDrafts();
  };
  const closePane = () => setOpenRev(null);

  // A deletion, archive or access request: no text to compare, just the ask.
  const requestPane = (w: api.WorkItem) => (
    <div className="max-w-2xl space-y-4" data-testid="my-work-request-pane">
      <p className="text-xs text-muted-foreground">
        {w.nest_name} · <span className="font-mono">{w.node_id}</span>
      </p>
      <h2 className="text-xl font-semibold">{w.title}</h2>
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground/80">{w.requested_by}</span>{" "}
        {w.type === "access"
          ? `asked for ${w.level === "read" ? "view" : "edit"} access`
          : isArchiveAsk(w)
            ? "asked to archive this nest"
            : "asked to delete this"}{" "}
        · {relTime(w.requested_at)}
      </p>
      {w.reason && <p className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">{w.reason}</p>}
      <div className="flex flex-wrap gap-2">
        {isMine(w) ? (
          w.type === "deletion" && (
            <Button variant="outline" onClick={() => void withdraw(w)}>
              Withdraw
            </Button>
          )
        ) : w.type === "access" ? (
          <>
            <Button
              variant="outline"
              className={APPROVE_BUTTON_CLASS}
              onClick={() => void approveAccessItem(w)}
              disabled={approvingAccessId === w.request_id}
              data-testid="my-work-access-approve"
            >
              <CheckCircle2 className="mr-2 h-4 w-4" /> Approve
            </Button>
            <Button
              variant="outline"
              className={REJECT_BUTTON_CLASS}
              onClick={() => setDenyAccessTarget(w)}
              data-testid="my-work-access-deny"
            >
              <XCircle className="mr-2 h-4 w-4" /> Deny
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              className={isArchiveAsk(w) ? APPROVE_BUTTON_CLASS : "text-destructive hover:text-destructive"}
              onClick={() => {
                setDeletionAction("delete");
                setDeletionTarget(w);
              }}
            >
              {isArchiveAsk(w) ? <CheckCircle2 className="mr-2 h-4 w-4" /> : <Trash2 className="mr-2 h-4 w-4" />}
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
              <XCircle className="mr-2 h-4 w-4" /> Reject
            </Button>
          </>
        )}
        <Button variant="ghost" onClick={() => openWorkItem(w)}>
          Open
        </Button>
      </div>
    </div>
  );

  const draftPanel = (d: api.MyDraft) => (
    <>
      <p className="text-sm font-semibold">{d.status === "rejected" ? "Sent back to you" : "Your draft"}</p>
      <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
        {d.status === "rejected" ? "Revise it, then submit it again." : "Nobody else has been asked to review this yet."}
      </p>
      <div className="flex flex-col gap-2">
        <Button onClick={() => setSubmitDraft(d)} data-testid="my-work-draft-submit">
          <Send className="mr-2 h-4 w-4" /> Submit for review
        </Button>
        <Button variant="outline" onClick={() => onOpenReview(d.nest_id, d.nest_name, d.node_id)}>
          <Pencil className="mr-2 h-4 w-4" /> Edit draft
        </Button>
        <Button
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={() => setDiscardTarget(d)}
        >
          <Trash2 className="mr-2 h-4 w-4" /> Discard draft
        </Button>
      </div>
    </>
  );

  const minePanel = (w: api.WorkItem) => (
    <>
      <p className="text-sm font-semibold">Waiting for review</p>
      <p className="mb-3 mt-0.5 text-xs text-muted-foreground">You submitted this, so someone else reviews it.</p>
      <div className="flex flex-col gap-2">
        <Button variant="outline" onClick={() => onOpenReview(w.nest_id, w.nest_name, w.node_id)}>
          <FileText className="mr-2 h-4 w-4" /> Open document
        </Button>
        <Button variant="ghost" onClick={() => void withdraw(w)}>
          <ArrowLeft className="mr-2 h-4 w-4" /> Withdraw from review
        </Button>
      </div>
    </>
  );

  return (
    <div className="-mx-8 -my-6 flex flex-col lg:h-[calc(100dvh-var(--my-work-top,64px))]" ref={fitTop} data-testid="my-work">
      {/* One thin line: what kind of work, and which nest. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2" data-testid="my-work-filter-chips">
        {goBack && (
          <Button variant="ghost" size="sm" onClick={goBack} data-testid="my-work-back">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
          </Button>
        )}
        <h1 className="sr-only" data-testid="page-title">My Work</h1>
        <div role="tablist" aria-label="My Work" className="flex flex-wrap items-center gap-1" data-testid="my-work-tabs">
          {sections.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              data-testid={`my-work-tab-${t.key}`}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm",
                tab === t.key ? "bg-muted font-medium" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              {!workLoading && t.count > 0 && (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-xs font-semibold",
                    t.key === "reviews" ? "bg-amber-500 text-white" : "bg-muted-foreground/15",
                  )}
                >
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
        {nestOptions.length > 1 && (
          <select
            value={nestFilter}
            onChange={(e) => {
              setNestFilter(e.target.value);
              // A hidden row must not stay selected: the bar counts the selection.
              setWorkSelected(new Set());
              setOpenRev(null);
            }}
            aria-label="Filter by nest"
            className="ml-auto h-8 max-w-[14rem] rounded-md border border-input bg-background px-2 text-xs"
            data-testid="my-work-nest-filter"
          >
            <option value="all">All nests</option>
            {nestOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>

      {tab === "reviews" ? (
        <div className="min-h-0 flex-1 lg:grid lg:grid-cols-[300px_minmax(0,1fr)]">
          <div
            className={cn("min-h-0 flex-col border-r lg:flex", openRev ? "hidden" : "flex")}
            data-testid="my-work-approvals"
          >
            <div role="tablist" aria-label="Review queues" className="flex border-b">
              {queues.map((q) => (
                <button
                  key={q.key}
                  type="button"
                  role="tab"
                  aria-selected={queue === q.key}
                  onClick={() => {
                    setQueue(q.key);
                    setOpenRev(null);
                    setWorkSelected(new Set());
                  }}
                  data-testid={`my-work-queue-${q.key}`}
                  className={cn(
                    "-mb-px flex flex-auto items-center justify-center gap-1 whitespace-nowrap border-b-2 px-1.5 py-2.5 text-xs",
                    queue === q.key
                      ? "border-primary font-medium text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {q.label}
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-[11px] font-semibold",
                      queue === q.key ? "bg-primary/10 text-primary" : "bg-muted",
                    )}
                  >
                    {q.count}
                  </span>
                </button>
              ))}
            </div>
            {queue === "review" && reviewItems.length > 1 && (
              <div className="border-b px-3 py-2 text-xs text-muted-foreground">
                <label className="flex items-center gap-2.5">
                  <Checkbox
                    checked={workSelected.size === 0 ? false : workSelected.size === upToDate.length ? true : "indeterminate"}
                    disabled={upToDate.length === 0}
                    onCheckedChange={(next: boolean | "indeterminate") =>
                      setWorkSelected(next === true ? new Set(upToDate.map(workKey)) : new Set())
                    }
                    aria-label="Select every up-to-date review"
                    data-testid="work-select-all"
                  />
                  {workSelected.size > 0 ? `${workSelected.size} selected` : `Select all up-to-date (${upToDate.length})`}
                </label>
                {workSelectionOverflow > 0 && (
                  <p className="mt-1 text-destructive">
                    Up to {BULK_REVIEW_LIMIT} per nest — deselect {workSelectionOverflow}.
                  </p>
                )}
                {workSelected.size > 0 && (
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      className="bg-green-600 text-white hover:bg-green-700"
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
                    <Button size="sm" variant="ghost" onClick={() => setWorkSelected(new Set())}>
                      Clear
                    </Button>
                  </div>
                )}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {workLoading ? (
                <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading your work…
                </div>
              ) : queue === "review" || queue === "mine" ? (
                workRows.map((w) => {
                  const key = workKey(w);
                  const stale = w.type === "review" && w.up_to_date === false;
                  const inReview = queue === "review" && w.type === "review";
                  return (
                    <QueueRow
                      key={`${w.type}:${workItemKey(w)}`}
                      title={w.title}
                      path={w.node_id}
                      who={queue === "mine" ? w.nest_name : w.requested_by}
                      when={nestFilter === "all" && queue === "review" ? `${relTime(w.requested_at)} · ${w.nest_name}` : relTime(w.requested_at)}
                      selected={isOpen(w, rowRequestId(w))}
                      onOpen={() => openRow(w)}
                      badge={
                        w.type !== "review" ? (
                          <RowBadge tone="red">{workItemKind(w)}</RowBadge>
                        ) : stale ? (
                          <RowBadge tone="amber">Outdated</RowBadge>
                        ) : w.priority === "urgent" || w.priority === "high" ? (
                          <RowBadge tone={w.priority === "urgent" ? "red" : "amber"}>{w.priority}</RowBadge>
                        ) : null
                      }
                      checkbox={
                        queue === "review" && reviewItems.length > 1 ? (
                          <Checkbox
                            checked={workSelected.has(key) && inReview}
                            disabled={!inReview}
                            className={inReview ? "" : "invisible"}
                            onCheckedChange={() =>
                              setWorkSelected((prev) => {
                                const next = new Set(prev);
                                next.has(key) ? next.delete(key) : next.add(key);
                                return next;
                              })
                            }
                            aria-label={`Select ${w.title}`}
                          />
                        ) : undefined
                      }
                      action={
                        inReview && !stale && workSelected.size === 0 ? (
                          <Button
                            size="sm"
                            className="h-7 bg-green-600 px-2 text-xs text-white hover:bg-green-700"
                            onClick={() => {
                              setWorkSelected(new Set([key]));
                              setWorkBulkAction("approve");
                            }}
                            data-testid="my-work-row-approve"
                          >
                            <Check className="mr-1 h-3.5 w-3.5" /> Approve
                          </Button>
                        ) : undefined
                      }
                    />
                  );
                })
              ) : (
                draftList.map((d) => (
                  <QueueRow
                    key={`${d.nest_id}:${d.node_id}`}
                    title={d.title}
                    path={d.node_id}
                    who={d.nest_name}
                    when={relTime(d.updated_at)}
                    selected={isOpen(d)}
                    onOpen={() => setOpenRev({ nestId: d.nest_id, nodeId: d.node_id })}
                  />
                ))
              )}
              {!workLoading && !firstRow && (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground" data-testid="my-work-no-approvals">
                  {
                    {
                      review: "You're all caught up — nothing waiting on you.",
                      sent_back: "Nothing has been sent back to you.",
                      drafts: "No unsubmitted drafts.",
                      mine: "You are not waiting on anyone.",
                    }[queue]
                  }
                </p>
              )}
              {(draftData?.pagination.total ?? 0) > (draftData?.drafts.length ?? 0) && (queue === "drafts" || queue === "sent_back") && (
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  Showing your {draftData!.drafts.length} latest. My Drafts has the rest.
                </p>
              )}
              {(queue === "review" || queue === "mine") && (<>
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
              </>)}
            </div>
          </div>
          <div
            className={cn("min-h-0 min-w-0 overflow-y-auto bg-muted/20 px-5 py-5 lg:block", !openRev && "hidden")}
            data-testid="my-work-review-pane"
          >
            {!openRev ? (
              <div className="mx-auto mt-24 max-w-sm rounded-lg border border-dashed bg-background px-6 py-8 text-center">
                <Inbox className="mx-auto mb-3 h-6 w-6 text-muted-foreground" aria-hidden />
                <p className="text-sm font-medium">Select an item to review</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Pick a draft from the list to read it, compare it with the published version, and approve it or send it back.
                </p>
              </div>
            ) : (
              <>
                <Button variant="ghost" size="sm" className="mb-2 lg:hidden" onClick={closePane}>
                  <ArrowLeft className="mr-1.5 h-4 w-4" /> Queue
                </Button>
                {openItem && openItem.type !== "review" ? (
                  requestPane(openItem)
                ) : openDraft ? (
                  <ReviewPane
                    key={`${openDraft.nest_id}:${openDraft.node_id}`}
                    layout="workspace"
                    nestId={openDraft.nest_id}
                    nestName={openDraft.nest_name}
                    state={openDraft.status === "rejected" ? "sent_back" : "draft"}
                    request={{
                      id: openDraft.node_id,
                      nodeId: openDraft.node_id,
                      title: openDraft.title,
                      version: openDraft.version,
                      requestedBy: currentUserEmail ?? "You",
                      requestedAt: openDraft.updated_at,
                      priority: "normal",
                    }}
                    canEditDocs={false}
                    primeTags={[]}
                    panel={draftPanel(openDraft)}
                    onApprove={async () => {}}
                    onRequestChanges={async () => {}}
                    onEditDraft={() => {}}
                    onOpenDocument={(id) => onOpenReview(openDraft.nest_id, openDraft.nest_name, id)}
                    onClose={closePane}
                  />
                ) : (
                  <MyWorkReviewPane
                    key={`${openRev.nestId}:${openRev.nodeId}`}
                    nestId={openRev.nestId}
                    nodeId={openRev.nodeId}
                    nestName={openNestName}
                    panel={openItem && isMine(openItem) ? minePanel(openItem) : undefined}
                    currentUser={currentUserEmail?.toLowerCase()}
                    onDecided={afterDecision}
                    onSkip={
                      skipTarget && queue === "review"
                        ? () => setOpenRev({ nestId: skipTarget.nest_id, nodeId: skipTarget.node_id })
                        : undefined
                    }
                    onOpenDocument={(id) => onOpenReview(openRev.nestId, openNestName, id)}
                    onClose={closePane}
                  />
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
          {tab === "tasks" && !workLoading && (
              <AssignedTasks
                items={work.assigned ?? []}
                today={localToday()}
                loadingDone={loadingDone}
                onStatusChange={(st) => void onTaskStatusChange(st)}
                onOpen={(a) => onOpenReview(a.nest_id, a.nest_name, a.node_id)}
              />
          )}
          {tab === "mentions" && (mentionCount > 0 ? (
            <MentionRows
              mentions={work.mentions ?? []}
              viewer={adminStatus?.me ?? null}
              pagination={work.mentions_pagination}
              loading={loadingMentions}
              busyThread={doneThread}
              onOpen={openMention}
              onDone={markMentionDone}
              onPage={goToMentionsPage}
            />
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="my-work-tab-empty">No mentions waiting on you.</p>
          ))}
          {tab === "notifications" && ((work.notifications?.length ?? 0) > 0 ? (
                <div className="rounded-lg border border-amber-300/50 bg-amber-500/5">
                  <div className="px-4 py-2 flex items-center gap-2 text-sm font-medium">
                    <Bell className="h-4 w-4 text-amber-600" aria-hidden /> Notifications
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
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="my-work-tab-empty">No notifications.</p>
          ))}
        </div>
      )}

      {submitDraft && (
        <SubmitForReviewModal
          isOpen
          onClose={() => setSubmitDraft(null)}
          documentTitle={submitDraft.title}
          currentVersion={submitDraft.version}
          onSubmit={async (note, priority) => {
            await api.submitForReview(submitDraft.nest_id, submitDraft.node_id, note, priority);
            setOpenRev(null);
            void refreshDrafts();
            void goToWorkPage(work.pagination?.offset ?? 0);
          }}
        />
      )}
      {discardTarget && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setDiscardTarget(null)}
          title={`Discard "${discardTarget.title}"?`}
          description="A document that was approved before goes back to that version. One that never was is deleted."
          confirmLabel="Discard draft"
          destructive
          onConfirm={() => discard(discardTarget)}
        />
      )}

      {workBulkAction && (
        <ReasonDialog
          open
          onOpenChange={(o) => {
            if (o) return;
            setWorkBulkAction(null);
            // A row's own Approve selected just that row; cancelling undoes it.
            if (workSelected.size === 1) setWorkSelected(new Set());
          }}
          title={
            workBulkAction === "approve"
              ? `Approve ${workSelected.size} document${workSelected.size === 1 ? "" : "s"}?`
              : `Reject ${workSelected.size} document${workSelected.size === 1 ? "" : "s"}?`
          }
          description={`${
            workBulkAction === "approve"
              ? "Approving publishes each one. Anything that changed since this inbox loaded is reported back and left alone."
              : "Each author gets the same reason and the work goes back to them."
          } ${(() => {
            const titles = reviewItems.filter((w) => workSelected.has(workKey(w))).map((w) => w.title);
            const shown = titles.slice(0, 6).join(", ");
            return titles.length > 6 ? `${shown}, and ${titles.length - 6} more.` : `${shown}.`;
          })()}`}
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
