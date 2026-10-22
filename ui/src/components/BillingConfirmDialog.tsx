import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { BILLING_CONFIRM_EVENT, type BillingChange, type BillingConfirmRequest } from "@/lib/api";

/** Each billing class in the words Settings → License uses (pricing spec v21). */
export const BILLING_CLASS_LABEL: Record<BillingChange["from"], string> = {
  viewer: "Viewer (free)",
  subscriber: "Editor",
  user: "User (owner, admin or reviewer)",
};

function ChangeLine({ c }: { c: BillingChange }) {
  return (
    <>
      <strong>{c.email ?? "A person without an account yet"}</strong>: {BILLING_CLASS_LABEL[c.from]} →{" "}
      {BILLING_CLASS_LABEL[c.to]}
    </>
  );
}

/**
 * Asks before a role change raises someone's billed class. api.ts fires the
 * event on a 409 billing_confirm and resends with the confirm header on a yes.
 */
export function BillingConfirmHost() {
  const [queue, setQueue] = useState<BillingConfirmRequest[]>([]);
  useEffect(() => {
    const onConfirm = (e: Event) => {
      e.preventDefault(); // claimed: api.ts waits for resolve
      const req = (e as CustomEvent<BillingConfirmRequest>).detail;
      setQueue((q) => [...q, req]);
    };
    window.addEventListener(BILLING_CONFIRM_EVENT, onConfirm);
    return () => window.removeEventListener(BILLING_CONFIRM_EVENT, onConfirm);
  }, []);

  const current = queue[0];
  // Radix also fires onOpenChange(false) after an action click: only the first answer counts.
  const answer = (confirmed: boolean) => {
    if (!current) return;
    current.resolve(confirmed);
    setQueue((q) => (q[0] === current ? q.slice(1) : q));
  };

  return (
    <AlertDialog open={!!current} onOpenChange={(open) => !open && answer(false)}>
      <AlertDialogContent data-testid="billing-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>This raises what someone is billed</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>Each person is billed once, at their highest role. Saving this change moves:</p>
              {/* A list only when one change raises several people (e.g. sharing with a team). */}
              {current && current.changes.length === 1 ? (
                <p>
                  <ChangeLine c={current.changes[0]} />
                </p>
              ) : (
                <ul className="list-disc pl-5">
                  {current?.changes.map((c, i) => (
                    <li key={c.userId ?? `${c.email}-${i}`}>
                      <ChangeLine c={c} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => answer(true)} data-testid="billing-confirm">
            Confirm and save
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
