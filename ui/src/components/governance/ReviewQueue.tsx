/**
 * ReviewQueue — ported from packages/ui-components/src/stewardship/ReviewQueue.tsx
 * Adapted: uses `requests` prop + `onSelect` callback instead of server-action import.
 */
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

export type ReviewRequestPriority = "low" | "normal" | "high" | "urgent";

export interface ReviewRequest {
  id: string;
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
                {feedMode ? "Activity" : "Review Queue"}
              </CardTitle>
              <CardDescription>
                {feedMode
                  ? "Changes awaiting approval and new comments"
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
                        <div className="flex items-center gap-1">
                          <Avatar className="h-4 w-4">
                            <AvatarFallback className="text-[8px]">
                              {c.author[0]?.toUpperCase() || "?"}
                            </AvatarFallback>
                          </Avatar>
                          <span>{c.author}</span>
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
                  className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 cursor-pointer transition-colors group"
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
                      <Badge
                        variant="secondary"
                        className={cn("text-[10px] px-1.5 py-0", priorityCfg.className)}
                      >
                        {PriorityIcon && <PriorityIcon className="h-3 w-3 mr-1" />}
                        {priorityCfg.label}
                      </Badge>
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
                      </div>
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
