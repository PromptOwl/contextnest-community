/**
 * DeleteNestDialog — the whole "I want this nest gone" decision, in one place.
 * Shared between the Dashboard nest-card trash button and the NestView header
 * so both surfaces stay identical (damage list, type-to-confirm, error copy).
 * Owner-only is enforced server-side; non-owners see a friendly error rather
 * than a missing button so the workspace is honest about who can act.
 *
 * Archive lives here rather than behind its own menu entry and dialog: someone
 * reaching for Delete is answering "do I still need this?", and the reversible
 * option belongs in front of them at exactly that moment (CU-wdqcpzy80h). It
 * needs no type-to-confirm — nothing is destroyed, and the Archived tab undoes
 * it.
 */
import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Archive, Loader2, Trash2 } from "lucide-react";
import * as api from "../lib/api";
import { confirmableName } from "../lib/nest-name";

interface DeleteNestDialogProps {
  nestId: string;
  nestName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
  /** Omit to hide the archive action — used where archiving makes no sense
   *  (an already-archived nest offers Restore instead). */
  onArchived?: () => void;
  /** Imported nests hold a copy of the user's folder — deleting removes that
   *  workspace copy; the user's original folder on disk is left untouched. */
  isImported?: boolean;
}

export function DeleteNestDialog({
  nestId,
  nestName,
  open,
  onOpenChange,
  onDeleted,
  onArchived,
  isImported = false,
}: DeleteNestDialogProps) {
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = deleting || archiving;

  // Reset transient state every time the dialog reopens so a prior typo or
  // error message doesn't leak across invocations.
  useEffect(() => {
    if (open) {
      setConfirmText("");
      setError(null);
      setDeleting(false);
      setArchiving(false);
    }
  }, [open]);

  const handleArchive = async () => {
    setArchiving(true);
    setError(null);
    try {
      await api.archiveNest(nestId);
      onArchived?.();
    } catch (err: any) {
      console.error("[DeleteNestDialog] archiveNest failed", nestId, err);
      setError(
        err?.message ??
          "Failed to archive this nest. You may not have permission, " +
            "or the server may be unreachable.",
      );
      setArchiving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      await api.deleteNest(nestId);
      onDeleted();
    } catch (err: any) {
      console.error("[DeleteNestDialog] deleteNest failed", nestId, err);
      setError(
        err?.message ??
          "Failed to delete this nest. You may not have permission, " +
            "or the server may be unreachable.",
      );
      setDeleting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-700">
            <Trash2 className="h-4 w-4" />
            Delete nest
          </DialogTitle>
          <DialogDescription>
            You're about to permanently delete{" "}
            <strong className="text-foreground">{nestName}</strong>. This
            cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900 space-y-1">
          <p className="font-medium">This will remove:</p>
          <ul className="list-disc list-inside space-y-0.5">
            <li>Stewardship assignments and review-queue entries</li>
            <li>Collaborator access and linked API keys</li>
            <li>Version history and governance metadata</li>
            {isImported ? (
              <>
                <li>All documents and content (the workspace copy)</li>
                <li className="text-foreground">
                  Your original imported folder is not affected — only the copy
                  in this workspace is removed
                </li>
              </>
            ) : (
              <>
                <li>All documents and content</li>
                <li>The nest folder on disk</li>
              </>
            )}
          </ul>
        </div>

        <div className="space-y-2">
          <Label htmlFor="delete-nest-confirm" className="text-xs">
            Type <strong className="font-mono">{nestName}</strong> to confirm:
          </Label>
          <Input
            id="delete-nest-confirm"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={nestName}
            disabled={busy}
            autoComplete="off"
          />
        </div>

        {onArchived && (
          <div className="rounded-md border bg-muted/40 p-3 text-xs space-y-2">
            <p className="text-muted-foreground">
              <strong className="text-foreground">Just want it out of the way?</strong>{" "}
              Archiving keeps every document, version and steward exactly as they
              are. The nest leaves your dashboard, stops answering agents and
              published links, and becomes read-only until you restore it.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleArchive}
              disabled={busy}
              data-testid="archive-nest"
            >
              {archiving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                  Archiving...
                </>
              ) : (
                <>
                  <Archive className="h-3.5 w-3.5 mr-2" />
                  Archive instead
                </>
              )}
            </Button>
          </div>
        )}

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-900">
            {error}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={busy || confirmableName(confirmText) !== confirmableName(nestName)}
          >
            {deleting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                Deleting...
              </>
            ) : (
              <>
                <Trash2 className="h-3.5 w-3.5 mr-2" />
                Delete nest
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
