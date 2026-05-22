/**
 * NestSettingsModal — per-nest admin settings (stewardship toggle, etc.)
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
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Shield, AlertCircle, Loader2, Info, Globe, Lock } from "lucide-react";
import * as api from "../lib/api";

type Visibility = "private" | "public";

interface NestSettingsModalProps {
  nestId: string;
  nestName: string;
  stewardshipEnabled: boolean;
  onClose: () => void;
  onChanged: () => void;
}

export function NestSettingsModal({
  nestId,
  nestName,
  stewardshipEnabled,
  onClose,
  onChanged,
}: NestSettingsModalProps) {
  const [enabled, setEnabled] = useState(stewardshipEnabled);
  // Visibility comes from GET /nests/:id; we treat unknown-yet as
  // "private" optimistically so the toggle defaults to the safer state.
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [originalVisibility, setOriginalVisibility] =
    useState<Visibility>("private");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { nest } = await api.getNest(nestId);
        if (cancelled) return;
        const v: Visibility =
          nest?.visibility === "public" ? "public" : "private";
        setVisibility(v);
        setOriginalVisibility(v);
      } catch {
        // Non-fatal; toggle defaults to "private" already.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nestId]);

  const handleSave = async () => {
    if (
      enabled === stewardshipEnabled &&
      visibility === originalVisibility
    ) {
      onClose();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      if (enabled !== stewardshipEnabled) {
        const result = await api.updateNestSettings(nestId, {
          stewardship_enabled: enabled,
        });
        // Trust the server's response, not our optimistic local state, in
        // case the permission check rejected silently or the DB rejected.
        if (result.stewardship_enabled !== enabled) {
          setError(
            "Server did not accept the stewardship change. You may not have permission to change this setting.",
          );
          setLoading(false);
          return;
        }
      }
      if (visibility !== originalVisibility) {
        const result = await api.setNestVisibility(nestId, visibility);
        if (result.visibility !== visibility) {
          setError(
            "Server did not accept the visibility change. Admin permission is required.",
          );
          setLoading(false);
          return;
        }
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

          {/* Visibility toggle. Server enforces admin-only on the PATCH
              /visibility route; a non-admin click surfaces a server-error
              message via the existing alert. */}
          <div className="rounded-lg border p-4 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label className="flex items-center gap-2 text-sm font-medium">
                  {visibility === "public" ? (
                    <Globe className="h-4 w-4" />
                  ) : (
                    <Lock className="h-4 w-4" />
                  )}
                  Visibility
                </Label>
                <p className="text-xs text-muted-foreground">
                  Choose who can read this nest's documents. Editing always
                  requires write access regardless of this setting.
                </p>
              </div>
              <Switch
                checked={visibility === "public"}
                onCheckedChange={(on) =>
                  setVisibility(on ? "public" : "private")
                }
                aria-label="Toggle public visibility"
              />
            </div>

            {visibility === "private" && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground pt-2 border-t">
                <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <div>
                  <strong className="text-foreground">Private.</strong> Only
                  the owner and explicit collaborators can read. Anyone else
                  gets a 404.
                </div>
              </div>
            )}

            {visibility === "public" && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground pt-2 border-t">
                <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <div>
                  <strong className="text-foreground">Public.</strong> Anyone
                  with the URL can read this nest's documents — no login
                  required. Writes, admin actions, and the global nest list
                  still require credentials.
                </div>
              </div>
            )}
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
