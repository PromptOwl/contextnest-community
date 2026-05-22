/**
 * DeleteNestDialog — destructive confirmation for deleting a nest.
 * Shared between the Dashboard nest-card trash button and the NestView
 * header so both surfaces stay identical (damage list, type-to-confirm,
 * error copy). Owner-only is enforced server-side; non-owners see a
 * friendly error rather than a missing button so the workspace is honest
 * about who can act.
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
import { Loader2, Trash2 } from "lucide-react";
import * as api from "../lib/api";

interface DeleteNestDialogProps {
  nestId: string;
  nestName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}

export function DeleteNestDialog({
  nestId,
  nestName,
  open,
  onOpenChange,
  onDeleted,
}: DeleteNestDialogProps) {
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset transient state every time the dialog reopens so a prior typo or
  // error message doesn't leak across invocations.
  useEffect(() => {
    if (open) {
      setConfirmText("");
      setError(null);
      setDeleting(false);
    }
  }, [open]);

  const handleDelete = async () => {
    setDeleting(true);
    setError(null);
    try {
      await api.deleteNest(nestId);
      onDeleted();
    } catch (err: any) {
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
        if (!next && deleting) return;
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
            <li>All documents and version history</li>
            <li>Stewardship assignments and review-queue entries</li>
            <li>Collaborator access and linked API keys</li>
            <li>The nest folder on disk</li>
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
            disabled={deleting}
            autoComplete="off"
          />
        </div>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-900">
            {error}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleting || confirmText !== nestName}
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
