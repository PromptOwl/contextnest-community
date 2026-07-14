/**
 * RenameNestDialog — rename a nest (and/or edit its description).
 * Shared between the Dashboard nest-card pencil button and the NestView
 * overflow menu so both surfaces stay identical. Owner/nest-admin only is
 * enforced server-side (PATCH /nests/:nestId); callers gate the affordance
 * to the same tier so viewers/editors never see a teasing Rename item.
 * Slug-collision errors ("Another nest already uses this name…") surface
 * inline in the dialog rather than as a toast so the user can fix the name
 * without losing their input.
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
import { Loader2, Pencil } from "lucide-react";
import * as api from "../lib/api";

interface RenameNestDialogProps {
  nestId: string;
  /** Current name — prefills the input. */
  nestName: string;
  /** Current description — prefills the input. */
  nestDescription?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the server's updated nest after a successful save. */
  onRenamed: (nest: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
  }) => void;
}

export function RenameNestDialog({
  nestId,
  nestName,
  nestDescription,
  open,
  onOpenChange,
  onRenamed,
}: RenameNestDialogProps) {
  const [name, setName] = useState(nestName);
  const [description, setDescription] = useState(nestDescription ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-prime from the current values every time the dialog opens so stale
  // edits or a prior error don't leak across invocations.
  useEffect(() => {
    if (open) {
      setName(nestName);
      setDescription(nestDescription ?? "");
      setError(null);
      setSaving(false);
    }
  }, [open, nestName, nestDescription]);

  const trimmedName = name.trim();
  const dirty =
    trimmedName !== nestName.trim() ||
    description.trim() !== (nestDescription ?? "").trim();

  const handleSave = async () => {
    if (!trimmedName || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { nest } = await api.updateNest(nestId, {
        name: trimmedName,
        // Empty string clears the description (server stores NULL).
        description: description.trim() || null,
      });
      onRenamed(nest);
      onOpenChange(false);
    } catch (err: any) {
      console.error("[RenameNestDialog] updateNest failed", nestId, err);
      // Surface the server's message verbatim — the slug-collision copy
      // ("Another nest already uses this name…") tells the user exactly
      // what to change.
      setError(
        err?.message ??
          "Failed to rename this nest. You may not have permission, " +
            "or the server may be unreachable.",
      );
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && saving) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleSave();
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-4 w-4" />
              Rename nest
            </DialogTitle>
            <DialogDescription>
              Renaming updates the nest's name and URL slug. Documents,
              sharing, and history are unaffected.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="rename-nest-name" className="text-xs">
              Name
            </Label>
            <Input
              id="rename-nest-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder="Nest name"
              disabled={saving}
              autoComplete="off"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="rename-nest-description" className="text-xs">
              Description{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="rename-nest-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What lives in this nest?"
              disabled={saving}
              autoComplete="off"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-900"
            >
              {error}
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !trimmedName || !dirty}>
              {saving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
