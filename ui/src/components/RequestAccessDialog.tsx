/**
 * "Request access?" — what a refused write offers instead of a dead end
 * (CU-wdqcq041jn).
 *
 * Three states, read from the caller's latest request for the target:
 *   - none / approved-then-revoked → ask, with an optional note
 *   - pending                      → "Request pending", nothing to send
 *   - denied                       → who said no and why, and ask again
 *
 * Opened two ways: RequestAccessHost (below) on any 403 that carries
 * `can_request_access`, and directly by the editor / nest page's "Request edit
 * access" button for viewers. Nothing here touches the caller's own state, so
 * an unsaved edit underneath stays exactly as it was.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Clock, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ReasonDialog } from "@/components/governance/ReasonDialog";
import * as api from "@/lib/api";
import {
  ACCESS_OFFER_EVENT,
  askAgainAt,
  describeAccessTarget,
  type AccessOffer,
} from "@/lib/access-requests";
import { formatServerDate } from "@/lib/dates";

export function RequestAccessDialog({
  offer,
  onClose,
}: {
  offer: AccessOffer;
  onClose: () => void;
}) {
  // The refusal may already say whether there's a pending/denied ask; a
  // button-opened dialog has to look it up.
  const [latest, setLatest] = useState<AccessOffer["request"] | undefined>(
    offer.request === undefined ? undefined : offer.request,
  );
  useEffect(() => {
    if (offer.request !== undefined) return;
    let live = true;
    api
      .getMyAccessRequest(offer.nestId, offer.target)
      .then((r) => live && setLatest(r.request))
      .catch(() => live && setLatest(null));
    return () => {
      live = false;
    };
  }, [offer]);

  const what = describeAccessTarget(offer.target, offer.label);

  if (latest === undefined) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-[440px]" data-testid="request-access-loading">
          <DialogHeader>
            <DialogTitle>Request edit access</DialogTitle>
          </DialogHeader>
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </DialogContent>
      </Dialog>
    );
  }

  if (latest?.status === "pending") {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-[440px]" data-testid="request-access-pending">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-600" /> Request pending
            </DialogTitle>
            <DialogDescription>
              You asked for edit access to {what}
              {formatServerDate(latest.created_at) ? ` on ${formatServerDate(latest.created_at)}` : ""}.
              A nest owner or admin will approve or deny it, and you'll be notified. Anything
              you haven't saved is still here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={onClose}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const denied = latest?.status === "denied" ? latest : null;
  // A fresh "no" holds for a while (the server answers 429 inside it), so say
  // when asking opens again instead of offering a button that would refuse.
  const reopensAt = askAgainAt(denied);
  if (denied && reopensAt) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-[440px]" data-testid="request-access-denied">
          <DialogHeader>
            <DialogTitle>Edit access was denied</DialogTitle>
            <DialogDescription>
              {denied.resolved_by ?? "A nest admin"} denied your request for {what}
              {denied.resolution_note ? `: “${denied.resolution_note}”` : "."} You can ask again
              after {reopensAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={onClose}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={denied ? "Ask again for edit access?" : "Request edit access?"}
      description={`You can read ${what} but not change it. Ask the nest owner or an admin for edit access — anything you haven't saved stays where it is.`}
      priorDecline={
        denied
          ? {
              resolvedBy: denied.resolved_by ?? undefined,
              resolvedAt: denied.resolved_at ?? undefined,
              resolutionNote: denied.resolution_note ?? undefined,
            }
          : null
      }
      label="Why do you need it? (optional)"
      optionalReason
      placeholder="e.g. I own the pricing numbers in this doc"
      confirmLabel="Send request"
      onConfirm={async (note) => {
        const { created } = await api.requestAccess(offer.nestId, offer.target, note || undefined);
        toast.success(created ? "Access requested" : "You've already asked — it's still pending", {
          description: "A nest owner or admin will decide; you'll be notified.",
        });
        onClose();
      }}
    />
  );
}

/**
 * Always-mounted listener for refused writes (see lib/api `request()`). One
 * offer at a time — a burst of refusals (autosave, a retry) shows one prompt.
 */
export function RequestAccessHost() {
  const [offer, setOffer] = useState<AccessOffer | null>(null);
  useEffect(() => {
    const onOffer = (e: Event) => {
      const next = (e as CustomEvent<AccessOffer>).detail;
      setOffer((cur) => cur ?? next);
    };
    window.addEventListener(ACCESS_OFFER_EVENT, onOffer);
    return () => window.removeEventListener(ACCESS_OFFER_EVENT, onOffer);
  }, []);
  if (!offer) return null;
  return <RequestAccessDialog offer={offer} onClose={() => setOffer(null)} />;
}
