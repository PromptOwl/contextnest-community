/**
 * ReviewQueue — ported from packages/ui-components/src/stewardship/ReviewQueue.tsx
 * Adapted: uses `requests` prop + `onSelect` callback instead of server-action import.
 */
import { RunLink } from "../RunLink";
import React from "react";
import {
  FileText,
  Clock,
  AlertTriangle,
  ChevronRight,
  CheckCircle2,
  Loader2,
  RefreshCw,
  MessageSquare,
  CornerDownRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { parseServerDate } from "@/lib/dates";
import { showPriorityBadge } from "../../lib/review-pane";
import { displayNameFor } from "../../lib/person-name";

export type ReviewRequestPriority = "low" | "normal" | "high" | "urgent";

export interface ReviewRequest {
  id: string;
  nestId?: string;
  nodeId: string;
  title?: string;
  version: number;
  requestedBy: string;
  requestedAt: string;
  requestNote?: string;
  priority: ReviewRequestPriority;
  // Server-computed: can THIS caller approve/reject this request? Authoritative
  // (mirrors approve/reject's canUserApprove). The UI gates affordances off
  // this instead of re-deriving steward scope client-side.
  canReview?: boolean;
  /** Set when an agent run filed this proposal: links to its trace. */
  runId?: string;
  /** The requester reaches this nest only through its org-contributions
   *  setting — not someone the reviewer added (CU-wdqcq05rz6). */
  requestedByOrgContributor?: boolean;
}

/** A comment event from the nest activity feed (new thread or reply) —
 *  rendered as an informational row interleaved with change requests. */
export interface FeedComment {
  type: "comment";
  id: string;
  threadId: string;
  nodeId: string;
  title?: string;
  author: string;
  snippet: string;
  createdAt: string;
  resolved: boolean;
  isReply: boolean;
}

interface ReviewQueueProps {
  requests: ReviewRequest[];
  loading?: boolean;
  error?: string | null;
  className?: string;
  showHeader?: boolean;
  onRefresh?: () => void;
  onSelect?: (request: ReviewRequest) => void;
  /** Feed mode: comment events interleaved (newest first) with the change
   *  rows. Omit entirely for the legacy changes-only queue rendering. */
  comments?: FeedComment[];
  onSelectComment?: (comment: FeedComment) => void;
  /** Bulk mode. Pass both to put a checkbox on every reviewable change row;
   *  omit them and the queue renders exactly as it did before. Only rows the
   *  caller can actually review are selectable — the server refuses the rest
   *  anyway, and offering them would promise an action that fails. */
  selectedNodeIds?: Set<string>;
  onToggleSelect?: (nodeId: string) => void;
  /** The change open in the review pane, highlighted in the list. */
  activeNodeId?: string | null;
  /** Nest roster, so comment rows show a name instead of the email. */
  people?: Array<{ email: string; name: string | null }>;
}

const priorityConfig: Record<
  ReviewRequestPriority,
  { label: string; className: string; icon?: React.ComponentType<{ className?: string }> }
> = {
  low: { label: "Low", className: "bg-gray-100 text-gray-600" },
  normal: { label: "Normal", className: "bg-blue-100 text-blue-600" },
  high: { label: "High", className: "bg-amber-100 text-amber-600", icon: AlertTriangle },
  urgent: { label: "Urgent", className: "bg-red-100 text-red-600", icon: AlertTriangle },
};

function formatDate(dateStr: string) {
  // parseServerDate, not new Date: review_requests.requested_at is a SQL
  // default (UTC, no zone) that new Date() would read as local time.
  const date = parseServerDate(dateStr);
  if (!date) return "";
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ReviewQueue({
  requests,
  loading = false,
  error = null,
  className,
  showHeader = true,
  onRefresh,
  onSelect,
  comments,
  onSelectComment,
  selectedNodeIds,
  onToggleSelect,
  activeNodeId,
  people,
}: ReviewQueueProps) {
  // Feed mode (comments provided, even if empty): interleave change rows and
  // comment rows newest-first. Legacy mode keeps the server's priority order
  // for change requests, exactly as before.
  const feedMode = comments !== undefined;
  const rows: Array<
    | { kind: "change"; at: string; id: string; request: ReviewRequest }
    | { kind: "comment"; at: string; id: string; comment: FeedComment }
  > = feedMode
    ? [
        ...requests.map((r) => ({
          kind: "change" as const,
          at: r.requestedAt,
          id: r.id,
          request: r,
        })),
        ...(comments ?? []).map((c) => ({
          kind: "comment" as const,
          at: c.createdAt,
          id: c.id,
          comment: c,
        })),
        // Same (createdAt DESC, id DESC) ordering as the server-side feed
        // merge, so a page fetched from /feed and this client interleave
        // agree on same-second ties.
      ].sort(
        (a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id),
      )
    : requests.map((r) => ({
        kind: "change" as const,
        at: r.requestedAt,
        id: r.id,
        request: r,
      }));

  if (loading) {
    return (
      <Card className={className}>
        {showHeader && (
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Review Queue</CardTitle>
          </CardHeader>
        )}
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className={className}>
        {showHeader && (
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Review Queue</CardTitle>
          </CardHeader>
        )}
        <CardContent>
          <div className="text-center py-4 text-sm text-destructive">
            {error}
            {onRefresh && (
              <Button variant="ghost" size="sm" onClick={onRefresh} className="ml-2">
                <RefreshCw className="h-4 w-4" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={className}>
      {showHeader && (
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">
                {feedMode ? "From others — awaiting your review" : "Review Queue"}
              </CardTitle>
              <CardDescription>
                {feedMode
                  ? "Changes other people submitted for your approval, and new comments"
                  : "Documents awaiting your approval"}
              </CardDescription>
            </div>
            {onRefresh && (
              <Button variant="ghost" size="icon" onClick={onRefresh} className="h-8 w-8">
                <RefreshCw className="h-4 w-4" />
              </Button>
            )}
          </div>
        </CardHeader>
      )}
      <CardContent>
        {rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <CheckCircle2 className="h-10 w-10 text-green-500 mb-3" />
            <p className="text-sm font-medium">Nothing needs your review</p>
            {/* Scoped to THIS card only: the caller's own pending submissions
                render in a separate card above, so a generic "no pending
                changes" here would contradict them. */}
            <p className="text-xs text-muted-foreground">
              {feedMode
                ? "No changes or comments waiting on you"
                : "No documents awaiting your approval"}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((row) => {
              if (row.kind === "comment") {
                const c = row.comment;
                return (
                  <div
                    key={`comment-${c.id}`}
                    data-testid="feed-comment-item"
                    className="flex items-start gap-3 p-3 rounded-lg border hover:bg-muted/50 cursor-pointer transition-colors group"
                    onClick={() => onSelectComment?.(c)}
                  >
                    {c.isReply ? (
                      <CornerDownRight className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
                    ) : (
                      <MessageSquare className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate">
                          {c.title || c.nodeId}
                        </span>
                        <Badge
                          variant="secondary"
                          className="text-[10px] px-1.5 py-0 bg-amber-100 text-amber-700"
                        >
                          {c.isReply ? "Reply" : "Comment"}
                        </Badge>
                        {!c.resolved && (
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 border-amber-400 text-amber-700"
                          >
                            Unresolved
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                        <div className="flex items-center gap-1" title={c.author}>
                          <Avatar className="h-4 w-4">
                            <AvatarFallback className="text-[8px]">
                              {displayNameFor(c.author, people)[0]?.toUpperCase() || "?"}
                            </AvatarFallback>
                          </Avatar>
                          <span>{displayNameFor(c.author, people)}</span>
                        </div>
                        <span>•</span>
                        <Clock className="h-3 w-3" />
                        <span>{formatDate(c.createdAt)}</span>
                      </div>
                      {c.snippet && (
                        <p className="text-xs text-muted-foreground mt-1 truncate">
                          &ldquo;{c.snippet}&rdquo;
                        </p>
                      )}
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity mt-1" />
                  </div>
                );
              }

              const request = row.request;
              const priorityCfg = priorityConfig[request.priority];
              const PriorityIcon = priorityCfg.icon;

              return (
                <div
                  key={request.id}
                  className={cn(
                    "flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 cursor-pointer transition-colors group",
                    activeNodeId === request.nodeId && "border-primary bg-muted/60",
                  )}
                  aria-current={activeNodeId === request.nodeId ? "true" : undefined}
                  onClick={() => onSelect?.(request)}
                  data-testid="review-queue-row"
                >
                  {onToggleSelect && request.canReview !== false && (
                    <Checkbox
                      checked={selectedNodeIds?.has(request.nodeId) ?? false}
                      onCheckedChange={() => onToggleSelect(request.nodeId)}
                      // The row opens the document; the box only selects it.
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Select ${request.title || request.nodeId}`}
                      data-testid="review-queue-select"
                    />
                  )}
                  <FileText className="h-5 w-5 text-blue-500 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{request.title || request.nodeId}</span>
                      {/* Only priorities that change what the reviewer does
                          next get a pill — a column of "Normal" is noise. */}
                      {showPriorityBadge(request.priority) && (
                        <Badge
                          variant="secondary"
                          className={cn("text-[10px] px-1.5 py-0", priorityCfg.className)}
                        >
                          {PriorityIcon && <PriorityIcon className="h-3 w-3 mr-1" />}
                          {priorityCfg.label}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                      <span>v{request.version}</span>
                      <span>•</span>
                      <div className="flex items-center gap-1">
                        <Avatar className="h-4 w-4">
                          <AvatarFallback className="text-[8px]">
                            {request.requestedBy[0]?.toUpperCase() || "?"}
                          </AvatarFallback>
                        </Avatar>
                        <span>{request.requestedBy}</span>
                        {request.requestedByOrgContributor && (
                          <Badge
                            variant="outline"
                            className="ml-1 h-4 px-1 text-[10px] font-normal"
                            title="Suggested through this nest's org-contributions setting. This person wasn't added to the nest."
                            data-testid="review-org-contributor"
                          >
                            org contributor (not a collaborator)
                          </Badge>
                        )}
                      </div>
                      {request.runId && (
                        <>
                          <span>•</span>
                          <RunLink nestId={request.nestId} runId={request.runId} />
                        </>
                      )}
                      <span>•</span>
                      <Clock className="h-3 w-3" />
                      <span>{formatDate(request.requestedAt)}</span>
                    </div>
                    {request.requestNote && (
                      <p className="text-xs text-muted-foreground mt-1 truncate">
                        &ldquo;{request.requestNote}&rdquo;
                      </p>
                    )}
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
