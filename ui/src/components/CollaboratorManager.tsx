/**
 * CollaboratorManager — list + add/change-role/remove collaborators on a nest,
 * and (when `showTeams` is set) share whole teams from the same panel.
 *
 * Shared by ShareNestDialog (modal) and NestView's Collaborators tab so the
 * sharing logic lives in one place. Does NOT render the visibility toggle —
 * that stays dialog-only. Self-fetches; calls onChanged after any mutation so
 * the parent can refresh its own state.
 *
 * Each collaborator may also hold steward roles (returned by the API as
 * `stewardRoles`); we surface those as read-only badges so the admin sees the
 * person's full effective access, not just their plain sharing permission.
 *
 * Teams: the "Add" control has a Person/Team toggle and a "Teams with access"
 * list. A shared team brings its members in at their own role (set on the Teams
 * page). Gated by `showTeams` so teams surface only where wanted (the Share
 * dialog), not in every place the collaborator roster renders.
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
import { Trash2, Loader2, AlertCircle, UserPlus, Users, Share2 } from "lucide-react";
import { toast } from "sonner";
import * as api from "../lib/api";
import type { Team, TeamMember } from "../lib/api";
import { isEmailish } from "../lib/utils";

export interface Collaborator {
  id: string;
  user_id: string;
  permission: "read" | "write" | "admin";
  email?: string;
  /** Steward roles the same user holds on this nest (read-only, from API). */
  stewardRoles?: string[];
}

interface SharedTeam {
  teamId: string;
  teamName: string;
  members: TeamMember[];
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

// Rank for the escalation cap — mirrors permissionLevel() in
// src/shared/access.ts. The UI caps what a caller can grant/manage; the
// server is the real gate (POST /collaborators is write+ and escalation-capped,
// PATCH/DELETE stay admin).
const PERM_RANK: Record<string, number> = {
  read: 1, write: 2, admin: 3, owner: 4,
};

interface CollaboratorManagerProps {
  nestId: string;
  nestName: string;
  /** Fired after any change so the parent can refresh nest/list state. */
  onChanged: () => void;
  /** Logged-in user's email — their own row hides the Remove button so they
   *  can't revoke their own access from the UI. */
  currentUserEmail?: string;
  /** Caller's effective nest permission. Caps the invite dropdown to their own
   *  level (no escalation) and hides change-role/remove for non-admins, which
   *  stay admin-only server-side. Defaults to admin for legacy admin-gated
   *  call sites (e.g. ShareNestDialog) that don't pass it. */
  callerPermission?: string;
  /** Surface team-sharing (add a team, list shared teams) in this panel. Off
   *  by default so teams appear only in the Share dialog. */
  showTeams?: boolean;
}

export function CollaboratorManager({
  nestId,
  nestName,
  onChanged,
  currentUserEmail,
  callerPermission = "admin",
  showTeams = false,
}: CollaboratorManagerProps) {
  const self = (currentUserEmail || "").toLowerCase();
  const callerRank = PERM_RANK[callerPermission] ?? PERM_RANK.read;
  // Admin/owner manage the roster (change role + remove); per the ticket,
  // those stay admin-tier. Write collaborators can only invite.
  const canManageRoster = callerRank >= PERM_RANK.admin;
  // Escalation cap — can only grant up to your own level.
  const grantablePermissions = COLLAB_PERMISSIONS.filter(
    (p) => PERM_RANK[p.value] <= callerRank,
  );
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePermission, setInvitePermission] =
    useState<Collaborator["permission"]>("read");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Team-sharing state (only used when showTeams).
  const [addMode, setAddMode] = useState<"person" | "team">("person");
  const [sharedTeams, setSharedTeams] = useState<SharedTeam[]>([]);
  const [myTeams, setMyTeams] = useState<Team[]>([]);
  const [selectedTeam, setSelectedTeam] = useState("");
  const [teamBusy, setTeamBusy] = useState(false);

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

  const loadTeams = async () => {
    try {
      const [nestTeams, owned] = await Promise.all([
        api.listNestTeams(nestId),
        api.listTeams().catch(() => ({ teams: [] as Team[] })),
      ]);
      setSharedTeams(nestTeams.teams);
      setMyTeams(owned.teams);
    } catch (err: any) {
      setError(err?.message || "Failed to load teams");
    }
  };

