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
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Trash2, Loader2, AlertCircle, UserPlus, Users, Share2 } from "lucide-react";
import { toast } from "sonner";
import * as api from "../lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { reads } from "../lib/queries";
import { nestReviewerState } from "../lib/nest-reviewer";
import type { Team, TeamMember } from "../lib/api";
import { isEmailish } from "../lib/utils";
import {
  removeCollaboratorConfirmCopy,
  removeCollaboratorSuccessMessage,
} from "../lib/collaborator-confirm";
import { PersonCombobox } from "./PersonCombobox";
import { SearchableSelect } from "./SearchableSelect";

export interface Collaborator {
  id: string;
  user_id: string;
  permission: "read" | "write" | "admin";
  email?: string;
  name?: string | null;
  /** Steward roles the same user holds on this nest (read-only, from API). */
  stewardRoles?: string[];
  /** "system" for a named system key (CU-wdqcq06djb): never a nest admin. */
  principal_kind?: "human" | "system";
}

/** A system goes by its configured name; its email is a generated address. */
const collabLabel = (c: Collaborator) =>
  (c.principal_kind === "system" && c.name) || c.email;

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
  /** Offer a nest-wide Reviewer switch per person and on invite, so access
   *  and review are set in one place (CU-wdqcq04wnr). Pass only when
   *  stewardship is on and the caller can assign stewards. */
  reviewers?: boolean;
}

