/**
 * ShareNestDialog — surface the nest sharing controls the backend already
 * exposes (see src/nests/sharing-routes.ts):
 *   - PATCH /visibility        → private ↔ public
 *   - GET    /collaborators    → who has access
 *   - POST   /collaborators    → add a person by email at read/write/admin
 *   - PATCH  /collaborators/:id → change their permission
 *   - DELETE /collaborators/:id → revoke access
 *
 * Collaborators are intentionally distinct from stewards: this is plain
 * access sharing (viewer/editor/admin), not the approval-workflow steward
 * role. That's why sharing a private nest no longer requires stewardship.
 *
 * All actions are admin-gated server-side (the /collaborators and
 * /visibility paths require "admin" — see src/app.ts). Non-admins who
 * reach this dialog get a friendly error rather than a silent no-op.
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Globe, Lock, Users, Loader2, AlertCircle } from "lucide-react";
import * as api from "../lib/api";
import { CollaboratorManager } from "./CollaboratorManager";
import { useAuth } from "../auth/AuthContext";

interface ShareNestDialogProps {
  nestId: string;
  nestName: string;
  onClose: () => void;
  /** Fired after any change so the parent can refresh its nest/list state. */
  onChanged: () => void;
}

export function ShareNestDialog({
  nestId,
  nestName,
  onClose,
  onChanged,
}: ShareNestDialogProps) {
  const { adminStatus } = useAuth();
  const currentEmail = adminStatus?.me?.email?.toLowerCase() ?? "";
  const [isPublic, setIsPublic] = useState(false);
  const [visibilitySaving, setVisibilitySaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Read current visibility straight from the server so the toggle
    // reflects truth without the parent having to thread it through.
    api
      .getNest(nestId)
      .then((res) => setIsPublic(res.nest?.visibility === "public"))
      .catch(() => {
        /* leave default; CollaboratorManager surfaces any real error */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nestId]);

  const handleVisibilityToggle = async (next: boolean) => {
    // Optimistic flip; revert on failure so the switch never lies about
    // server state (same pattern as NestSettingsModal's stewardship save).
    setIsPublic(next);
    setVisibilitySaving(true);
    setError(null);
    try {
      const result = await api.setNestVisibility(
        nestId,
        next ? "public" : "private",
      );
      if ((result.visibility === "public") !== next) {
        setIsPublic(!next);
        setError("Server did not accept the change. You may not have admin access to this nest.");
        return;
      }
      onChanged();
    } catch (err: any) {
      setIsPublic(!next);
      setError(err?.message || "Failed to change visibility");
    } finally {
      setVisibilitySaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            Share nest: {nestName}
          </DialogTitle>
          <DialogDescription>
            Sharing applies to the <strong>whole nest</strong> — every
            document in it. To restrict who can touch an individual document,
            assign stewards instead. Sharing grants plain access; it does not
            make anyone a steward.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Visibility */}
          <div className="rounded-lg border p-4 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label className="flex items-center gap-2 text-sm font-medium">
                  {isPublic ? (
                    <Globe className="h-4 w-4 text-green-600" />
                  ) : (
                    <Lock className="h-4 w-4" />
                  )}
                  {isPublic ? "Public" : "Private"}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {isPublic
                    ? "Anyone on this server can read this nest. Editing still requires being added below."
                    : "Only people added below (and the owner) can see this nest."}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {visibilitySaving && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                )}
                <Switch
                  checked={isPublic}
                  onCheckedChange={handleVisibilityToggle}
                  disabled={visibilitySaving}
                  aria-label="Toggle public visibility"
                />
              </div>
            </div>
          </div>

          {/* Collaborators — shared with the NestView tab. */}
          <CollaboratorManager
            nestId={nestId}
            nestName={nestName}
            onChanged={onChanged}
            currentUserEmail={currentEmail}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
