/**
 * NestSettingsModal — per-nest admin settings (stewardship toggle, etc.)
 */
import { useEffect, useState } from "react";
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
  UserPen,
  Star,
  ShieldCheck,
  Clock,
  Eye,
  SlidersHorizontal,
  ChevronRight,
  Megaphone,
} from "lucide-react";
import * as api from "../lib/api";
import { SystemsPanel } from "./nest/SystemsPanel";

interface NestSettingsModalProps {
  nestId: string;
  nestName: string;
  stewardshipEnabled: boolean;
  allowSelfApprove: boolean;
  primeOnlyReview: boolean;
  primeTags: string[];
  /** Tags whose documents are pushed to every agent (always-include). */
  alwaysIncludeTags?: string[];
  /** Push Confirmation Gate (superadmin-set). */
  requirePushConfirmation: boolean;
  /** True only for a server superadmin — gates the push-confirmation switch. */
  isServerAdmin: boolean;
  creatorIsReviewer: boolean;
  /** Review SLA in hours; null = off. */
  reviewSlaHours: number | null;
  /** Reads, pulls and exports go to the activity log (default on). */
  accessLogEnabled?: boolean;
  /** Owner or server admin — the only callers who may turn the log OFF. */
  canDisableAccessLog?: boolean;
  /** False hides the stewardship section. Server still enforces. */
  canManageStewardship: boolean;
  onClose: () => void;
  /** Jump to the nest's Fields tab (custom field definitions). */
  onManageFields?: () => void;
  onChanged: (next: {
    stewardshipEnabled: boolean;
    allowSelfApprove: boolean;
    primeOnlyReview: boolean;
    primeTags: string[];
    alwaysIncludeTags: string[];
    requirePushConfirmation: boolean;
    creatorIsReviewer: boolean;
    reviewSlaHours: number | null;
    accessLogEnabled: boolean;
  }) => void;
}

