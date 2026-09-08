/**
 * NestVisibilityControl — private ↔ public for a whole nest
 * (PATCH /nests/:id/visibility, admin-gated server-side).
 *
 * The switch is deliberately still two-state. The API also accepts 'org'
 * (readable by every authenticated user of this deployment), but nothing in
 * the UI sets it yet — so this control only has to REPORT that state
 * honestly, not offer it. Saying "Private" for an org nest would tell an
 * owner the opposite of the truth, which is why the label reads off the
 * visibility string rather than a boolean.
 *
 * Lives on its own so the Collaborators tab and the Share dialog show the
 * same control instead of the tab deferring visibility to the dialog
 * (CU-wdqcpzzzy6). Self-fetches the current value; reports failures through
 * `onError` so each host renders them where it already shows errors.
 *
 * Going public is guarded here rather than in each host: the server requires
 * acknowledge_public and 409s without it, so the control that owns the switch
 * owns the acknowledgement too.
 */
import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { Globe, Lock, Loader2, Building2 } from "lucide-react";
import * as api from "../lib/api";

interface Props {
  nestId: string;
  /** Fired after a successful change so the parent can refresh its state. */
  onChanged: () => void;
  onError?: (message: string | null) => void;
}

export function NestVisibilityControl({ nestId, onChanged, onError }: Props) {
  const [visibility, setVisibility] = useState<string>("private");
  const isPublic = visibility === "public";
  const isOrg = visibility === "org";
  const [saving, setSaving] = useState(false);
  // Publishing (→ public) is guarded by an acknowledgement dialog: the nest
  // becomes readable by anyone on the internet, outside your organization.
  const [confirmPublic, setConfirmPublic] = useState(false);

  useEffect(() => {
    // Read current visibility straight from the server so the toggle
    // reflects truth without the parent having to thread it through.
    api
      .getNest(nestId)
      .then((res) => setVisibility(res.nest?.visibility || "private"))
      .catch(() => {
        /* leave default; the roster below surfaces any real error */
      });
  }, [nestId]);

  const apply = async (next: boolean, acknowledgePublic?: boolean) => {
    // Optimistic flip; revert on failure so the switch never lies about
    // server state (same pattern as NestSettingsModal's stewardship save).
    setVisibility(next ? "public" : "private");
    setSaving(true);
    onError?.(null);
    try {
      const result = await api.setNestVisibility(
        nestId,
        next ? "public" : "private",
        acknowledgePublic,
      );
      if ((result.visibility === "public") !== next) {
        setVisibility(result.visibility || (next ? "private" : "public"));
        onError?.(
          "Server did not accept the change. You may not have admin access to this nest.",
        );
        return;
      }
      onChanged();
    } catch (err: any) {
      setVisibility(next ? "private" : "public");
      onError?.(err?.message || "Failed to change visibility");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (next: boolean) => {
    // Confirm before going public — the switch only moves once acknowledged.
    // Going back to private needs no acknowledgement.
    if (next) {
      setConfirmPublic(true);
      return;
    }
    await apply(false);
  };

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label className="flex items-center gap-2 text-sm font-medium">
            {isPublic ? (
              <Globe className="h-4 w-4 text-green-600" />
            ) : isOrg ? (
              <Building2 className="h-4 w-4 text-blue-600" />
            ) : (
              <Lock className="h-4 w-4" />
            )}
            {isPublic ? "Public" : isOrg ? "Organization" : "Private"}
          </Label>
          <p className="text-xs text-muted-foreground">
            {isPublic
              ? "Anyone on this server can read this nest. Editing still requires being added below."
              : isOrg
                ? "Everyone signed in to this deployment can read this nest. Editing still requires being added below."
                : "Only people added below (and the owner) can see this nest."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saving && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
          {isOrg && (
            <button
              type="button"
              className="text-xs underline text-muted-foreground hover:text-foreground"
              disabled={saving}
              onClick={() => void apply(false)}
            >
              Make private
            </button>
          )}
          <Switch
            checked={isPublic}
            onCheckedChange={toggle}
            disabled={saving}
            aria-label="Toggle public visibility"
          />
        </div>
      </div>

      <AlertDialog open={confirmPublic} onOpenChange={setConfirmPublic}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make this nest public?</AlertDialogTitle>
            <AlertDialogDescription>
              This makes the nest readable by anyone on the internet, outside
              your organization. Anyone with the URL will be able to read it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmPublic(false);
                void apply(true, true);
              }}
            >
              Make public
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
