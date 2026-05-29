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
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Globe, Lock, Users, Trash2, Loader2, AlertCircle, UserPlus,
} from "lucide-react";
import * as api from "../lib/api";

interface Collaborator {
  id: string;
  user_id: string;
  permission: "read" | "write" | "admin";
  email?: string;
}

interface ShareNestDialogProps {
  nestId: string;
  nestName: string;
  onClose: () => void;
  /** Fired after any change so the parent can refresh its nest/list state. */
  onChanged: () => void;
}

// Permission options shared by the add form and the per-row role picker.
// Mirrors the server's enum in src/shared/types.ts (read | write | admin).
const PERMISSIONS: { value: Collaborator["permission"]; label: string; hint: string }[] = [
  { value: "read", label: "Viewer", hint: "Read only" },
  { value: "write", label: "Editor", hint: "Read and edit documents" },
  { value: "admin", label: "Admin", hint: "Full access except deleting the nest" },
];

export function ShareNestDialog({
  nestId,
  nestName,
  onClose,
  onChanged,
}: ShareNestDialogProps) {
  const [isPublic, setIsPublic] = useState(false);
  const [visibilitySaving, setVisibilitySaving] = useState(false);

  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(true);

  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePermission, setInvitePermission] =
    useState<Collaborator["permission"]>("read");
  const [adding, setAdding] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const loadCollaborators = async () => {
    setLoading(true);
    try {
      const { collaborators } = await api.listCollaborators(nestId);
      setCollaborators(collaborators as Collaborator[]);
    } catch (err: any) {
      setError(err?.message || "Failed to load collaborators");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Read current visibility straight from the server so the toggle
    // reflects truth without the parent having to thread it through.
    api
      .getNest(nestId)
      .then((res) => setIsPublic(res.nest?.visibility === "public"))
      .catch(() => {
        /* leave default; the collaborators load surfaces any real error */
      });
    loadCollaborators();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nestId]);

  const handleVisibilityToggle = async (next: boolean) => {
    // Optimistic flip; revert on failure so the switch never lies about
    // server state (same pattern as NestSettingsModal's stewardship save).
    setIsPublic(next);
    setVisibilitySaving(true);
    setError(null);
    try {
      const result = await api.updateNestVisibility(
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

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
    setAdding(true);
    setError(null);
    try {
      await api.addCollaborator(nestId, { email, permission: invitePermission });
      setInviteEmail("");
      setInvitePermission("read");
      await loadCollaborators();
      onChanged();
    } catch (err: any) {
      setError(err?.message || "Failed to add collaborator");
    } finally {
      setAdding(false);
    }
  };

  const handleRoleChange = async (
    collabId: string,
    permission: Collaborator["permission"],
  ) => {
    setError(null);
    // Optimistic — reflect immediately, reload on failure to resync.
    setCollaborators((prev) =>
      prev.map((c) => (c.id === collabId ? { ...c, permission } : c)),
    );
    try {
      await api.updateCollaborator(nestId, collabId, permission);
      onChanged();
    } catch (err: any) {
      setError(err?.message || "Failed to update permission");
      await loadCollaborators();
    }
  };

  const handleRemove = async (collab: Collaborator) => {
    const ok = window.confirm(
      `Remove ${collab.email || "this collaborator"}'s access to "${nestName}"? They keep their account; only their access to this nest is revoked.`,
    );
    if (!ok) return;
    setError(null);
    try {
      await api.removeCollaborator(nestId, collab.id);
      setCollaborators((prev) => prev.filter((c) => c.id !== collab.id));
      onChanged();
    } catch (err: any) {
      setError(err?.message || "Failed to remove collaborator");
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            Share: {nestName}
          </DialogTitle>
          <DialogDescription>
            Control who can see this nest and what they can do. Sharing here
            grants plain access — it does not make anyone a steward.
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

          {/* Add collaborator */}
          <form onSubmit={handleAdd} className="rounded-lg border p-4 space-y-3">
            <Label className="flex items-center gap-2 text-sm font-medium">
              <UserPlus className="h-4 w-4" />
              Add a person
            </Label>
            <div className="flex flex-col sm:flex-row gap-2">
              <Input
                type="email"
                placeholder="teammate@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                disabled={adding}
                className="flex-1"
              />
              <Select
                value={invitePermission}
                onValueChange={(v) =>
                  setInvitePermission(v as Collaborator["permission"])
                }
              >
                <SelectTrigger className="w-full sm:w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERMISSIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="submit" disabled={adding || !inviteEmail.trim()}>
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              If they don't have an account yet, they'll get access when they
              register with this email.
            </p>
          </form>

          {/* Collaborator list */}
          <div className="rounded-lg border p-4 space-y-2">
            <Label className="text-sm font-medium">People with access</Label>
            {loading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : collaborators.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">
                Nobody's been added yet. The owner always has full access.
              </p>
            ) : (
              <div className="space-y-1">
                {collaborators.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-2 py-1.5"
                    data-testid={`collaborator-row-${c.id}`}
                  >
                    <span className="flex-1 min-w-0 truncate text-sm">
                      {c.email || c.user_id}
                    </span>
                    <Select
                      value={c.permission}
                      onValueChange={(v) =>
                        handleRoleChange(c.id, v as Collaborator["permission"])
                      }
                    >
                      <SelectTrigger className="w-[120px] h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PERMISSIONS.map((p) => (
                          <SelectItem key={p.value} value={p.value}>
                            {p.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRemove(c)}
                      title="Remove access"
                      className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
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
