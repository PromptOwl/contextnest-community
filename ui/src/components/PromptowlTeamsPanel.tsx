/**
 * The PromptOwl Teams tab — the teams the caller owns in PromptOwl, with their
 * rosters, each syncable into this server on its own.
 *
 * Only rendered for sessions that signed in with PromptOwl: that sign-in is
 * what leaves the httpOnly token cookie these calls ride on. The server refuses
 * the same requests without it, so this isn't the only thing enforcing the rule.
 *
 * Syncing a team already imported here reconciles its roster to match PromptOwl
 * exactly — roles reset, locally-added members removed. That one is destructive,
 * so it asks first; a first-time import doesn't.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip, TooltipContent, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AlertCircle, AlertTriangle, Check, Download, Loader2, Lock, RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import * as api from "../lib/api";
import type { PromptowlSyncResult, PromptowlTeam, Team } from "../lib/api";

/** PromptOwl role → the role the member will get here. Mirrors the server. */
const ROLE_PREVIEW: Record<string, string> = {
  Owner: "Admin",
  Editor: "Editor",
  Viewer: "Viewer",
  User: "Viewer",
};
const localRole = (poRole: string) => ROLE_PREVIEW[poRole] ?? "Viewer";

interface Props {
  /** Local teams, so an already-imported PromptOwl team can be marked. */
  localTeams: Team[];
  /** Refetch local teams after an import changes them. */
  onImported: () => void;
}

export function PromptowlTeamsPanel({ localTeams, onImported }: Props) {
  const [teams, setTeams] = useState<PromptowlTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<PromptowlTeam | null>(null);
  const [lastResult, setLastResult] = useState<PromptowlSyncResult | null>(null);

  const importedIds = new Map(
    localTeams
      .filter((t) => t.source === "promptowl" && t.external_id)
      .map((t) => [t.external_id!, t]),
  );

  useEffect(() => {
    load();
  }, []);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listPromptowlTeams();
      setTeams(res.teams);
    } catch (err: any) {
      // The PromptOwl token was revoked upstream, or the session lost it.
      // Signing in with PromptOwl again is the only way back.
      if (api.isPromptowlConnectRequired(err)) setDisconnected(true);
      else setError(err?.message || "Could not reach PromptOwl");
    } finally {
      setLoading(false);
    }
  };

  const runSync = async (team: PromptowlTeam) => {
    setSyncingId(team.id);
    setError(null);
    try {
      const res = await api.syncPromptowlTeams([team.id]);
      setLastResult(res.results[0] ?? null);
      onImported();
      toast.success(
        res.results[0]?.created ? `Imported ${team.name}` : `Synced ${team.name}`,
      );
    } catch (err: any) {
      if (api.isPromptowlConnectRequired(err)) setDisconnected(true);
      else setError(err?.message || "Sync failed");
    } finally {
      setSyncingId(null);
      setConfirmTarget(null);
    }
  };

  /** Re-sync overwrites a roster, so confirm it. A first import can't destroy. */
  const onSyncClick = (team: PromptowlTeam) => {
    if (importedIds.has(team.id)) setConfirmTarget(team);
    else runSync(team);
  };

  if (disconnected) {
    return (
      <Alert>
        <AlertCircle className="h-4 w-4" />
        <AlertDescription>
          Your PromptOwl session has ended. Sign out and sign back in with
          PromptOwl to import teams.
        </AlertDescription>
      </Alert>
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-start gap-3">
        <p className="text-sm text-muted-foreground flex-1">
          Your PromptOwl teams. Syncing one copies it here with its members —
          people without an account are invited automatically. Teams you're
          view-only on can't be imported, since the copy would be yours to
          control.
        </p>
        <Button size="sm" variant="ghost" onClick={load} aria-label="Refresh">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {lastResult && <SyncSummary result={lastResult} />}

      {teams.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            You're not in any teams in PromptOwl.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {teams.map((team) => (
            <PromptowlTeamCard
              key={team.id}
              team={team}
              imported={importedIds.has(team.id)}
              syncing={syncingId === team.id}
              canImport={api.canImportPromptowlTeam(team)}
              onSync={() => onSyncClick(team)}
            />
          ))}
        </div>
      )}

      <Dialog
        open={!!confirmTarget}
        onOpenChange={(o) => !o && setConfirmTarget(null)}
      >
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>Sync "{confirmTarget?.name}" from PromptOwl?</DialogTitle>
          </DialogHeader>
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              PromptOwl is the source of truth. This team's roster here will be
              made to match PromptOwl exactly: roles are reset, and anyone you
              added by hand in ContextNest is removed.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={!!syncingId}
              onClick={() => confirmTarget && runSync(confirmTarget)}
            >
              {syncingId && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Sync
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PromptowlTeamCard({
  team,
  imported,
  syncing,
  canImport,
  onSync,
}: {
  team: PromptowlTeam;
  imported: boolean;
  syncing: boolean;
  canImport: boolean;
  onSync: () => void;
}) {
  return (
    <Card className={`flex flex-col${canImport ? "" : " opacity-70"}`}>
      <CardHeader className="space-y-1 pb-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold truncate">{team.name}</h3>
              <Badge variant="secondary" className="shrink-0">
                {team.members.length}
              </Badge>
              {imported && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="shrink-0 gap-1">
                      <Check className="h-3 w-3" />
                      Synced
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    Already imported. Syncing again updates it in place.
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            <p className="text-xs text-muted-foreground truncate">
              You're {team.your_role} in PromptOwl
              {team.enterprise ? ` · ${team.enterprise.name}` : ""}
            </p>
          </div>
          {canImport ? (
            <Button
              size="sm"
              variant={imported ? "outline" : "default"}
              className="shrink-0"
              disabled={syncing}
              onClick={onSync}
            >
              {syncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : imported ? (
                <RefreshCw className="h-3.5 w-3.5" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              <span className="ml-1">{imported ? "Sync" : "Import"}</span>
            </Button>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* A span, not a disabled Button: a disabled button swallows
                    hover events, so the tooltip explaining WHY would never
                    show — which is the only useful thing here. */}
                <span className="shrink-0 inline-flex items-center gap-1 text-xs text-muted-foreground border rounded-md px-2 py-1.5">
                  <Lock className="h-3 w-3" />
                  View-only
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Importing a team makes you the owner of the copy here, which is
                more than you can do with this team in PromptOwl. Ask an owner
                or editor of it to import it.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {team.members.length === 0 ? (
          <p className="text-xs text-muted-foreground">No members.</p>
        ) : (
          team.members.map((m) => (
            <div key={m.email} className="flex items-center gap-2 text-sm">
              <span className="flex-1 truncate">{m.email}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {localRole(m.role)}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {m.role} in PromptOwl → {localRole(m.role)} here
                </TooltipContent>
              </Tooltip>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

/** What the last sync actually changed — emails, so it's checkable. */
function SyncSummary({ result }: { result: PromptowlSyncResult }) {
  const unchanged =
    !result.added.length && !result.updated.length && !result.removed.length;
  return (
    <Alert>
      <Check className="h-4 w-4" />
      <AlertDescription className="text-xs space-y-0.5">
        <div className="font-medium">
          {result.name} — {result.created ? "imported" : "synced"}
        </div>
        {unchanged ? (
          <div>Already up to date.</div>
        ) : (
          <>
            {result.added.length > 0 && <div>Added: {result.added.join(", ")}</div>}
            {result.updated.length > 0 && (
              <div>Role changed: {result.updated.join(", ")}</div>
            )}
            {result.removed.length > 0 && (
              <div>Removed: {result.removed.join(", ")}</div>
            )}
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}