export function CollaboratorManager({
  nestId,
  nestName,
  onChanged,
  currentUserEmail,
  callerPermission = "admin",
  showTeams = false,
  reviewers = false,
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
  const qc = useQueryClient();
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitePermission, setInvitePermission] =
    useState<Collaborator["permission"]>("read");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteReviewer, setInviteReviewer] = useState(false);
  // The Stewards tab's read (shared cache) — backs each row's Reviewer switch.
  const stewardsQuery = useQuery({ ...reads.stewards(nestId), enabled: reviewers });
  const stewards = stewardsQuery.data?.stewards ?? [];
  const [reviewerBusy, setReviewerBusy] = useState<string | null>(null);
  const makeReviewer = (email: string) =>
    api.assignSteward(nestId, { scope: "nest", users: [{ email, role: "reviewer" }] });

  // Team-sharing state (only used when showTeams).
  const [addMode, setAddMode] = useState<"person" | "team">("person");
  const [sharedTeams, setSharedTeams] = useState<SharedTeam[]>([]);
  const [myTeams, setMyTeams] = useState<Team[]>([]);
  const [selectedTeam, setSelectedTeam] = useState("");
  const [teamBusy, setTeamBusy] = useState(false);

  // Collaborator pending removal — holds the row so the styled confirm
  // dialog can show their email; null closes the dialog. Replaces a native
  // window.confirm(), which also leaked this deployment's Cloud Run URL in
  // the browser's popup chrome.
  const [removeTarget, setRemoveTarget] = useState<Collaborator | null>(null);

  const loadCollaborators = async () => {
    setLoading(true);
    try {
      const res = await qc.fetchQuery(reads.collaborators(nestId));
      setCollaborators((res?.collaborators ?? []) as Collaborator[]);
    } catch (err: any) {
      setError(err?.message || "Failed to load collaborators");
    } finally {
      setLoading(false);
    }
  };

  const loadTeams = async () => {
    try {
      const [nestTeams, owned] = await Promise.all([
        qc.fetchQuery(reads.nestTeams(nestId)),
        qc.fetchQuery(reads.teamList()).catch(() => ({ teams: [] as Team[] })),
      ]);
      setSharedTeams(nestTeams?.teams ?? []);
      setMyTeams(owned?.teams ?? []);
    } catch (err: any) {
      setError(err?.message || "Failed to load teams");
    }
  };

  useEffect(() => {
    loadCollaborators();
    if (showTeams) loadTeams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nestId]);

  // The add itself, callable without a form event: the person field submits on
  // Enter through the combobox (which owns that key while its list is open) and
  // the Add button submits the form. Both land here.
  const addPerson = async () => {
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
      if (reviewers && inviteReviewer) {
        try {
          await makeReviewer(email);
        } catch (err: any) {
          setError(`Added ${email}, but couldn't make them a reviewer: ${err?.message || "unknown error"}`);
        }
      }
      setInviteEmail("");
      setInvitePermission("read");
      setInviteReviewer(false);
      await loadCollaborators();
      onChanged();
    } catch (err: any) {
      setError(err?.message || "Failed to add collaborator");
    } finally {
      setAdding(false);
    }
  };

  const toggleReviewer = async (email: string, on: boolean) => {
    const state = nestReviewerState(stewards, email);
    setReviewerBusy(email);
    setError(null);
    try {
      if (on) await makeReviewer(email);
      else if (state.kind === "reviewer") await api.removeSteward(nestId, state.stewardId);
      toast.success(on ? `${email} can now approve documents in this nest` : `${email} is no longer a reviewer`);
      await loadCollaborators();
      onChanged();
    } catch (err: any) {
      setError(err?.message || "Failed to update reviewer");
    } finally {
      setReviewerBusy(null);
    }
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    void addPerson();
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

  const confirmRemove = async () => {
    const collab = removeTarget;
    if (!collab) return;
    setRemoveTarget(null);
    setError(null);
    try {
      await api.removeCollaborator(nestId, collab.id);
      setCollaborators((prev) => prev.filter((c) => c.id !== collab.id));
      toast.success(removeCollaboratorSuccessMessage(collabLabel(collab)));
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
              <div className="flex-1">
                {/* Searchable: an org with dozens of teams can type to narrow
                    instead of scrolling a flat dropdown. */}
                <SearchableSelect
                  value={selectedTeam}
                  onChange={setSelectedTeam}
                  options={shareableTeams.map((t) => ({
                    value: t.id,
                    label: t.name,
                  }))}
                  disabled={shareableTeams.length === 0}
                  placeholder={
                    shareableTeams.length === 0
                      ? "No teams available to share"
                      : "Select a team…"
                  }
                  searchPlaceholder="Search teams…"
                  emptyText="No teams match."
                  testId="collab-team-select"
                />
              </div>
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
              <PersonCombobox
                value={inviteEmail}
                onChange={setInviteEmail}
                onSubmit={addPerson}
                placeholder="teammate@example.com"
                disabled={adding}
                className="flex-1"
                // Someone who already has access is not an add — offering them
                // again would only produce a "already a collaborator" error.
                exclude={collaborators
                  .map((c) => c.email || "")
                  .filter(Boolean)}
                testId="collab-person-input"
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
            {reviewers && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={inviteReviewer}
                  onCheckedChange={(v) => setInviteReviewer(v === true)}
                  disabled={adding}
                  data-testid="collab-invite-reviewer"
                />
                Also make them a reviewer (approves documents across this nest)
              </label>
            )}
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
            {collaborators.map((c) => {
              const reviewer = reviewers && c.email ? nestReviewerState(stewards, c.email) : null;
              return (
              <div
                key={c.id}
                className="flex items-center gap-2 py-1.5"
                data-testid={`collaborator-row-${c.id}`}
              >
                <span className="flex-1 min-w-0 truncate text-sm" title={c.email}>
                  {collabLabel(c) || c.user_id}
                </span>
                {c.principal_kind === "system" && (
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0"
                    title="A named system key, managed in Nest settings → Systems"
                    data-testid={`collaborator-system-${c.id}`}
                  >
                    System
                  </Badge>
                )}
                {/* Steward roles held by the same user — read-only context.
                    The switch below already says "reviewer" for the nest row. */}
                {(c.stewardRoles ?? [])
                  .filter((r) => !(reviewer?.kind === "reviewer" && r === "reviewer"))
                  .map((r) => (
                  <Badge
                    key={r}
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 capitalize"
                    title="Steward role — manage in the Stewards tab"
                  >
                    {r}
                  </Badge>
                ))}
                {reviewer && (
                  <label
                    className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
                    title={
                      reviewer.kind === "other"
                        ? `Has a nest steward role (${reviewer.role}) — change it on the Stewards tab`
                        : "Reviewers approve documents across this nest"
                    }
                  >
                    <Switch
                      checked={reviewer.kind === "reviewer"}
                      disabled={reviewer.kind === "other" || reviewerBusy === c.email || stewardsQuery.isLoading}
                      onCheckedChange={(on) => void toggleReviewer(c.email!, on)}
                      aria-label={`Reviewer: ${c.email}`}
                      data-testid={`collaborator-reviewer-${c.id}`}
                    />
                    Reviewer
                  </label>
                )}
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
                        {COLLAB_PERMISSIONS.filter(
                          (p) => !(c.principal_kind === "system" && p.value === "admin"),
                        ).map((p) => (
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
                        onClick={() => setRemoveTarget(c)}
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
              );
            })}
          </div>
        )}
      </div>

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <AlertDialogContent>
          {(() => {
            const copy = removeCollaboratorConfirmCopy(removeTarget ? collabLabel(removeTarget) : undefined, nestName);
            return (
              <>
                <AlertDialogHeader>
                  <AlertDialogTitle>{copy.title}</AlertDialogTitle>
                  <AlertDialogDescription>{copy.body}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => void confirmRemove()}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    data-testid="remove-collaborator-confirm"
                  >
                    {copy.confirm}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </>
            );
          })()}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
