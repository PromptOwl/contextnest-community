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
import { cn } from "@/lib/utils";

export type ReviewRequestPriority = "low" | "normal" | "high" | "urgent";

export interface ReviewRequest {
  id: string;
  nodeId: string;
  version: number;
  requestedBy: string;
  requestedAt: string;
  requestNote?: string;
  priority: ReviewRequestPriority;
}

interface ReviewQueueProps {
  requests: ReviewRequest[];
  loading?: boolean;
  error?: string | null;
  className?: string;
  showHeader?: boolean;
  onRefresh?: () => void;
  onSelect?: (request: ReviewRequest) => void;
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
  const date = new Date(dateStr);
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
}: ReviewQueueProps) {
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
              <CardTitle className="text-lg">Review Queue</CardTitle>
              <CardDescription>Documents awaiting your approval</CardDescription>
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
        {requests.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <CheckCircle2 className="h-10 w-10 text-green-500 mb-3" />
            <p className="text-sm font-medium">All caught up!</p>
            <p className="text-xs text-muted-foreground">No documents awaiting review</p>
          </div>
        ) : (
          <div className="space-y-2">
            {requests.map((request) => {
              const priorityCfg = priorityConfig[request.priority];
              const PriorityIcon = priorityCfg.icon;

              return (
                <div
                  key={request.id}
                  className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 cursor-pointer transition-colors group"
                  onClick={() => onSelect?.(request)}
                >
                  <FileText className="h-5 w-5 text-blue-500 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{request.nodeId}</span>
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
