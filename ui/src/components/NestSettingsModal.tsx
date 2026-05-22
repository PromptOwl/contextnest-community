/**
 * NestSettingsModal — per-nest admin settings (stewardship toggle, etc.)
 */
import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Shield, AlertCircle, Loader2, Info, Trash2 } from "lucide-react";
import * as api from "../lib/api";

interface NestSettingsModalProps {
  nestId: string;
  nestName: string;
  stewardshipEnabled: boolean;
  onClose: () => void;
  onChanged: () => void;
  /**
   * Called after the nest is successfully deleted from the Danger Zone.
   * The caller should navigate away from the now-deleted nest (e.g. back
   * to the dashboard) and refresh the nest list.
   */
  onDeleted?: () => void;
}

export function NestSettingsModal({
  nestId,
  nestName,
  stewardshipEnabled,
  onClose,
  onChanged,
  onDeleted,
}: NestSettingsModalProps) {
  const [enabled, setEnabled] = useState(stewardshipEnabled);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleSave = async () => {
    if (enabled === stewardshipEnabled) {
      onClose();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.updateNestSettings(nestId, {
        stewardship_enabled: enabled,
      });
      // Trust the server's response, not our optimistic local state, in case
      // permission check rejected silently or the DB rejected the update.
      if (result.stewardship_enabled !== enabled) {
        setError(
          "Server did not accept the change. You may not have permission to change this setting.",
        );
        setLoading(false);
        return;
      }
      onChanged();
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Settings: {nestName}</DialogTitle>
          <DialogDescription>
            Admin controls for this nest. Changes apply to all future documents.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Stewardship toggle */}
          <div className="rounded-lg border p-4 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label className="flex items-center gap-2 text-sm font-medium">
                  <Shield className="h-4 w-4" />
                  Stewardship & Approval Workflow
                </Label>
                <p className="text-xs text-muted-foreground">
                  Require steward approval before documents become AI-ready.
                  New documents will start as <strong>drafts</strong>.
                </p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>

            {!enabled && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground pt-2 border-t">
                <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <div>
                  <strong className="text-foreground">Currently off.</strong> New documents
                  are auto-approved and immediately available to AI. Versioning is
                  still on — every edit creates a new version.
                </div>
              </div>
            )}

            {enabled && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground pt-2 border-t">
                <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <div>
                  <strong className="text-foreground">When enabled:</strong> New
                  documents start as drafts. Assigned stewards must approve before
                  they're available to AI queries. Existing approved documents stay
                  approved.
                </div>
              </div>
            )}
          </div>

          {/* Danger Zone — delete nest. Owner-only is enforced server-side
              (DELETE /nests/:nestId returns 404 for non-owners), so a wrong
              click here surfaces a friendly error rather than soft-failing. */}
          <div className="rounded-lg border border-destructive/30 p-4 space-y-3">
            <div className="space-y-1">
              <Label className="flex items-center gap-2 text-sm font-medium text-destructive">
                <Trash2 className="h-4 w-4" />
                Danger Zone
              </Label>
              <p className="text-xs text-muted-foreground">
                Permanently delete this nest, every document, every version, and
                every API key scoped to it. This cannot be undone.
              </p>
            </div>

            {deleteError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{deleteError}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="delete-confirm" className="text-xs">
                Type <strong className="font-mono">{nestName}</strong> to confirm:
              </Label>
              <Input
                id="delete-confirm"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder={nestName}
                disabled={deleting}
                autoComplete="off"
              />
              <Button
                variant="destructive"
                size="sm"
                disabled={deleteConfirm !== nestName || deleting}
                onClick={async () => {
                  setDeleting(true);
                  setDeleteError(null);
                  try {
                    await api.deleteNest(nestId);
                    onDeleted?.();
                  } catch (err: any) {
                    setDeleteError(
                      err?.message ??
                        "Failed to delete this nest. You may not have permission, " +
                          "or the server may be unreachable.",
                    );
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Delete this nest"
                )}
              </Button>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={loading}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Save Settings"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
