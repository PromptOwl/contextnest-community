/**
 * TeamShareManager — a dedicated "Teams" section for the Share dialog: share a
 * whole team onto a nest, and list/unshare the teams already shared. This is
 * the standalone box; CollaboratorManager (showTeams) also lets you add a team
 * from the collaborator add control — both drive the same endpoints.
 *
 * Each shared team brings its members in at their own role (managed on the
 * Teams page, not here). Admin-gated server-side (POST/DELETE /nests/:id/teams).
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SearchableSelect } from "./SearchableSelect";
import { Users, Trash2, Loader2, AlertCircle, Share2 } from "lucide-react";
import { toast } from "sonner";
import * as api from "../lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { reads } from "../lib/queries";
import type { Team, TeamMember } from "../lib/api";
import { TeamCreateInline } from "./TeamCreateInline";

interface SharedTeam {
  teamId: string;
  teamName: string;
  members: TeamMember[];
}

interface TeamShareManagerProps {
  nestId: string;
  onChanged: () => void;
}

export function TeamShareManager({ nestId, onChanged }: TeamShareManagerProps) {
  const [shared, setShared] = useState<SharedTeam[]>([]);
  const [myTeams, setMyTeams] = useState<Team[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [nestTeams, owned] = await Promise.all([
        qc.fetchQuery(reads.nestTeams(nestId)),
        // The caller may not own any teams; a failure here shouldn't blank the
        // shared list, so swallow it into an empty picker.
        qc.fetchQuery(reads.teamList()).catch(() => ({ teams: [] as Team[] })),
      ]);
      setShared(nestTeams.teams);
      setMyTeams(owned.teams);
    } catch (err: any) {
      setError(err?.message || "Failed to load teams");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nestId]);

  const sharedIds = new Set(shared.map((s) => s.teamId));
  const shareable = myTeams.filter((t) => !sharedIds.has(t.id));

  const share = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await api.shareNestWithTeam(nestId, selected);
      setSelected("");
      toast.success("Team shared");
      await fetchAll();
      onChanged();
    } catch (err: any) {
      toast.error(err?.message || "Failed to share team");
    } finally {
      setBusy(false);
    }
  };

  const unshare = async (teamId: string, teamName: string) => {
    setBusy(true);
    try {
      await api.unshareNestTeam(nestId, teamId);
      toast.success(`"${teamName}" unshared`);
      await fetchAll();
      onChanged();
    } catch (err: any) {
      toast.error(err?.message || "Failed to unshare team");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <Label className="flex items-center gap-2 text-sm font-medium">
        <Users className="h-4 w-4" />
        Teams
      </Label>
      <p className="text-xs text-muted-foreground">
        Share with a whole team at once. Only its members can read the nest,
        each at the role they hold on the team. Manage members on the Teams
        page.
      </p>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {shared.length > 0 && (
            <div className="space-y-2">
              {shared.map((t) => (
                <div key={t.teamId} className="flex items-center gap-2">
                  <span className="text-sm flex-1 truncate">{t.teamName}</span>
                  <Badge variant="secondary">
                    {t.members.length} member{t.members.length === 1 ? "" : "s"}
                  </Badge>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    disabled={busy}
                    onClick={() => unshare(t.teamId, t.teamName)}
                    aria-label={`Unshare ${t.teamName}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {myTeams.length === 0 ? (
            <TeamCreateInline
              nestId={nestId}
              onShared={async () => {
                await fetchAll();
                onChanged();
              }}
            />
          ) : (
          <div className="flex items-center gap-2 pt-1">
            <div className="flex-1">
              {/* Searchable rather than a flat dropdown: past a handful of
                  teams, scrolling is the wrong interaction. */}
              <SearchableSelect
                value={selected}
                onChange={setSelected}
                options={shareable.map((t) => ({ value: t.id, label: t.name }))}
                disabled={shareable.length === 0}
                placeholder={
                  shareable.length === 0
                    ? "No more teams to share"
                    : "Select a team…"
                }
                searchPlaceholder="Search teams…"
                emptyText="No teams match."
                testId="team-share-select"
              />
            </div>
            <Button size="sm" onClick={share} disabled={busy || !selected}>
              <Share2 className="h-4 w-4 mr-1" />
              Share
            </Button>
          </div>
          )}
        </>
      )}
    </div>
  );
}
