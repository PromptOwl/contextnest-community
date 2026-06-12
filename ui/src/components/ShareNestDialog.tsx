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
  // Marketplace publishing — a pack IS this nest, listed publicly with
  // credit pricing. Server enforces owner/admin.
  const [isPack, setIsPack] = useState(false);
  const [packStatus, setPackStatus] = useState<string>("approved");
  const [packSummary, setPackSummary] = useState("");
  const [packInstallPrice, setPackInstallPrice] = useState("0");
  const [packCallPrice, setPackCallPrice] = useState("0");
  const [packSaving, setPackSaving] = useState(false);

  useEffect(() => {
    // Read current visibility straight from the server so the toggle
    // reflects truth without the parent having to thread it through.
    api
      .getNest(nestId)
      .then((res) => {
        setIsPublic(res.nest?.visibility === "public");
        setIsPack(!!res.nest?.is_pack);
        if (res.nest?.pack_meta) {
          try {
            const m = JSON.parse(res.nest.pack_meta);
            setPackSummary(m.summary ?? "");
            setPackStatus(m.status ?? "approved");
            setPackInstallPrice(String(m.price_credits_install ?? 0));
            setPackCallPrice(String(m.price_credits_per_call ?? 0));
          } catch {
            /* corrupt meta → fresh form */
          }
        }
      })
      .catch(() => {
        /* leave default; CollaboratorManager surfaces any real error */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nestId]);

  const handlePublishPack = async () => {
    setPackSaving(true);
    setError(null);
    try {
      const res = await api.publishPack(nestId, {
        summary: packSummary.trim(),
        price_credits_install: parseInt(packInstallPrice, 10) || 0,
        price_credits_per_call: parseInt(packCallPrice, 10) || 0,
      });
      setIsPack(true);
      setPackStatus(res.pack?.status ?? "pending");
      setIsPublic(true); // publishing forces public visibility server-side
      onChanged();
    } catch (err: any) {
      setError(err?.message || "Failed to publish pack");
    } finally {
      setPackSaving(false);
    }
  };

  const handleUnpublishPack = async () => {
    setPackSaving(true);
    setError(null);
    try {
      await api.unpublishPack(nestId);
      setIsPack(false);
      onChanged();
    } catch (err: any) {
      setError(err?.message || "Failed to unpublish pack");
    } finally {
      setPackSaving(false);
    }
  };

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

          {/* Marketplace — publish this nest as an installable, credit-priced
              pack. Publishing makes the nest public (a pack must be browsable). */}
          <div className="rounded-lg border p-4 space-y-3">
            <Label className="flex items-center gap-2 text-sm font-medium">
              <Globe className="h-4 w-4 text-blue-600" />
              Marketplace
              {isPack && (
                <span
                  className={`text-[10px] rounded-full border px-2 py-0.5 ${
                    packStatus === "pending"
                      ? "border-amber-200 bg-amber-50 text-amber-700"
                      : packStatus === "rejected"
                        ? "border-red-200 bg-red-50 text-red-700"
                        : "border-green-200 bg-green-50 text-green-700"
                  }`}
                >
                  {packStatus === "pending"
                    ? "Pending approval"
                    : packStatus === "rejected"
                      ? "Rejected"
                      : "Published"}
                </span>
              )}
            </Label>
            <p className="text-xs text-muted-foreground">
              Publish this nest as a pack others can install. Installs and
              context calls are metered in PromptOwl credits. Listings go
              live after marketplace approval.
            </p>
            <input
              className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm"
              placeholder="One-line summary shown in the marketplace"
              value={packSummary}
              onChange={(e) => setPackSummary(e.target.value)}
            />
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5">
                Install price
                <input
                  type="number"
                  min="0"
                  className="w-20 px-2 py-1 rounded-md border border-input bg-background"
                  value={packInstallPrice}
                  onChange={(e) => setPackInstallPrice(e.target.value)}
                />
                credits
              </label>
              <label className="flex items-center gap-1.5">
                Per call
                <input
                  type="number"
                  min="0"
                  className="w-20 px-2 py-1 rounded-md border border-input bg-background"
                  value={packCallPrice}
                  onChange={(e) => setPackCallPrice(e.target.value)}
                />
                credits
              </label>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handlePublishPack}
                disabled={packSaving || !packSummary.trim()}
              >
                {packSaving
                  ? "Saving…"
                  : isPack
                    ? "Update listing"
                    : "Publish to Marketplace"}
              </Button>
              {isPack && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleUnpublishPack}
                  disabled={packSaving}
                >
                  Unpublish
                </Button>
              )}
            </div>
          </div>
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
