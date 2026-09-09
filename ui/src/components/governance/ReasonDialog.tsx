/**
 * ReasonDialog — one dialog for "confirm this, and say why".
 *
 * Covers the deletion-request flows (flag a doc, decline a request) and the
 * plain confirm that honours one: omit `label` and the textarea disappears,
 * leaving a confirm dialog. Replaces the window.prompt/confirm those started as.
 */
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Loader2 } from "lucide-react";
import { formatServerDate } from "@/lib/dates";

interface ReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Textarea label. Omit for a confirm-only dialog (no reason collected). */
  label?: string;
  /** Collect the text, but let the action go ahead without it — an approval
   *  note is worth offering and never worth blocking on. */
  optionalReason?: boolean;
  placeholder?: string;
  confirmLabel: string;
  destructive?: boolean;
  /** A previous decline on the same subject — shown above the input so nobody
   *  re-raises a request that was already answered, without knowing why. */
  priorDecline?: {
    reason?: string;
    resolutionNote?: string;
    resolvedBy?: string;
    resolvedAt?: string;
  } | null;
  /** A second, softer action on the same reason — the nest flag offers "request
   *  archive" beside "request deletion" so an editor picks the outcome they
   *  actually want without a dialog of its own. Both share the typed reason and
   *  the same required/optional rule. */
  secondaryLabel?: string;
  onSecondary?: (reason: string) => Promise<void>;
  /** Rejecting surfaces the message inline and keeps the dialog open. */
  onConfirm: (reason: string) => Promise<void>;
}

export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  optionalReason,
  placeholder,
  confirmLabel,
  destructive,
  priorDecline,
  secondaryLabel,
  onSecondary,
  onConfirm,
}: ReasonDialogProps) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (next: boolean) => {
    if (busy) return;
    if (!next) {
      setReason("");
      setError(null);
    }
    onOpenChange(next);
  };

  const run = async (action: (reason: string) => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action(reason.trim());
      setReason("");
      onOpenChange(false);
    } catch (err: any) {
      setError(err?.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => run(onConfirm);
  // A required reason gates both actions — the whole point of the flow is that
  // nothing is raised unexplained, whichever outcome is asked for.
  const blocked = busy || (!!label && !optionalReason && !reason.trim());

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {priorDecline && (
          <div
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-1"
            data-testid="reason-dialog-prior-decline"
          >
            <p className="font-medium">
              Rejected
              {priorDecline.resolvedBy ? ` by ${priorDecline.resolvedBy}` : ""}
              {formatServerDate(priorDecline.resolvedAt)
                ? ` · ${formatServerDate(priorDecline.resolvedAt)}`
                : ""}
            </p>
            {priorDecline.resolutionNote && (
              <p>&ldquo;{priorDecline.resolutionNote}&rdquo;</p>
            )}
            {priorDecline.reason && (
              <p className="text-amber-800/80">
                Asked before: &ldquo;{priorDecline.reason}&rdquo;
              </p>
            )}
          </div>
        )}

        {label && (
          <div className="space-y-2">
            <Label htmlFor="reason-dialog-input">{label}</Label>
            <Textarea
              id="reason-dialog-input"
              autoFocus
              rows={3}
              value={reason}
              placeholder={placeholder}
              onChange={(e) => setReason(e.target.value)}
              data-testid="reason-dialog-input"
            />
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={busy}>
            Cancel
          </Button>
          {secondaryLabel && onSecondary && (
            <Button
              variant="outline"
              onClick={() => run(onSecondary)}
              disabled={blocked}
              data-testid="reason-dialog-secondary"
            >
              {secondaryLabel}
            </Button>
          )}
          <Button
            onClick={confirm}
            disabled={blocked}
            variant={destructive ? "destructive" : "default"}
            data-testid="reason-dialog-confirm"
          >
            {busy && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