  useEffect(() => {
    loadCollaborators();
    if (showTeams) loadTeams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nestId]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;
    // Reject malformed input before it hits the server — a bad address would
    // otherwise land in "People with access" as an entry that can never match
    // a real account.
    if (!isEmailish(email)) {
      setError("Enter a valid email address.");
      return;
    }
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

  const shareableTeams = myTeams.filter(
    (t) => !sharedTeams.some((s) => s.teamId === t.id),
  );

  const handleShareTeam = async () => {
    if (!selectedTeam) return;
    setTeamBusy(true);
    setError(null);
    try {
      await api.shareNestWithTeam(nestId, selectedTeam);
      setSelectedTeam("");
      toast.success("Team shared");
      await loadTeams();
      onChanged();
    } catch (err: any) {
      setError(err?.message || "Failed to share team");
    } finally {
      setTeamBusy(false);
    }
  };

  const handleUnshareTeam = async (teamId: string, teamName: string) => {
    const ok = window.confirm(
      `Unshare "${teamName}" from "${nestName}"? Its members lose the access this share granted.`,
    );
    if (!ok) return;
    setTeamBusy(true);
    setError(null);
    try {
      await api.unshareNestTeam(nestId, teamId);
      await loadTeams();
      onChanged();
    } catch (err: any) {
      setError(err?.message || "Failed to unshare team");
    } finally {
      setTeamBusy(false);
    }
  };

  const handleRoleChange = async (
    collabId: string,
    permission: Collaborator["permission"],
  ) => {
    // You can't change your own access level from here (the Select is also
    // disabled; this guards a stray programmatic call).
    const target = collaborators.find((c) => c.id === collabId);
    if (target && (target.email || "").toLowerCase() === self) {
      toast.error("You can't change your own access level.");
      return;
    }
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

      {/* Add collaborator / team */}
      <div className="rounded-lg border p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <Label className="flex items-center gap-2 text-sm font-medium">
            {showTeams && addMode === "team" ? (
              <>
                <Users className="h-4 w-4" />
                Add a team
              </>
            ) : (
              <>
                <UserPlus className="h-4 w-4" />
                Add a person
              </>
            )}
          </Label>
          {showTeams && (
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant={addMode === "person" ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs"
                onClick={() => setAddMode("person")}
              >
                Person
              </Button>
              <Button
                type="button"
                size="sm"
                variant={addMode === "team" ? "secondary" : "ghost"}
                className="h-7 px-2 text-xs"
                onClick={() => setAddMode("team")}
              >
                Team
              </Button>
            </div>
          )}
        </div>

        {showTeams && addMode === "team" ? (
          <>
            <div className="flex flex-col sm:flex-row gap-2">
              <Select
                value={selectedTeam}
                onValueChange={setSelectedTeam}
                disabled={shareableTeams.length === 0}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue
                    placeholder={
                      shareableTeams.length === 0
                        ? "No teams available to share"
                        : "Select a team…"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {shareableTeams.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={handleShareTeam} disabled={teamBusy || !selectedTeam}>
                {teamBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <Share2 className="h-4 w-4 mr-1" />
                    Share
                  </>
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Every member gets the role you gave them on the Teams page. Manage
              members there.
            </p>
          </>
        ) : (
          <form onSubmit={handleAdd} className="space-y-3">
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
                  {grantablePermissions.map((p) => (
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
        )}
      </div>

      {/* Teams with access */}
      {showTeams && sharedTeams.length > 0 && (
        <div className="rounded-lg border p-4 space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Users className="h-4 w-4" />
            Teams with access
          </Label>
          <div className="space-y-1">
            {sharedTeams.map((t) => (
              <div key={t.teamId} className="flex items-center gap-2 py-1.5">
                <span className="flex-1 min-w-0 truncate text-sm">{t.teamName}</span>
                <Badge variant="secondary" className="text-[11px]">
                  {t.members.length} member{t.members.length === 1 ? "" : "s"}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={teamBusy}
                  onClick={() => handleUnshareTeam(t.teamId, t.teamName)}
                  title="Unshare team"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

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
                {canManageRoster ? (
                  <>
                    <Select
                      value={c.permission}
                      disabled={(c.email || "").toLowerCase() === self}
                      onValueChange={(v) =>
                        handleRoleChange(c.id, v as Collaborator["permission"])
                      }
                    >
                      <SelectTrigger
                        className="w-[120px] h-8"
                        title={
                          (c.email || "").toLowerCase() === self
                            ? "You can't change your own access level"
                            : undefined
                        }
                      >
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
                    {(c.email || "").toLowerCase() !== self && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemove(c)}
                        title="Remove access"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </>
                ) : (
                  /* Write collaborators can invite but not change or remove
                     existing people (admin-only) — show their level read-only. */
                  <Badge variant="secondary" className="text-[11px] capitalize">
                    {COLLAB_PERMISSIONS.find((p) => p.value === c.permission)
                      ?.label ?? c.permission}
                  </Badge>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
