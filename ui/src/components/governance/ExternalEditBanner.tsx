/**
 * ExternalEditBanner — alerts the user that the underlying .md file was
 * edited outside the app and offers Approve / Reject / View diff actions.
 *
 * Drives the bridge-function-spec Story 3.1 out-of-band-edit flow on the
 * client. The server has already staged a suggestion; this component
 * resolves it via approveExternalEdit / rejectExternalEdit.
 */
import { useState } from "react";
import { FileWarning, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatServerDate } from "@/lib/dates";
import { Textarea } from "@/components/ui/textarea";
import {
  approveExternalEdit,
  rejectExternalEdit,
  getExternalEditDetail,
  type PendingChange,
  type ExternalEditEntry,
} from "../../lib/api";
import { DiffViewer } from "./DiffViewer";

interface ExternalEditBannerProps {
  nestId: string;
  nodeId: string;
  pending: PendingChange;
  onResolved: () => void;
}

export function ExternalEditBanner({
  nestId,
  nodeId,
  pending,
  onResolved,
}: ExternalEditBannerProps) {
  const [busy, setBusy] = useState<null | "approve" | "reject" | "view">(null);
  const [showReject, setShowReject] = useState(false);
  const [reason, setReason] = useState("");
  const [detail, setDetail] = useState<ExternalEditEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleApprove = async () => {
    setBusy("approve");
    setError(null);
    try {
      await approveExternalEdit(nestId, nodeId, pending.suggestion_id);
      onResolved();
    } catch (err: any) {
      setError(err.message || "Approval failed");
    } finally {
      setBusy(null);
    }
  };

  const handleReject = async () => {
    if (!reason.trim()) {
      setError("Rejection reason is required");
      return;
    }
    setBusy("reject");
    setError(null);
    try {
      await rejectExternalEdit(nestId, nodeId, pending.suggestion_id, reason.trim());
      onResolved();
    } catch (err: any) {
      setError(err.message || "Rejection failed");
    } finally {
      setBusy(null);
    }
  };

  const handleViewDiff = async () => {
    if (detail) {
      setDetail(null);
      return;
    }
    setBusy("view");
    setError(null);
    try {
      const { entry } = await getExternalEditDetail(
        nestId,
        nodeId,
        pending.suggestion_id,
      );
      setDetail(entry);
    } catch (err: any) {
      setError(err.message || "Failed to load diff");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Alert className="border-orange-300 bg-orange-50 dark:bg-orange-950/30">
      <FileWarning className="h-4 w-4 text-orange-700 dark:text-orange-400" />
      <AlertDescription className="space-y-3">
        <div>
          <strong className="text-orange-900 dark:text-orange-200">
            This file was edited outside the app.
          </strong>{" "}
          <span className="text-sm text-orange-800/90 dark:text-orange-300/90">
            Detected {formatServerDate(pending.detected_at)} ·{" "}
            <code className="text-xs">{pending.source}</code>. The displayed
            content is the last approved version; the on-disk change is staged
            for review.
          </span>
        </div>

        {error && (
          <div className="text-sm text-red-700 dark:text-red-400">{error}</div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={handleApprove}
            disabled={busy !== null}
            data-testid="external-edit-approve"
          >
            {busy === "approve" ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : null}
            Approve change
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowReject((v) => !v)}
            disabled={busy !== null}
            data-testid="external-edit-reject-toggle"
          >
            Reject
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handleViewDiff}
            disabled={busy !== null}
            data-testid="external-edit-view-diff"
          >
            {busy === "view" ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : null}
            {detail ? "Hide diff" : "View diff"}
          </Button>
        </div>

        {showReject && (
          <div className="space-y-2 pt-1">
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason for rejecting this external edit (required, kept in audit log)"
              rows={2}
              data-testid="external-edit-reject-reason"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                onClick={handleReject}
                disabled={busy !== null || !reason.trim()}
                data-testid="external-edit-reject-confirm"
              >
                {busy === "reject" ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Confirm reject
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setShowReject(false);
                  setReason("");
                }}
                disabled={busy !== null}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {detail?.patch && (
          <div className="pt-2">
            <DiffViewer patch={detail.patch} />
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}
