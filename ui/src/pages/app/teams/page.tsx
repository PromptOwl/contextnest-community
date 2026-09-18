/**
 * TeamsPage — manage the caller's teams. Teams render as a compact card grid
 * (scales past dozens of teams); creating and editing happen in modals, so the
 * cards stay read-mostly. Each member shows a status tick — green = registered
 * account, red = invited placeholder — and long rosters collapse to the first
 * five with the rest revealed on hover.
 *
 * A team is a reusable group; a member's role applies on every nest the team is
 * shared to (sharing happens from a nest's Share dialog, in CollaboratorManager).
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PageTitle } from "@/components/ui/page-title";
import { Input } from "@/components/ui/input";
import { PersonCombobox } from "../../../components/PersonCombobox";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/tabs";
import {
  Users, Plus, Trash2, Loader2, AlertCircle, UserPlus,
  CheckCircle2, XCircle, Pencil, X,
} from "lucide-react";
import { toast } from "sonner";
import { PromptowlTeamsPanel } from "../../../components/PromptowlTeamsPanel";
import * as api from "../../../lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { reads } from "../../../lib/queries";
import type { Team, TeamMember, TeamRole } from "../../../lib/api";
import { TEAM_ROLES } from "../../../lib/api";
import { useAuth } from "../../../auth/AuthContext";
import { isEmailish } from "../../../lib/utils";

const MAX_VISIBLE_MEMBERS = 5;
const roleLabel = (role: string) =>
  TEAM_ROLES.find((r) => r.value === role)?.label ?? role;

// Mirrors the server's team-management ranks (teams-service.ts). Owner /
// server admin = 5; member roles below. Drives which controls the UI shows —
// the server enforces the same rules regardless.
const ROLE_RANK: Record<string, number> = { viewer: 1, editor: 2, admin: 3 };
const OWNER_RANK = 4;

/** The caller's management rank on a team (see ROLE_RANK). */
function myTeamRank(team: Team, myEmail: string, isServerAdmin: boolean): number {
  if (isServerAdmin) return OWNER_RANK;
  if (team.owner_email && team.owner_email.toLowerCase() === myEmail) return OWNER_RANK;
  const m = team.members.find((x) => (x.email || "").toLowerCase() === myEmail);
  return m ? ROLE_RANK[m.role] ?? 0 : 0;
}


