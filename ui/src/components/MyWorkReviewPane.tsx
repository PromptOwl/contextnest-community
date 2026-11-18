/**
 * The review pane inside My Work. It is the same ReviewPane the nest's Review
 * Queue uses, fed by the same review-queue read, so a change looks and decides
 * the same from either door. The nest comes from the row, so this works across
 * nests.
 */
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import * as api from "../lib/api";
import { reads, useNestSettings } from "../lib/queries";
import { ReviewPane, type ReviewRequest } from "./governance";
import { Button } from "@/components/ui/button";

export function MyWorkReviewPane({
  nestId,
  nodeId,
  currentUser,
  onDecided,
  onOpenDocument,
  onClose,
}: {
  nestId: string;
  nodeId: string;
  currentUser?: string;
  /** After an approve or send-back, so the list can move on. */
  onDecided: () => void;
  onOpenDocument: (nodeId: string) => void;
  onClose: () => void;
}) {
  const queue = useQuery(reads.reviewQueue(nestId));
  const settings = useNestSettings(nestId);
  const request = (queue.data?.requests as ReviewRequest[] | undefined)?.find(
    (r) => r.nodeId === nodeId,
  );
  if (queue.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the change…
      </div>
    );
  }
  if (!request) {
    return (
      <div className="space-y-3 rounded-lg border py-12 text-center text-sm text-muted-foreground">
        <p>This change is no longer waiting for review.</p>
        <Button size="sm" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    );
  }
  const s: any = settings.data ?? {};
  return (
    <ReviewPane
      nestId={nestId}
      request={request}
      currentUser={currentUser}
      canEditDocs={!!request.canReview}
      primeTags={s.prime_tags ?? []}
      alwaysIncludeTags={s.always_include_tags ?? ["always-include"]}
      onApprove={async (note) => {
        try {
          await api.approveNode(nestId, nodeId, note);
        } catch (err: any) {
          throw new Error(err?.message || "Approve failed");
        }
        toast.success("Approved and published");
        onDecided();
      }}
      onRequestChanges={async (note) => {
        try {
          await api.rejectNode(nestId, nodeId, note);
        } catch (err: any) {
          throw new Error(err?.message || "Request changes failed");
        }
        toast.success("Sent back to the author");
        onDecided();
      }}
      onReject={async (note) => {
        try {
          await api.rejectNode(nestId, nodeId, note, "reject");
        } catch (err: any) {
          throw new Error(err?.message || "Reject failed");
        }
        toast.success("Rejected");
        onDecided();
      }}
      onEditDraft={() => onOpenDocument(nodeId)}
      onOpenDocument={onOpenDocument}
      onClose={onClose}
    />
  );
}
