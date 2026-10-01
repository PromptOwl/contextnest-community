/**
 * PushConfirmationModal — the reviewer's decision surface for a held agent write
 * (Push Confirmation Gate).
 *
 * Loud confirmation: it names EXACTLY which nest (name + id verbatim, copyable),
 * how many documents, the per-doc manifest (title · type · tags, with a
 * new-vs-update badge derived from the current node index), and who wrote it
 * (label + email + timestamp). "Always allow" whitelists the submitter's exact
 * key for future writes. Confirm / Reject / Cancel.
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertCircle,
  Check,
  Copy,
  Loader2,
  UploadCloud,
  X,
} from "lucide-react";
import * as api from "../lib/api";

interface PushConfirmationModalProps {
  nestId: string;
  pendingId: string;
  /** Node ids already in the nest — drives the new-vs-update badge. */
  existingNodeIds?: Set<string>;
  onClose: () => void;
  /** Called after a confirm/reject lands, with the resulting status. */
  onDecided?: (status: api.PendingPushStatus) => void;
}

export function PushConfirmationModal({
  nestId,
  pendingId,
  existingNodeIds,
  onClose,
  onDecided,
}: PushConfirmationModalProps) {
  const [pending, setPending] = useState<api.PendingPush | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [alwaysAllow, setAlwaysAllow] = useState(false);
  const [deciding, setDeciding] = useState<null | "confirm" | "reject">(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .getPendingPush(nestId, pendingId)
      .then((p) => alive && setPending(p))
      .catch((e: any) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [nestId, pendingId]);

  const label = pending?.submitter_label || pending?.submitter_email || "an API key";

  const copyId = () => {
    try {
      void navigator.clipboard?.writeText(nestId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  const decide = async (kind: "confirm" | "reject") => {
    setDeciding(kind);
    setError(null);
    try {
      const res =
        kind === "confirm"
          ? await api.confirmPush(nestId, pendingId, alwaysAllow)
          : await api.rejectPush(nestId, pendingId);
      onDecided?.(res.status);
      onClose();
    } catch (e: any) {
      setError(e.message);
      setDeciding(null);
    }
  };

  const decided = pending && pending.status !== "pending";

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[560px] flex flex-col max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UploadCloud className="h-5 w-5 text-amber-600" />
            Confirm write to {pending?.nest_name ?? "this nest"}
          </DialogTitle>
          <DialogDescription>
            This nest holds agent writes for review before they apply. Review
            exactly what is about to be written.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 flex-1 min-h-0 overflow-y-auto pr-1">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}

          {pending && (
            <>
              {/* Nest identity — name + id verbatim, copyable. */}
              <div className="rounded-lg border p-3 space-y-1">
                <div className="text-sm font-medium">{pending.nest_name}</div>
                <button
                  type="button"
                  onClick={copyId}
                  className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground"
                  title="Copy nest id"
                >
                  {nestId}
                  {copied ? (
                    <Check className="h-3 w-3 text-green-600" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </button>
              </div>

              {/* Who + when. */}
              <div className="text-sm">
                <span className="font-medium">{pending.doc_count}</span>{" "}
                document{pending.doc_count === 1 ? "" : "s"} · written by{" "}
                <span className="font-medium">{label}</span>
                {pending.submitter_email ? ` (${pending.submitter_email})` : ""}{" "}
                ·{" "}
                <span className="text-muted-foreground">
                  {new Date(pending.created_at).toLocaleString()}
                </span>
              </div>

              {/* Manifest. */}
              <div className="rounded-lg border divide-y max-h-64 overflow-y-auto">
                {pending.manifest.length === 0 && (
                  <div className="p-3 text-xs text-muted-foreground">
                    No document rows (context.md only).
                  </div>
                )}
                {pending.manifest.map((m, i) => {
                  // A null id means the server will generate one on apply, so
                  // it cannot collide with an existing doc: always New.
                  const isUpdate = m.id
                    ? (existingNodeIds?.has(m.id) ?? false)
                    : false;
                  return (
                    <div
                      key={`${m.id ?? m.title}:${i}`}
                      className="p-2.5 flex items-start justify-between gap-3"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">
                          {m.title}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {m.type}
                          {m.tags.length > 0 ? ` · ${m.tags.join(" ")}` : ""}
                        </div>
                      </div>
                      {existingNodeIds ? (
                        <Badge variant={isUpdate ? "secondary" : "default"}>
                          {isUpdate ? "Update" : "New"}
                        </Badge>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {decided && (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    This write is no longer pending (status:{" "}
                    <strong>{pending.status}</strong>).
                  </AlertDescription>
                </Alert>
              )}

              {/* Always-allow whitelist. */}
              {!decided && (
                <label className="flex items-start gap-2 text-sm cursor-pointer rounded-lg border p-3">
                  <input
                    type="checkbox"
                    checked={alwaysAllow}
                    onChange={(e) => setAlwaysAllow(e.target.checked)}
                    className="h-4 w-4 mt-0.5"
                  />
                  <span>
                    <span className="font-medium">
                      Always allow automated writes from {label} to this nest
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Whitelists this exact API key. Future writes on it apply
                      immediately without holding for confirmation.
                    </span>
                  </span>
                </label>
              )}
            </>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={!!deciding}>
            Cancel
          </Button>
          {!decided && (
            <>
              <Button
                variant="destructive"
                onClick={() => decide("reject")}
                disabled={!!deciding || loading}
              >
                {deciding === "reject" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <X className="h-4 w-4 mr-1" /> Reject
                  </>
                )}
              </Button>
              <Button
                onClick={() => decide("confirm")}
                disabled={!!deciding || loading}
              >
                {deciding === "confirm" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Check className="h-4 w-4 mr-1" /> Confirm write
                  </>
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