export default function TeamsPage() {
  const { adminStatus, isAdmin, promptowlTeamsEnabled } = useAuth();
  const myEmail = (adminStatus?.me?.email || "").toLowerCase();
  // Importing needs the PromptOwl token from a PromptOwl sign-in, so the tab is
  // only offered to those sessions. Read once: it can't change without a
  // sign-in, which remounts this anyway. The server enforces the same rule.
  // Also gated by the PROMPTOWL_TEAMS_ENABLED feature flag: off → /teams/promptowl
  // 404s, so hide the panel to match.
  const [hasPromptowlSession] = useState(() => api.hasPromptowlSession());
  const promptowlSession = promptowlTeamsEnabled && hasPromptowlSession;
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<Team | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Team | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchTeams = async () => {
    setError(null);
    try {
      const res = await qc.fetchQuery(reads.teamList());
      setTeams(res.teams);
      // Keep an open edit modal in sync with refetched data.
      setEditTarget((prev) =>
        prev ? res.teams.find((t) => t.id === prev.id) ?? null : null,
      );
    } catch (err: any) {
      setError(err?.message || "Failed to load teams");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTeams();
  }, []);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deleteTeam(deleteTarget.id);
      toast.success("Team deleted");
      setDeleteTarget(null);
      await fetchTeams();
    } catch (err: any) {
      toast.error(err?.message || "Failed to delete team");
    } finally {
      setDeleting(false);
    }
  };

  const localTeams = loading ? (
    <div className="flex justify-center py-12">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  ) : teams.length === 0 ? (
    <Card>
      <CardContent className="py-10 text-center text-sm text-muted-foreground">
        No teams yet. Create one to share a nest with a whole group at once.
      </CardContent>
    </Card>
  ) : (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {teams.map((team) => (
        <TeamCard
          key={team.id}
          team={team}
          rank={myTeamRank(team, myEmail, isAdmin)}
          onEdit={() => setEditTarget(team)}
          onDelete={() => setDeleteTarget(team)}
        />
      ))}
    </div>
  );

  return (
    <TooltipProvider delayDuration={150}>
      <div className="w-full mx-auto space-y-4">
        <PageTitle
          icon={Users}
          title="Teams"
          description={
            <>
              A team is a reusable group. Give each member a role, then share the
              team with a nest from its <strong>Share</strong> dialog — every member
              gets their role on that nest.
            </>
          }
          actions={
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4 mr-1" />
              New Team
            </Button>
          }
        />

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Without a PromptOwl sign-in there's nothing to import from, so the
            tab strip would be a single tab — show the list bare instead. */}
        {promptowlSession ? (
          <Tabs defaultValue="cn">
            <TabsList>
              <TabsTrigger value="cn">ContextNest Teams</TabsTrigger>
              <TabsTrigger value="po">PromptOwl Teams</TabsTrigger>
            </TabsList>
            <TabsContent value="cn" className="mt-4">
              {localTeams}
            </TabsContent>
            <TabsContent value="po" className="mt-4">
              <PromptowlTeamsPanel localTeams={teams} onImported={fetchTeams} />
            </TabsContent>
          </Tabs>
        ) : (
          localTeams
        )}
      </div>

      {showCreate && (
        <CreateTeamModal
          onClose={() => setShowCreate(false)}
          onCreated={fetchTeams}
        />
      )}

      {editTarget && (
        <EditTeamModal
          team={editTarget}
          rank={myTeamRank(editTarget, myEmail, isAdmin)}
          onClose={() => setEditTarget(null)}
          onChanged={fetchTeams}
        />
      )}

      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Delete team "{deleteTarget?.name}"?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Members lose access to every nest this team is shared with. This
            can't be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={confirmDelete}>
              {deleting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

/** Green tick = registered account, red = invited placeholder. */
function MemberStatus({ registered }: { registered?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0 flex items-center">
          {registered ? (
            <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
          ) : (
            <XCircle className="h-3.5 w-3.5 text-red-500" />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {registered ? "Registered account" : "Invited — hasn't signed up yet"}
      </TooltipContent>
    </Tooltip>
  );
}

function MemberLine({ member }: { member: TeamMember }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <MemberStatus registered={member.registered} />
      <span className="flex-1 truncate">{member.email}</span>
      <span className="text-xs text-muted-foreground shrink-0">
        {roleLabel(member.role)}
      </span>
    </div>
  );
}

function TeamCard({
  team,
  rank,
  onEdit,
  onDelete,
}: {
  team: Team;
  rank: number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const visible = team.members.slice(0, MAX_VISIBLE_MEMBERS);
  const overflow = team.members.slice(MAX_VISIBLE_MEMBERS);
  const canEdit = rank >= ROLE_RANK.editor; // add people (or more)
  const canDelete = rank >= OWNER_RANK; // owner / server admin only

  return (
    <Card className="flex flex-col">
      <CardHeader className="space-y-1 pb-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold truncate">{team.name}</h3>
              <Badge variant="secondary" className="shrink-0">
                {team.members.length}
              </Badge>
              {team.source === "promptowl" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="shrink-0">
                      PromptOwl
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    Imported from PromptOwl. Re-syncing makes this roster match
                    PromptOwl exactly.
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            {team.owner_email && (
              <p className="text-xs text-muted-foreground truncate">
                Created by {team.owner_email}
              </p>
            )}
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            {canEdit && (
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onEdit} aria-label="Edit team">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
            {canDelete && (
              <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={onDelete} aria-label="Delete team">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {team.members.length === 0 ? (
          <p className="text-xs text-muted-foreground">No members yet.</p>
        ) : (
          <>
            {visible.map((m) => (
              <MemberLine key={m.userId} member={m} />
            ))}
            {overflow.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button className="text-xs text-muted-foreground hover:text-foreground text-left">
                    +{overflow.length} more member{overflow.length === 1 ? "" : "s"}
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <div className="space-y-1">
                    {overflow.map((m) => (
                      <div key={m.userId} className="flex items-center gap-2 text-xs">
                        {m.registered ? (
                          <CheckCircle2 className="h-3 w-3 text-green-600 shrink-0" />
                        ) : (
                          <XCircle className="h-3 w-3 text-red-500 shrink-0" />
                        )}
                        <span className="truncate">{m.email}</span>
                        <span className="opacity-70">· {roleLabel(m.role)}</span>
                      </div>
                    ))}
                  </div>
                </TooltipContent>
              </Tooltip>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Role picker + email input row, reused by the create and edit modals.
 *  `maxRank` caps the grantable roles to the caller's own level (escalation
 *  cap), matching the server. */
function AddMemberRow({
  onAdd,
  busy,
  maxRank = OWNER_RANK,
  members = [],
}: {
  onAdd: (email: string, role: TeamRole) => void | Promise<void>;
  busy?: boolean;
  maxRank?: number;
  /** Addresses already on the roster — kept out of the suggestions. */
  members?: string[];
}) {
  const grantable = TEAM_ROLES.filter((r) => ROLE_RANK[r.value] <= maxRank);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRole>(grantable[0]?.value ?? "viewer");
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    const e = email.trim();
    if (!e) return;
    // Reject malformed input before it becomes a member chip — the server
    // trusts the email, so a bad value would otherwise stick as a phantom
    // member that can never register/match.
    if (!isEmailish(e)) {
      setError("Enter a valid email address.");
      return;
    }
    setError(null);
    void Promise.resolve(onAdd(e, role)).then(() => {
      setEmail("");
      setRole(grantable[0]?.value ?? "viewer");
    });
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
        <PersonCombobox
          value={email}
          onChange={(next) => {
            setEmail(next);
            if (error) setError(null);
          }}
          onSubmit={submit}
          placeholder="person@company.com"
          // Current members aren't adds; offering them would only re-set the
          // role of someone the list below already manages.
          exclude={members}
          className="flex-1"
          testId="team-member-input"
        />
        <Select value={role} onValueChange={(v) => setRole(v as TeamRole)}>
          <SelectTrigger className="w-full sm:w-[130px] h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {grantable.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={submit} disabled={busy || !email.trim()}>
          <UserPlus className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function CreateTeamModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [staged, setStaged] = useState<{ email: string; role: TeamRole }[]>([]);
  const [saving, setSaving] = useState(false);

  const stage = (email: string, role: TeamRole) => {
    if (staged.some((s) => s.email.toLowerCase() === email.toLowerCase())) {
      toast.error("Already added");
      return;
    }
    setStaged((prev) => [...prev, { email, role }]);
  };

  const create = async () => {
    const teamName = name.trim();
    if (!teamName) return;
    setSaving(true);
    try {
      const { team } = await api.createTeam(teamName);
      for (const m of staged) {
        try {
          await api.addTeamMember(team.id, { email: m.email, role: m.role });
        } catch (err: any) {
          toast.error(`${m.email}: ${err?.message || "could not add"}`);
        }
      }
      toast.success(`Team "${teamName}" created`);
      onCreated();
      onClose();
    } catch (err: any) {
      toast.error(err?.message || "Failed to create team");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>New team</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            autoFocus
            placeholder="Team name (e.g. Platform)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              Members (optional)
            </p>
            {staged.length > 0 && (
              <div className="space-y-1.5">
                {staged.map((m) => (
                  <div key={m.email} className="flex items-center gap-2 text-sm">
                    <span className="flex-1 truncate">{m.email}</span>
                    <span className="text-xs text-muted-foreground">
                      {roleLabel(m.role)}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      onClick={() =>
                        setStaged((prev) => prev.filter((s) => s.email !== m.email))
                      }
                      aria-label={`Remove ${m.email}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <AddMemberRow onAdd={stage} members={staged.map((m) => m.email)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={create} disabled={saving || !name.trim()}>
            {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditTeamModal({
  team,
  rank,
  onClose,
  onChanged,
}: {
  team: Team;
  rank: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const canManage = rank >= ROLE_RANK.admin; // rename, change role, remove
  const canAdd = rank >= ROLE_RANK.editor; // add people (escalation-capped)
  const [name, setName] = useState(team.name);
  const [busy, setBusy] = useState(false);

  const guard = async (fn: () => Promise<any>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(ok);
      onChanged();
    } catch (err: any) {
      toast.error(err?.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const saveName = async () => {
    if (!canManage) return;
    const next = name.trim();
    if (!next || next === team.name) return;
    await guard(() => api.renameTeam(team.id, next), "Team renamed");
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Edit team</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => e.key === "Enter" && saveName()}
              className="h-9"
              disabled={!canManage}
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              Members
            </p>
            {team.members.length === 0 ? (
              <p className="text-xs text-muted-foreground">No members yet.</p>
            ) : (
              <div className="space-y-2">
                {team.members.map((m) => (
                  <div key={m.userId} className="flex items-center gap-2">
                    <MemberStatus registered={m.registered} />
                    <span className="text-sm flex-1 truncate">{m.email}</span>
                    {canManage ? (
                      <Select
                        value={m.role}
                        onValueChange={(v) =>
                          guard(
                            () => api.updateTeamMemberRole(team.id, m.userId, v as TeamRole),
                            "Role updated",
                          )
                        }
                      >
                        <SelectTrigger className="w-[120px] h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TEAM_ROLES.map((r) => (
                            <SelectItem key={r.value} value={r.value}>
                              {r.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Badge variant="secondary" className="text-[11px]">
                        {roleLabel(m.role)}
                      </Badge>
                    )}
                    {canManage && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        disabled={busy}
                        onClick={() =>
                          guard(
                            () => api.removeTeamMember(team.id, m.userId),
                            "Member removed",
                          )
                        }
                        aria-label={`Remove ${m.email}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {canAdd && (
              <div className="pt-1 border-t">
                <div className="pt-2">
                  <AddMemberRow
                    busy={busy}
                    maxRank={rank}
                    members={team.members.map((m) => m.email)}
                    onAdd={(email, role) =>
                      guard(
                        () => api.addTeamMember(team.id, { email, role }),
                        "Member added",
                      )
                    }
                  />
                </div>
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
