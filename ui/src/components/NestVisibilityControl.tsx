/**
 * NestVisibilityControl — private / organization / public for a whole nest
 * (PATCH /nests/:id/visibility, admin-gated server-side).
 *
 * A select rather than a switch because visibility is three-valued: 'org'
 * (readable by every authenticated user of this deployment) sits between the
 * other two, and a boolean control could report it but never set it — an org
 * nest's only move would be escalate-to-public.
 *
 * Lives on its own so the Collaborators tab and the Share dialog show the
 * same control instead of the tab deferring visibility to the dialog
 * (CU-wdqcpzzzy6). Self-fetches the current value; reports failures through
 * `onError` so each host renders them where it already shows errors.
 *
 * Going public is guarded here rather than in each host: the server requires
 * acknowledge_public and 409s without it, so the control that owns the switch
 * owns the acknowledgement too. On a SHARED deployment (/health
 * shared_deployment — the PromptOwl-hosted server, many customers on one
 * install) 'org' is every customer, so it is guarded the same way and both
 * tiers are worded to say who they reach. The dialog also shows the nest's
 * description — that is all a stranger discovering the nest will see beside
 * its name — and offers to add one when it is empty (CU-wdqcq02mek).
 *
 * On a shared deployment the picker leaves out Organization (unless the nest
 * is already org) and offers "Share with a team…" instead, through the
 * host's `onShareWithTeam` (visibilityPickerOptions).
 *
 * A server admin can restrict widening to Public or Organization to server
 * admins (/health nest_public_visibility / nest_org_visibility). A blocked
 * tier is shown disabled with the reason; the server refuses it regardless.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
import { Globe, Lock, Loader2, Building2, ChevronDown, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import * as api from "../lib/api";
import { useNestMeta, keys } from "../lib/queries";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { Textarea } from "@/components/ui/textarea";
import {
  visibilityNeedsAcknowledgement,
  visibilityTierHint,
  visibilityConfirmCopy,
  visibilityPickerOptions,
  settleVisibilityChange,
  type VisibilityPickerValue,
} from "../lib/visibility-confirm";
import { OrgContributionsSetting } from "./OrgContribution";

interface Props {
  nestId: string;
  /** Fired after a successful change so the parent can refresh its state. */
  onChanged: () => void;
  onError?: (message: string | null) => void;
  /** "card" (default): the explained control the Collaborators tab and Share
   *  dialog show. "compact": one small button for a top bar — the current
   *  tier as its label, the three tiers in a menu. "header": the same menu
   *  behind the nest header's outlined badge button. Same fetch, same apply,
   *  same going-public acknowledgement. */
  variant?: "card" | "compact" | "header";
  /** Opens team sharing for this nest. On a shared deployment the picker
   *  offers "Share with a team…" in place of Organization (which there
   *  reaches every organization on the server) and calls this. Without it
   *  the team choice is not offered. */
  onShareWithTeam?: () => void;
}

