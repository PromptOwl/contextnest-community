/** Accept and Decline on one pending invite. `busy` is the request running on
 *  this row, so another row's request leaves these usable. */
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export type InviteBusy = "accept" | "decline" | undefined;

export function InviteActions({
  busy,
  onAccept,
  onDecline,
}: {
  busy: InviteBusy;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <>
      <Button size="sm" disabled={!!busy} aria-busy={busy === "accept"} onClick={onAccept}>
        {busy === "accept" ? (
          <>
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />
            Accepting…
          </>
        ) : (
          "Accept"
        )}
      </Button>
      <Button size="sm" variant="outline" disabled={!!busy} onClick={onDecline}>
        Decline
      </Button>
    </>
  );
}
