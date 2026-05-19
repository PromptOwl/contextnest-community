/**
 * LifecycleStatusBadge — ported from packages/ui-components/src/DocumentViewer/LifecycleStatusBadge.tsx
 */
import React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { FileEdit, Clock, CheckCircle2, XCircle, FileWarning } from "lucide-react";

export type DocumentLifecycleStatus =
  | "draft"
  | "pending_review"
  | "approved"
  | "rejected"
  | "external_edit_pending";

interface LifecycleStatusBadgeProps {
  status: DocumentLifecycleStatus;
  approvedVersion?: number | null;
  currentVersion?: number;
  showIcon?: boolean;
  size?: "sm" | "default";
  className?: string;
}

const statusConfig: Record<
  DocumentLifecycleStatus,
  {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    className: string;
  }
> = {
  draft: {
    label: "Draft",
    icon: FileEdit,
    className: "bg-gray-100 text-gray-700 border-gray-200",
  },
  pending_review: {
    label: "Pending Review",
    icon: Clock,
    className: "bg-amber-100 text-amber-700 border-amber-200",
  },
  approved: {
    label: "Approved",
    icon: CheckCircle2,
    className: "bg-green-100 text-green-700 border-green-200",
  },
  rejected: {
    label: "Rejected",
    icon: XCircle,
    className: "bg-red-100 text-red-700 border-red-200",
  },
  external_edit_pending: {
    label: "External Edit",
    icon: FileWarning,
    className: "bg-orange-100 text-orange-700 border-orange-200",
  },
};

export function LifecycleStatusBadge({
  status,
  approvedVersion,
  currentVersion,
  showIcon = true,
  size = "default",
  className,
}: LifecycleStatusBadgeProps) {
  const config = statusConfig[status] || statusConfig.draft;
  const Icon = config.icon;

  const showVersionInfo =
    status === "approved" &&
    approvedVersion &&
    currentVersion &&
    approvedVersion < currentVersion;

  return (
    <Badge
      variant="outline"
      className={cn(
        "!rounded-sm",
        config.className,
        size === "sm" && "text-[10px] px-1.5 py-0",
        className,
      )}
    >
      {showIcon && (
        <Icon className={cn("mr-1", size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5")} />
      )}
      {config.label}
      {showVersionInfo && (
        <span className="ml-1 text-[10px] opacity-75">(v{approvedVersion})</span>
      )}
    </Badge>
  );
}

export function AIEligibilityBadge({
  approvedVersion,
  className,
}: {
  approvedVersion: number | null;
  className?: string;
}) {
  const eligible = approvedVersion !== null;
  return (
    <Badge
      variant="outline"
      className={cn(
        eligible
          ? "bg-blue-100 text-blue-700 border-blue-200"
          : "bg-gray-100 text-gray-500 border-gray-200",
        "text-[10px] px-1.5 py-0",
        className,
      )}
    >
      {eligible ? "AI Ready" : "Not AI Ready"}
    </Badge>
  );
}
