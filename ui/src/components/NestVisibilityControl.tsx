/**
 * NestVisibilityControl — private ↔ public for a whole nest
 * (PATCH /nests/:id/visibility, admin-gated server-side).
 *
 * Lives on its own so the Collaborators tab and the Share dialog show the
 * same control instead of the tab deferring visibility to the dialog
 * (CU-wdqcpzzzy6). Self-fetches the current value; reports failures through
 * `onError` so each host renders them where it already shows errors.
 */
import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Globe, Lock, Loader2 } from "lucide-react";
import * as api from "../lib/api";

interface Props {
  nestId: string;
  /** Fired after a successful change so the parent can refresh its state. */
  onChanged: () => void;
  onError?: (message: string | null) => void;
}

export function NestVisibilityControl({ nestId, onChanged, onError }: Props) {
  const [isPublic, setIsPublic] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Read current visibility straight from the server so the toggle
    // reflects truth without the parent having to thread it through.
    api
      .getNest(nestId)
      .then((res) => setIsPublic(res.nest?.visibility === "public"))
      .catch(() => {
        /* leave default; the roster below surfaces any real error */
      });
  }, [nestId]);

  const toggle = async (next: boolean) => {
    // Optimistic flip; revert on failure so the switch never lies about
    // server state (same pattern as NestSettingsModal's stewardship save).
    setIsPublic(next);
    setSaving(true);
    onError?.(null);
    try {
      const result = await api.setNestVisibility(
        nestId,
        next ? "public" : "private",
      );
      if ((result.visibility === "public") !== next) {
        setIsPublic(!next);
        onError?.(
          "Server did not accept the change. You may not have admin access to this nest.",
        );
        return;
      }
      onChanged();
    } catch (err: any) {
      setIsPublic(!next);
      onError?.(err?.message || "Failed to change visibility");
    } finally {
      setSaving(false);
    }
  };

  return (
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
          {saving && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
          <Switch
            checked={isPublic}
            onCheckedChange={toggle}
            disabled={saving}
            aria-label="Toggle public visibility"
          />
        </div>
      </div>
    </div>
  );
}