export function NestVisibilityControl({
  nestId,
  onChanged,
  onError,
  variant = "card",
  onShareWithTeam,
}: Props) {
  const [visibility, setVisibility] = useState<api.NestVisibility>("private");
  const isPublic = visibility === "public";
  const isOrg = visibility === "org";
  const [saving, setSaving] = useState(false);
  // Widening past the roster is guarded by an acknowledgement dialog: always
  // for 'public', and for 'org' on a shared deployment. Holds the tier being
  // confirmed; null = closed.
  const [confirming, setConfirming] = useState<"org" | "public" | null>(null);
  const { sharedDeployment, nestPublicVisibility, nestOrgVisibility, isAdmin, authMode } =
    useAuth();
  const ctx = { sharedDeployment };
  const policy = {
    publicBy: nestPublicVisibility,
    orgBy: nestOrgVisibility,
    isServerAdmin: isAdmin || authMode === "open",
  };
  const qc = useQueryClient();
  // The description is what a discovering reader sees beside the name, so
  // the dialog shows it and lets an empty one be filled in on the spot.
  const [descriptionDraft, setDescriptionDraft] = useState("");

  // The same cached GET /nests/:id every nest screen reads — the compact
  // variant sits on every document page, so a second fetch per view would
  // add up, and the cache is what onChanged invalidates.
  const meta = useNestMeta(nestId);
  const serverVisibility = (meta.data as any)?.nest?.visibility as
    | api.NestVisibility
    | undefined;
  const serverDescription =
    ((meta.data as any)?.nest?.description as string | null | undefined) ?? "";
  const canManageSettings = ["owner", "admin"].includes(
    ((meta.data as any)?.permission as string | undefined) ?? "",
  );
  useEffect(() => {
    if (serverVisibility) setVisibility(serverVisibility);
  }, [serverVisibility]);

  // Every variant offers all three tiers (the header used to flip
  // private <-> public only), with a capped tier disabled and explained.
  // Measured from the server value, not the optimistic one, so a pending
  // change can't unlock a tier.
  const options = visibilityPickerOptions(serverVisibility ?? visibility, ctx, policy, {
    canShareWithTeam: !!onShareWithTeam,
  });

  const apply = async (target: api.NestVisibility, acknowledgePublic?: boolean) => {
    // Optimistic change; settleVisibilityChange reverts to the PREVIOUS value
    // on failure and otherwise takes the server's re-read answer verbatim.
    const prev = visibility;
    setVisibility(target);
    setSaving(true);
    onError?.(null);
    const settled = await settleVisibilityChange(prev, target, () =>
      api.setNestVisibility(nestId, target, acknowledgePublic),
    );
    setVisibility(settled.visibility);
    setSaving(false);
    if (settled.error) onError?.(settled.error);
    else onChanged();
  };

  const choose = async (next: VisibilityPickerValue) => {
    // Team sharing is not a tier: it opens the Teams tab and leaves the
    // nest's visibility as it is.
    if (next === "team") {
      onShareWithTeam?.();
      return;
    }
    if (next === visibility) return;
    const blocked = options.find((o) => o.value === next);
    if (blocked?.disabled) {
      onError?.(blocked.hint);
      return;
    }
    // The value only changes once acknowledged. Private never needs it; the
    // rule for the other two lives in visibility-confirm.ts with the server.
    if (next !== "private" && visibilityNeedsAcknowledgement(next, ctx)) {
      setDescriptionDraft(serverDescription);
      setConfirming(next);
      return;
    }
    await apply(next);
  };

  // Confirm: save a newly written description first (best-effort — a failed
  // description save must not block the visibility change the user just
  // acknowledged), then apply with the acknowledgement.
  const confirmWiden = async () => {
    const tier = confirming;
    if (!tier) return;
    setConfirming(null);
    const nextDescription = descriptionDraft.trim();
    if (nextDescription && nextDescription !== serverDescription.trim()) {
      try {
        await api.updateNest(nestId, { description: nextDescription });
        // Refresh the cached nest now — apply() only signals the host on a
        // successful visibility change, and the description landed regardless.
        void qc.invalidateQueries({ queryKey: keys.nest(nestId) });
      } catch (err: any) {
        onError?.(err?.message || "Failed to save the description");
      }
    }
    await apply(tier, true);
  };

  const copy = confirming ? visibilityConfirmCopy(confirming, ctx) : null;
  const confirmDialog = (
    <AlertDialog
      open={confirming !== null}
      onOpenChange={(o) => {
        if (!o) setConfirming(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy?.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy?.body}</AlertDialogDescription>
        </AlertDialogHeader>
        {/* What those readers will see beside the name. Prefilled from the
            nest; an empty one can be written here and is saved on confirm. */}
        <div className="space-y-1.5">
          <Label htmlFor="visibility-description" className="text-xs">
            {serverDescription.trim()
              ? "Description readers will see"
              : "This nest has no description — readers will only see its name. Add one? (optional)"}
          </Label>
          <Textarea
            id="visibility-description"
            value={descriptionDraft}
            onChange={(e) => setDescriptionDraft(e.target.value)}
            placeholder="What this nest is for, and who it's meant for"
            rows={2}
            data-testid="visibility-description"
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => void confirmWiden()}
            data-testid="visibility-confirm"
          >
            {copy?.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (variant === "compact" || variant === "header") {
    // Until the nest read lands the local state is the "private" default —
    // showing it would flash a Lock on a public nest. The read is the cached
    // one every nest screen shares, so this is a frame on a cold load only.
    if (!serverVisibility) return null;
    const Icon = isPublic ? Globe : isOrg ? Building2 : Lock;
    const label = options.find((o) => o.value === visibility)?.label ?? "Private";
    const title = `${label} — ${visibilityTierHint(visibility, ctx)}. Click to change.`;
    const icon = saving ? (
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
    ) : (
      <Icon
        className={`h-3.5 w-3.5 ${variant === "compact" ? (isPublic ? "text-green-600" : isOrg ? "text-blue-600" : "") : ""}`}
      />
    );
    return (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {variant === "header" ? (
              // The nest header's outlined badge button (CU-wdqcpztgwk), now
              // a menu of all three tiers instead of a private <-> public flip.
              <Button
                variant="outline"
                size="sm"
                disabled={saving}
                className={`shrink-0 h-7 gap-1.5 ${isPublic ? "border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100" : ""}`}
                title={title}
                aria-label={`Nest visibility: ${label}`}
                data-testid="nest-visibility-header"
              >
                {icon}
                {label}
                <ChevronDown className="h-3 w-3 opacity-60" />
              </Button>
            ) : (
              <button
                type="button"
                disabled={saving}
                className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
                title={title}
                aria-label={`Nest visibility: ${label}`}
                data-testid="nest-visibility-compact"
              >
                {icon}
                <span className="hidden sm:inline">{label}</span>
                <ChevronDown className="h-3 w-3 opacity-60" />
              </button>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align={variant === "header" ? "start" : "end"} className="w-64">
            {options.map((o) => (
              <DropdownMenuItem
                key={o.value}
                onClick={() => void choose(o.value)}
                disabled={o.disabled}
                className="flex items-start gap-2"
                data-testid={`nest-visibility-option-${o.value}`}
              >
                {o.value === visibility ? (
                  <Check className="mt-0.5 h-4 w-4 shrink-0" />
                ) : (
                  <span className="w-4 shrink-0" />
                )}
                <span className="flex flex-col">
                  <span className="text-sm">{o.label}</span>
                  <span className="text-xs text-muted-foreground">{o.hint}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {confirmDialog}
      </>
    );
  }

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
              ? sharedDeployment
                ? "Anyone on the internet with the URL can read this nest — including every account on this server, other organizations too. Editing still requires being added below."
                : "Anyone on the internet with the URL can read this nest. Editing still requires being added below."
              : isOrg
                ? sharedDeployment
                  ? "Every account on this server can read this nest — other organizations included, not just yours. Editing still requires being added below."
                  : "Everyone signed in to this deployment can read this nest. Editing still requires being added below."
                : "Only people added below (and the owner) can see this nest."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saving && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
          <Select
            value={visibility}
            onValueChange={(v) => void choose(v as VisibilityPickerValue)}
            disabled={saving}
          >
            <SelectTrigger className="h-8 w-[150px]" aria-label="Nest visibility">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {options
        .filter((o) => o.disabled)
        .map((o) => (
          <p key={o.value} className="text-xs text-muted-foreground">
            {o.hint} Ask a server admin to change it.
          </p>
        ))}

      {/* CU-wdqcq05rz6: only meaningful on an org nest, and only an owner or
          admin may change it (the server enforces both). */}
      {isOrg && serverVisibility === "org" && canManageSettings && (
        <OrgContributionsSetting nestId={nestId} onError={onError} />
      )}

      {confirmDialog}
    </div>
  );
}
