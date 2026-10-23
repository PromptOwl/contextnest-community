import { useState } from "react";
import { ExternalLink, Info, KeyRound, Loader2, Mail } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { installLicense } from "../../../lib/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LicenseNoticeCard, useAdminLicense } from "../../../components/LicenseNotice";
import { adminLicenseNotice, safeContact } from "../../../lib/license-messages";

const TIER_LABELS: Record<string, string> = {
  community: "Community",
  team: "Team",
  enterprise: "Enterprise",
};

function tierLabel(tier: string, trial: boolean | undefined): string {
  const name = TIER_LABELS[tier] ?? (tier ? tier[0].toUpperCase() + tier.slice(1) : "None");
  return trial ? `${name} (trial)` : name;
}

/** Pricing plan names (spec v21 §1); the tier label is the fallback for an older PromptOwl. */
const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  trial: "Trial",
  self_hosted: "Self-Hosted",
  enterprise: "Enterprise",
};

/** "3 of 10", "3 (unlimited)", or "None on this plan" for a 0 cap. */
function capLabel(used: number, cap: number | null | undefined): string {
  if (cap == null) return `${used} (unlimited)`;
  if (cap === 0 && used === 0) return "None on this plan";
  return `${used} of ${cap}`;
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** A label with an (i) that explains how the number beside it is counted. */
function Counted({ label, help }: { label: string; help: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`How ${label.toLowerCase()} are counted`}
            className="text-muted-foreground hover:text-foreground"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs leading-relaxed">{help}</TooltipContent>
      </Tooltip>
    </span>
  );
}

/** "6 people count as users of 5 on this plan." */
function countLine(n: number, what: string, cap: number | null | undefined): string {
  const who = n === 1 ? "1 person counts" : `${n} people count`;
  return `${who} as ${what}${cap != null ? ` of ${cap} on this plan` : ""}.`;
}

function Row({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

/**
 * Settings → License. What this server is licensed for and how it stands
 * against that, with one way to change any of it: talk to PromptOwl. Licenses
 * are sales-led, so there is nothing to buy here, only someone to reach.
 */
/** Replace this server's key in place — e.g. after PromptOwl issues a new one. */
function ReplaceKey({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <KeyRound className="h-4 w-4 mr-1.5" /> Install a new key
      </Button>
    );
  }
  const submit = async () => {
    const k = key.trim();
    if (!k.startsWith("pk_")) return setError("License key must start with pk_");
    setBusy(true);
    setError(null);
    try {
      const res = await installLicense(k);
      if (!res.valid) return setError(res.error || "PromptOwl rejected this key.");
      if (res.warning) setError(res.warning);
      setKey("");
      setOpen(false);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to install key");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="w-full space-y-2">
      <div className="flex gap-2">
        <Input
          className="font-mono"
          placeholder="pk_..."
          value={key}
          autoFocus
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && submit()}
        />
        <Button onClick={submit} disabled={busy || !key.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Install"}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export function LicensePanel() {
  const { lic, refresh } = useAdminLicense(true, 60 * 1000);
  if (!lic) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-10">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading license…
      </div>
    );
  }
  const notice = adminLicenseNotice(lic);
  const contact = safeContact(lic.contact);
  const { licensed, used } = lic.seats;
  return (
    <div className="space-y-4">
      {notice && <LicenseNoticeCard notice={notice} />}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" /> License
          </CardTitle>
          <CardDescription>
            This server's PromptOwl license. It is checked with PromptOwl every
            minute, and each check reports how many people are on this server.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TooltipProvider>
          <dl className="text-sm">
            <Row label="Plan">
              {lic.plan ? PLAN_LABELS[lic.plan] ?? lic.plan : tierLabel(lic.tier, lic.trial)}
            </Row>
            {lic.org && <Row label="Licensed to">{lic.org}</Row>}
            {lic.owner_email && <Row label="License admin">{lic.owner_email}</Row>}
            {/* Each person counts once, at their highest role on any nest. */}
            <Row
              label={
                <Counted
                  label="Users"
                  help={`${countLine(used, "users", licensed)} Each person counts once, at their highest role on any nest. Users are the license admin, superadmins, nest owners, and anyone who is an admin or reviewer on a nest. Invited people with no role and viewers are free and don't count. Over the limit nobody loses access; only making someone a user is blocked.`}
                />
              }
            >
              {capLabel(used, licensed)}
            </Row>
            {lic.subscribers && (
              <Row
                label={
                  <Counted
                    label="Editors"
                    help={`${countLine(lic.subscribers.used, "editors", lic.subscribers.licensed)} Editors are people whose highest role is editor: they can write but not approve. Someone who is also an admin or reviewer anywhere counts as a user instead. Viewers are free.${lic.subscribers.licensed === 0 ? " On this plan, adding an editor needs an upgrade." : ""}`}
                  />
                }
              >
                {capLabel(lic.subscribers.used, lic.subscribers.licensed)}
              </Row>
            )}
            {lic.max_account_owners !== undefined && (
              <Row label="Account Owners">
                {lic.max_account_owners == null ? "Unlimited" : `Up to ${lic.max_account_owners}`}
              </Row>
            )}
            <Row label={lic.trial ? "Trial ends" : "License ends"}>
              {lic.expires_at
                ? `${fmt(lic.expires_at)}${
                    lic.days_left != null && lic.days_left >= 0
                      ? ` (${lic.days_left} ${lic.days_left === 1 ? "day" : "days"} left)`
                      : ""
                  }`
                : "No end date"}
            </Row>
            {lic.grace_ends_at && (
              <Row label="Keeps working until">{fmt(lic.grace_ends_at)}</Row>
            )}
            <Row label="Own model keys or LLM gateway">
              <span data-testid="license-byok">{lic.byok ? "On" : "Off"}</span>
            </Row>
            <Row label="Status">
              {!lic.valid
                ? "Read-only until the license is restored"
                : lic.suspended
                  ? "Editing paused (reads work)"
                  : lic.pending_rejections > 0
                    ? `Not confirmed by PromptOwl (${lic.pending_rejections} of 3 checks)`
                    : lic.reason === "expired_grace"
                      ? "Active (grace period)"
                      : "Active"}
            </Row>
            <Row label="Last checked with PromptOwl">{fmt(lic.last_checked_at)}</Row>
          </dl>
          </TooltipProvider>
          <div className="pt-4">
            <ReplaceKey onDone={refresh} />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add seats, renew, or change plans</CardTitle>
          <CardDescription>
            Licenses are arranged with the PromptOwl team: more seats, moving
            from a trial to a paid license, Enterprise features such as SSO,
            HIPAA or your own model keys, or anything about your terms.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          {lic.manage_url && (
            <Button asChild>
              <a href={lic.manage_url} target="_blank" rel="noreferrer">
                Manage plan <ExternalLink className="h-4 w-4 ml-1.5" />
              </a>
            </Button>
          )}
          <Button asChild variant={lic.manage_url ? "outline" : "default"}>
            <a href={contact.url} target="_blank" rel="noreferrer">
              Talk to PromptOwl <ExternalLink className="h-4 w-4 ml-1.5" />
            </a>
          </Button>
          <a
            href={`mailto:${contact.email}`}
            className="inline-flex items-center gap-1.5 text-sm underline"
          >
            <Mail className="h-4 w-4" /> {contact.email}
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