export function NestSettingsModal({
  nestId,
  nestName,
  stewardshipEnabled,
  allowSelfApprove,
  primeOnlyReview,
  primeTags,
  alwaysIncludeTags = ["always-include"],
  requirePushConfirmation,
  isServerAdmin,
  creatorIsReviewer,
  reviewSlaHours,
  accessLogEnabled = true,
  canDisableAccessLog = false,
  canManageStewardship,
  onClose,
  onManageFields,
  onChanged,
}: NestSettingsModalProps) {
  const [enabled, setEnabled] = useState(stewardshipEnabled);
  const [selfApprove, setSelfApprove] = useState(allowSelfApprove);
  const [primeOnly, setPrimeOnly] = useState(primeOnlyReview);
  const [pushConfirm, setPushConfirm] = useState(requirePushConfirmation);
  const [primeTagText, setPrimeTagText] = useState(primeTags.join(", "));
  const [alwaysIncludeText, setAlwaysIncludeText] = useState(alwaysIncludeTags.join(", "));
  const [creatorReviews, setCreatorReviews] = useState(creatorIsReviewer);
  // Text, not a number: an empty box means "off", and the field must allow
  // the transient empty state while someone retypes it.
  const [slaText, setSlaText] = useState(
    reviewSlaHours ? String(reviewSlaHours) : "",
  );
  const [accessLog, setAccessLog] = useState(accessLogEnabled);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Shown under the SLA field: it's the last control, so the top banner is off-screen.
  const [slaError, setSlaError] = useState<string | null>(null);
  // Acknowledgement required only when the caller is turning stewardship
  // OFF (was on, now off). Toggling on, or no change, doesn't need it.
  const [disableAcknowledged, setDisableAcknowledged] = useState(false);
  const turningStewardshipOff = stewardshipEnabled && !enabled;

  // Push allowlist — loaded once when the section is visible. Reviewer-only on
  // the server; a 403 for a plain editor just leaves the list empty.
  const [allowlist, setAllowlist] = useState<api.PushAllowlistEntry[]>([]);
  const [allowlistLoading, setAllowlistLoading] = useState(false);
  const [allowlistError, setAllowlistError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    if (!canManageStewardship) return;
    let cancelled = false;
    setAllowlistLoading(true);
    api
      .getPushAllowlist(nestId)
      .then((res) => {
        if (!cancelled) setAllowlist(res.allowlist);
      })
      .catch(() => {
        // Not a reviewer, or the governance license lapsed — show nothing
        // rather than an error the caller can do anything about.
        if (!cancelled) setAllowlist([]);
      })
      .finally(() => {
        if (!cancelled) setAllowlistLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nestId, canManageStewardship]);

  async function handleRevoke(entry: api.PushAllowlistEntry) {
    const rowKey = `${entry.user_id}:${entry.key_id ?? "*"}`;
    setRevoking(rowKey);
    setAllowlistError(null);
    try {
      await api.removeFromAllowlist(nestId, entry.user_id, entry.key_id);
      setAllowlist((prev) =>
        prev.filter(
          (a) => `${a.user_id}:${a.key_id ?? "*"}` !== rowKey,
        ),
      );
    } catch (err) {
      setAllowlistError(
        err instanceof Error ? err.message : "Could not revoke this key",
      );
    } finally {
      setRevoking(null);
    }
  }

  // The owner/admin bypass is unreachable while prime-only review is on: the
  // gate self-publishes every non-prime doc before it ever consults
  // allow_self_approve, and prime docs ignore the bypass by design.
  const selfApproveMoot = enabled && primeOnly;

  // Normalized the same way the server does, so the dirty check below doesn't
  // fire on cosmetic differences ("#Prime, " vs "prime").
  const tagList = (text: string) => [
    ...new Set(
      text
        .split(",")
        .map((t) => t.trim().replace(/^#+/, "").toLowerCase())
        .filter(Boolean),
    ),
  ];
  const nextPrimeTags = tagList(primeTagText);
  const nextAlwaysIncludeTags = tagList(alwaysIncludeText);

  const handleSave = async () => {
    const stewardshipChanged = enabled !== stewardshipEnabled;
    const selfApproveChanged = selfApprove !== allowSelfApprove;
    const primeOnlyChanged = primeOnly !== primeOnlyReview;
    const primeTagsChanged =
      nextPrimeTags.join(",") !== primeTags.join(",");
    const alwaysIncludeTagsChanged =
      nextAlwaysIncludeTags.join(",") !== alwaysIncludeTags.join(",");
    // Only a superadmin may change this; never send it otherwise (a per-field
    // 403 would otherwise reject the whole PATCH for a non-superadmin).
    const pushConfirmChanged =
      isServerAdmin && pushConfirm !== requirePushConfirmation;
    const creatorReviewsChanged = creatorReviews !== creatorIsReviewer;
    const slaTrimmed = slaText.trim();
    const nextSla = slaTrimmed === "" || slaTrimmed === "0" ? null : Number(slaTrimmed);
    if (
      nextSla !== null &&
      (!Number.isInteger(nextSla) || nextSla < 1 || nextSla > 8760)
    ) {
      setSlaError("Review SLA must be a whole number of hours (1–8760), or empty for off.");
      return;
    }
    const slaChanged = nextSla !== (reviewSlaHours ?? null);
    const accessLogChanged = accessLog !== accessLogEnabled;
    if (
      !stewardshipChanged &&
      !selfApproveChanged &&
      !primeOnlyChanged &&
      !primeTagsChanged &&
      !alwaysIncludeTagsChanged &&
      !pushConfirmChanged &&
      !creatorReviewsChanged &&
      !slaChanged &&
      !accessLogChanged
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
        ...(alwaysIncludeTagsChanged ? { always_include_tags: nextAlwaysIncludeTags } : {}),
        ...(pushConfirmChanged ? { require_push_confirmation: pushConfirm } : {}),
        ...(creatorReviewsChanged ? { creator_is_reviewer: creatorReviews } : {}),
        ...(slaChanged ? { review_sla_hours: nextSla } : {}),
        ...(accessLogChanged ? { access_log_enabled: accessLog } : {}),
      });
      // Trust the server's response, not our optimistic local state, in
      // case the permission check rejected silently or the DB rejected.
      if (
        result.stewardship_enabled !== enabled ||
        result.allow_self_approve !== selfApprove ||
        result.prime_only_review !== primeOnly ||
        (pushConfirmChanged && result.require_push_confirmation !== pushConfirm) ||
        result.creator_is_reviewer !== creatorReviews ||
        (slaChanged && (result.review_sla_hours ?? null) !== nextSla) ||
        (accessLogChanged && result.access_log_enabled !== accessLog)
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
        alwaysIncludeTags: result.always_include_tags ?? nextAlwaysIncludeTags,
        requirePushConfirmation: result.require_push_confirmation,
        creatorIsReviewer: result.creator_is_reviewer,
        reviewSlaHours: result.review_sla_hours ?? null,
        accessLogEnabled: result.access_log_enabled ?? accessLog,
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

          {/* Custom fields live on their own tab (a list with CRUD doesn't
              fit this form); this row is the way there from settings. */}
          {onManageFields && (
            <button
              type="button"
              onClick={onManageFields}
              className="flex w-full items-center justify-between gap-4 rounded-lg border p-4 text-left hover:bg-muted/40"
              data-testid="settings-manage-fields"
            >
              <span className="space-y-1">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <SlidersHorizontal className="h-4 w-4" />
                  Custom fields
                </span>
                <span className="block text-xs text-muted-foreground">
                  Define fields like Severity, Estimate or Time in status for this
                  nest's tasks.
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
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

          {/* Always include — any nest, governed or not: what every agent is
              told when it connects (CU-wdqcq05rn0). */}
          {canManageStewardship && (
          <div className="rounded-lg border p-4 space-y-1">
            <Label className="flex items-center gap-2 text-sm font-medium">
              <Megaphone className="h-4 w-4" />
              Always-include tags
            </Label>
            <Input
              value={alwaysIncludeText}
              onChange={(e) => setAlwaysIncludeText(e.target.value)}
              placeholder="always-include"
              data-testid="nest-settings-always-include-tags"
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated. The approved text of any document carrying one
              of these tags, with the nest instructions, goes to every agent
              and model that works in this nest — MCP connections, Hootie,
              agents and workflow runs. They are also prime: with stewardship
              on, a change to them needs steward approval. A single document
              can also be switched on or off from its editor.
            </p>
          </div>
          )}

          {/* Creator reviews — only meaningful once stewardship is on. */}
          {canManageStewardship && enabled && (
          <div className="rounded-lg border p-4 space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label className="flex items-center gap-2 text-sm font-medium">
                  <UserPen className="h-4 w-4" />
                  Creators review their own documents
                </Label>
                <p className="text-xs text-muted-foreground">
                  Default off. When enabled, whoever creates a document becomes
                  its <strong>reviewer</strong> and the first version publishes
                  right away. Changes by anyone else go to the creator for
                  approval; the creator&rsquo;s own later edits go to the
                  nest&rsquo;s other reviewers. Applies to documents created
                  from now on — existing documents keep their stewards.
                </p>
              </div>
              <Switch checked={creatorReviews} onCheckedChange={setCreatorReviews} />
            </div>

            <div className="flex items-start gap-2 text-xs text-muted-foreground pt-2 border-t">
              <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
              <div>
                <strong className="text-foreground">Prime wins.</strong> A
                prime document still starts as a draft — its creator is made
                its reviewer, but someone else has to approve the first
                version.
              </div>
            </div>
          </div>
          )}

          {/* Review SLA — only meaningful once stewardship is on. */}
          {canManageStewardship && enabled && (
          <div className="rounded-lg border p-4 space-y-3">
            <div className="space-y-1">
              <Label className="flex items-center gap-2 text-sm font-medium">
                <Clock className="h-4 w-4" />
                Review SLA (hours)
              </Label>
              <p className="text-xs text-muted-foreground">
                Default off. When set, a review left pending this long is
                escalated one rung — to the document&rsquo;s tag reviewers,
                then the nest&rsquo;s reviewers, then the nest owner — and
                each rung gets the same window before the next. Escalation
                only notifies; it never changes who can approve.
              </p>
            </div>
            <Input
              type="number"
              min={1}
              max={8760}
              step={1}
              value={slaText}
              onChange={(e) => {
                setSlaText(e.target.value);
                setSlaError(null);
              }}
              placeholder="Off"
              className="w-32"
              aria-invalid={slaError !== null}
              aria-describedby={slaError ? "review-sla-error" : undefined}
            />
            {slaError && (
              <p id="review-sla-error" role="alert" className="text-xs text-destructive">
                {slaError}
              </p>
            )}
          </div>
          )}
          {/* Read log — the record of what each person and agent read. Any
              nest admin may turn it on; only the owner (or server admin)
              may turn it off. The server enforces the same rule. */}
          {canManageStewardship && (
          <div className="rounded-lg border p-4 space-y-3" data-testid="access-log-setting">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label className="flex items-center gap-2 text-sm font-medium">
                  <Eye className="h-4 w-4" />
                  Record what people and agents read
                </Label>
                <p className="text-xs text-muted-foreground">
                  Default on. Every read, search hit, and export of a document
                  is kept in its Activity log — who, which agent, which
                  version, and when. Only document ids and versions are
                  stored, never content or what was searched. Kept for the
                  activity-trace retention window.{" "}
                  <strong>Only the owner can turn this off.</strong>
                </p>
              </div>
              <span
                title={
                  accessLog && !canDisableAccessLog
                    ? "Only the nest owner or a server admin can turn this off."
                    : undefined
                }
              >
                <Switch
                  checked={accessLog}
                  onCheckedChange={setAccessLog}
                  disabled={accessLog && !canDisableAccessLog && accessLogEnabled}
                />
              </span>
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
                  Require confirmation for agent writes
                </Label>
                <p className="text-xs text-muted-foreground">
                  Default off. When on, a document created by an agent or
                  script — through an MCP tool, the API, or a bulk push — is
                  held pending review instead of applying, and lands only after
                  a reviewer confirms it here. Your own work in this app is
                  never held. Whitelisted keys (via &ldquo;Always allow&rdquo;
                  when confirming) skip the gate.{" "}
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

            {/* Whitelisted keys. "Always allow" is otherwise a one-way door:
                the only way back is here. Shown whenever entries exist, even
                with the gate off — a whitelist that outlives the gate being
                turned off and on again is exactly what needs auditing. */}
            <div className="pt-3 border-t space-y-2">
              <div className="text-xs font-medium">
                Keys that skip the gate
                {allowlist.length > 0 ? ` (${allowlist.length})` : ""}
              </div>
              {allowlistError && (
                <p className="text-xs text-destructive">{allowlistError}</p>
              )}
              {allowlistLoading ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : allowlist.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  None. A reviewer adds one with &ldquo;Always allow&rdquo; when
                  confirming a held push.
                </p>
              ) : (
                <div className="rounded-md border divide-y">
                  {allowlist.map((a) => (
                    <div
                      key={`${a.user_id}:${a.key_id ?? "*"}`}
                      className="p-2 flex items-center justify-between gap-3"
                    >
                      <div className="min-w-0 text-xs">
                        <div className="truncate font-medium">
                          {a.user_email || a.user_id}
                        </div>
                        <div className="truncate text-muted-foreground">
                          {a.key_id
                            ? `key: ${a.key_label || a.key_id}`
                            : "all of this user's keys"}
                          {" · "}
                          {new Date(a.created_at).toLocaleDateString()}
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={revoking === `${a.user_id}:${a.key_id ?? "*"}`}
                        onClick={() => handleRevoke(a)}
                      >
                        {revoking === `${a.user_id}:${a.key_id ?? "*"}`
                          ? "Revoking…"
                          : "Revoke"}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          )}

          {/* Acts on its own (each change saves immediately), not via Save. */}
          {canManageStewardship && <SystemsPanel nestId={nestId} />}
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
