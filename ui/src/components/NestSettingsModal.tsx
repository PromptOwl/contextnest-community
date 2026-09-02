/**
 * NestSettingsModal — per-nest admin settings (stewardship toggle, etc.)
 */
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Shield,
  AlertCircle,
  AlertTriangle,
  Loader2,
  Info,
  UserCheck,
  Star,
  ShieldCheck,
} from "lucide-react";
import * as api from "../lib/api";

interface NestSettingsModalProps {
  nestId: string;
  nestName: string;
  stewardshipEnabled: boolean;
  allowSelfApprove: boolean;
  primeOnlyReview: boolean;
  primeTags: string[];
  /** Push Confirmation Gate (superadmin-set). */
  requirePushConfirmation: boolean;
  /** True only for a server superadmin — gates the push-confirmation switch. */
  isServerAdmin: boolean;
  /** False hides the stewardship section. Server still enforces. */
  canManageStewardship: boolean;
  onClose: () => void;
  onChanged: (next: {
    stewardshipEnabled: boolean;
    allowSelfApprove: boolean;
    primeOnlyReview: boolean;
    primeTags: string[];
    requirePushConfirmation: boolean;
  }) => void;
}

export function NestSettingsModal({
  nestId,
  nestName,
  stewardshipEnabled,
  allowSelfApprove,
  primeOnlyReview,
  primeTags,
  requirePushConfirmation,
  isServerAdmin,
  canManageStewardship,
  onClose,
  onChanged,
}: NestSettingsModalProps) {
  const [enabled, setEnabled] = useState(stewardshipEnabled);
  const [selfApprove, setSelfApprove] = useState(allowSelfApprove);
  const [primeOnly, setPrimeOnly] = useState(primeOnlyReview);
  const [pushConfirm, setPushConfirm] = useState(requirePushConfirmation);
  const [primeTagText, setPrimeTagText] = useState(primeTags.join(", "));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Acknowledgement required only when the caller is turning stewardship
  // OFF (was on, now off). Toggling on, or no change, doesn't need it.
  const [disableAcknowledged, setDisableAcknowledged] = useState(false);
  const turningStewardshipOff = stewardshipEnabled && !enabled;

  // The owner/admin bypass is unreachable while prime-only review is on: the
  // gate self-publishes every non-prime doc before it ever consults
  // allow_self_approve, and prime docs ignore the bypass by design.
  const selfApproveMoot = enabled && primeOnly;

  // Normalized the same way the server does, so the dirty check below doesn't
  // fire on cosmetic differences ("#Prime, " vs "prime").
  const nextPrimeTags = [
    ...new Set(
      primeTagText
        .split(",")
        .map((t) => t.trim().replace(/^#+/, "").toLowerCase())
        .filter(Boolean),
    ),
  ];

  const handleSave = async () => {
    const stewardshipChanged = enabled !== stewardshipEnabled;
    const selfApproveChanged = selfApprove !== allowSelfApprove;
    const primeOnlyChanged = primeOnly !== primeOnlyReview;
    const primeTagsChanged =
      nextPrimeTags.join(",") !== primeTags.join(",");
    // Only a superadmin may change this; never send it otherwise (a per-field
    // 403 would otherwise reject the whole PATCH for a non-superadmin).
    const pushConfirmChanged =
      isServerAdmin && pushConfirm !== requirePushConfirmation;
    if (
      !stewardshipChanged &&
      !selfApproveChanged &&
      !primeOnlyChanged &&
      !primeTagsChanged &&
      !pushConfirmChanged
    ) {
      onClose();
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.updateNestSettings(nestId, {
        ...(stewardshipChanged ? { stewardship_enabled: enabled } : {}),
        ...(selfApproveChanged ? { allow_self_approve: selfApprove } : {}),
        ...(primeOnlyChanged ? { prime_only_review: primeOnly } : {}),
        ...(primeTagsChanged ? { prime_tags: nextPrimeTags } : {}),
        ...(pushConfirmChanged
          ? { require_push_confirmation: pushConfirm }
          : {}),
      });
      // Trust the server's response, not our optimistic local state, in
      // case the permission check rejected silently or the DB rejected.
      if (
        result.stewardship_enabled !== enabled ||
        result.allow_self_approve !== selfApprove ||
        result.prime_only_review !== primeOnly ||
        (pushConfirmChanged && result.require_push_confirmation !== pushConfirm)
      ) {
        setError(
          "Server did not accept the change. You may not have permission to change these settings.",
        );
        setLoading(false);
        return;
      }
      // Hand the accepted values back so the parent can flip the governance
      // UI immediately (optimistic) instead of waiting on a full refetch.
      onChanged({
        stewardshipEnabled: result.stewardship_enabled,
        allowSelfApprove: result.allow_self_approve,
        primeOnlyReview: result.prime_only_review,
        primeTags: result.prime_tags,
        requirePushConfirmation: result.require_push_confirmation,
      });
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      {/* Capped height + scrolling body: the prime section pushed this dialog
          past the viewport on short screens, taking the header and the
          Save/Cancel footer off-screen with it. */}
      <DialogContent className="sm:max-w-[500px] flex flex-col max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>Settings: {nestName}</DialogTitle>
          <DialogDescription>
            Admin controls for this nest. Changes apply to all future documents.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 flex-1 min-h-0 overflow-y-auto pr-1">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {/* Stewardship — manage-rights only. */}
          {canManageStewardship && (
          <div className="rounded-lg border p-4 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label className="flex items-center gap-2 text-sm font-medium">
                  <Shield className="h-4 w-4" />
                  Stewardship & Approval Workflow
                </Label>
                <p className="text-xs text-muted-foreground">
                  Require steward approval before documents become AI-ready.
                  New documents will start as <strong>drafts</strong>. This also
                  changes what &ldquo;publishing&rdquo; means in this nest:
                  with stewardship on, the document editor shows
                  <em> Publish (requires approval)</em>; with it off,
                  saving auto-publishes and an <em>Auto-published</em> badge
                  appears next to the title.
                </p>
              </div>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>

            {!enabled && !turningStewardshipOff && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground pt-2 border-t">
                <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <div>
                  <strong className="text-foreground">Currently off.</strong> New documents
                  are auto-approved and immediately available to AI. Versioning is
                  still on — every edit creates a new version.
                </div>
              </div>
            )}

            {turningStewardshipOff && (
              <Alert variant="destructive" className="pt-2">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="space-y-2">
                  <div>
                    <strong>Disabling stewardship removes governance.</strong>{" "}
                    All steward assignments and pending review requests for this
                    nest will be deleted, and new documents become auto-approved.
                    Collaborator access is kept — manage it from Share.
                    Approved/rejected review history is kept.
                  </div>
                  <label className="flex items-center gap-2 text-xs font-medium cursor-pointer">
                    <input
                      type="checkbox"
                      checked={disableAcknowledged}
                      onChange={(e) =>
                        setDisableAcknowledged(e.target.checked)
                      }
                      className="h-3.5 w-3.5"
                    />
                    I understand this will remove all stewards.
                  </label>
                </AlertDescription>
              </Alert>
            )}

            {enabled && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground pt-2 border-t">
                <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <div>
                  <strong className="text-foreground">When enabled:</strong> New
                  documents start as drafts. Assigned stewards must approve before
                  they're available to AI queries. Existing approved documents stay
                  approved.
                </div>
              </div>
            )}
          </div>
          )}

          {/* Self-approve bypass — manage-rights only. */}
          {canManageStewardship && (
          <div className="rounded-lg border p-4 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label className="flex items-center gap-2 text-sm font-medium">
                  <UserCheck className="h-4 w-4" />
                  Auto-publish owner &amp; admin edits
                </Label>
                <p className="text-xs text-muted-foreground">
                  Default off. When enabled, edits by an owner or admin publish
                  immediately — their changes skip the review queue instead of
                  waiting for approval. Editors and reviewers are unaffected: they
                  still submit drafts for review as usual. Turning this back off
                  only changes future behavior; it doesn't unpublish anything.
                  Audit logs still record every actor.
                </p>
              </div>
              <Switch
                checked={selfApprove}
                onCheckedChange={setSelfApprove}
                disabled={selfApproveMoot}
              />
            </div>

            {/* Prime-only review self-publishes for EVERYONE, so the
                owner/admin bypass never gets consulted — say so rather than
                leaving a live switch that changes nothing. */}
            {selfApproveMoot && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground pt-2 border-t">
                <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <div>
                  <strong className="text-foreground">No effect right now.</strong>{" "}
                  &ldquo;Review prime documents only&rdquo; is on, so every
                  non-prime document already self-publishes for everyone — and
                  prime documents always need approval, including from owners
                  and admins. Turn prime-only review off to use this bypass.
                </div>
              </div>
            )}

            {enabled && !selfApproveMoot && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground pt-2 border-t">
                <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <div>
                  <strong className="text-foreground">Prime wins.</strong> A
                  document flagged prime (or carrying a prime tag) always goes
                  through review, even for an owner or admin with this on.
                </div>
              </div>
            )}
          </div>
          )}

          {/* Prime documents — only meaningful once stewardship is on. */}
          {canManageStewardship && enabled && (
          <div className="rounded-lg border p-4 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label className="flex items-center gap-2 text-sm font-medium">
                  <Star className="h-4 w-4" />
                  Review prime documents only
                </Label>
                <p className="text-xs text-muted-foreground">
                  Default off. When enabled, day-to-day content self-publishes
                  and only <strong>prime</strong> documents go through
                  draft &rarr; pending &rarr; approved. Prime always wins: a
                  prime document needs approval even from an owner or admin with
                  auto-publish on, and turning this on makes the auto-publish
                  bypass above redundant.
                </p>
              </div>
              <Switch checked={primeOnly} onCheckedChange={setPrimeOnly} />
            </div>

            <div className="space-y-1 pt-2 border-t">
              <Label className="text-xs font-medium">Prime tags</Label>
              <Input
                value={primeTagText}
                onChange={(e) => setPrimeTagText(e.target.value)}
                placeholder="prime-document, messaging-architecture"
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated. Any document carrying one of these tags is
                prime. A single document can also be flagged directly from its
                editor, which overrides its tags.
              </p>
            </div>
          </div>
          )}

          {/* Push Confirmation Gate — SERVER superadmin only. Rendered for
              everyone who can manage the nest so the posture is visible, but
              the switch is enabled only for a superadmin; others see it
              read-only with a tooltip. The server enforces a per-field 403. */}
          {canManageStewardship && (
          <div className="rounded-lg border p-4 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label className="flex items-center gap-2 text-sm font-medium">
                  <ShieldCheck className="h-4 w-4" />
                  Require confirmation for pushes (ctx push)
                </Label>
                <p className="text-xs text-muted-foreground">
                  Default off. When on, a <code>ctx push</code> to this nest is
                  held pending review instead of applying — it lands only after
                  a reviewer confirms it here. Whitelisted keys (via
                  &ldquo;Always allow&rdquo; on the confirm modal) skip the gate.
                  {" "}
                  <strong>Superadmin only.</strong>
                </p>
              </div>
              <span
                title={
                  isServerAdmin
                    ? undefined
                    : "Only a server superadmin can change this."
                }
              >
                <Switch
                  checked={pushConfirm}
                  onCheckedChange={setPushConfirm}
                  disabled={!isServerAdmin}
                />
              </span>
            </div>
            {!isServerAdmin && (
              <div className="flex items-start gap-2 text-xs text-muted-foreground pt-2 border-t">
                <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <div>
                  This is a server-wide governance control. Ask a superadmin to
                  change it.
                </div>
              </div>
            )}
          </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={loading || (turningStewardshipOff && !disableAcknowledged)}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              "Save Settings"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
