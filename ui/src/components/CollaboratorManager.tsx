/**
 * CollaboratorManager — list + add/change-role/remove collaborators on a nest.
 *
 * Shared by ShareNestDialog (modal) and NestView's Collaborators tab so the
 * sharing logic lives in one place. Does NOT render the visibility toggle —
 * that stays dialog-only. Self-fetches; calls onChanged after any mutation so
 * the parent can refresh its own state.
 *
 * Each collaborator may also hold steward roles (returned by the API as
 * `stewardRoles`); we surface those as read-only badges so the admin sees the
 * person's full effective access, not just their plain sharing permission.
 */
import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Trash2, Loader2, AlertCircle, UserPlus } from "lucide-react";
import * as api from "../lib/api";

export interface Collaborator {
  id: string;
  user_id: string;
  permission: "read" | "write" | "admin";
  email?: string;
  /** Steward roles the same user holds on this nest (read-only, from API). */
  stewardRoles?: string[];
}

// Mirrors the server's enum in src/shared/types.ts (read | write | admin).
export const COLLAB_PERMISSIONS: {
  value: Collaborator["permission"];
  label: string;
  hint: string;
}[] = [
  { value: "read", label: "Viewer", hint: "Read only" },
  { value: "write", label: "Editor", hint: "Read and edit documents" },
  { value: "admin", label: "Admin", hint: "Full access except deleting the nest" },
];

interface CollaboratorManagerProps {
  nestId: string;
  nestName: string;
  /** Fired after any change so the parent can refresh nest/list state. */
  onChanged: () => void;
}

export function CollaboratorManager({
  nestId,
  nestName,
  onChanged,
}: CollaboratorManagerProps) {
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
    loadCollaborators();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nestId]);

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
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

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
              {COLLAB_PERMISSIONS.map((p) => (
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
                {/* Steward roles held by the same user — read-only context. */}
                {(c.stewardRoles ?? []).map((r) => (
                  <Badge
                    key={r}
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 capitalize"
                    title="Steward role — manage in the Stewards tab"
                  >
                    {r}
                  </Badge>
                ))}
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
                    {COLLAB_PERMISSIONS.map((p) => (
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
  );
}
