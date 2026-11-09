/**
 * TeamCreateInline — the empty state of team sharing. A user with no team to
 * share can create one here and share it onto the nest in one step, instead
 * of leaving the dialog for the Teams page. Members are added on the Teams
 * page (linked), where roles are set; PromptOwl team import lives there too.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import * as api from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "../lib/queries";

interface Props {
  nestId: string;
  /** Fired after the team is created and shared. */
  onShared: () => void | Promise<void>;
}

export function TeamCreateInline({ nestId, onShared }: Props) {
  const { promptowlTeamsEnabled } = useAuth();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const { team } = await api.createTeam(trimmed);
      await api.shareNestWithTeam(nestId, team.id);
      setName("");
      // The pickers read these through the query cache; drop them so the new
      // team and the new share show at once.
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.teamList() }),
        qc.invalidateQueries({ queryKey: keys.nestTeams(nestId) }),
      ]);
      toast.success(`Created "${team.name}" and shared this nest with it. Add members on the Teams page.`);
      await onShared();
    } catch (err: any) {
      toast.error(err?.message || "Failed to create the team");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="team-create-inline">
      <p className="text-xs text-muted-foreground">
        You have no teams to share yet. Create one for the people who should
        read this nest.
      </p>
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void create();
          }}
          placeholder="Team name, for example Finance"
          className="h-8"
          aria-label="New team name"
          data-testid="team-create-name"
        />
        <Button size="sm" onClick={() => void create()} disabled={busy || !name.trim()}>
          {busy ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
          Create and share
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        <a href="/teams" className="underline underline-offset-2">
          {promptowlTeamsEnabled ? "Add members or import teams from PromptOwl" : "Add members"}
        </a>{" "}
        on the Teams page.
      </p>
    </div>
  );
}
