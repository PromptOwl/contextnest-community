import { useCallback, useEffect, useState } from "react";
import { CalendarClock, ExternalLink, Info, KeyRound, Mail, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { getAdminLicense, type AdminLicense, type LicenseStatus } from "../lib/api";
import {
  adminLicenseNotice,
  DISMISS_DAYS,
  isDismissed,
  neutralReadOnlyNotice,
  type LicenseNotice,
  type NoticeLevel,
} from "../lib/license-messages";

// Friendly, never alarming: no red. Warnings are amber, everything else calm.
const LEVEL_STYLES: Record<NoticeLevel, string> = {
  info: "border-primary/30 bg-primary/5 text-foreground",
  warning:
    "border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100",
};

/** A license notice with its "Talk to PromptOwl" actions (admins only). */
export function LicenseNoticeCard({
  notice,
  onDismiss,
  onInstallKey,
  className = "",
  compact = false,
}: {
  notice: LicenseNotice;
  onDismiss?: () => void;
  onInstallKey?: () => void;
  className?: string;
  /** One line — title, CTA link, dismiss — for content-heavy pages. */
  compact?: boolean;
}) {
  const Icon = notice.cta ? CalendarClock : Info;
  const dismiss = onDismiss && (
    <button
      type="button"
      onClick={onDismiss}
      aria-label={`Dismiss for ${DISMISS_DAYS} days`}
      title={`Hide for ${DISMISS_DAYS} days`}
      className="opacity-60 hover:opacity-100"
    >
      <X className="h-4 w-4" />
    </button>
  );
  if (compact) {
    return (
      <div
        role="status"
        data-testid="license-notice"
        className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs ${LEVEL_STYLES[notice.level]} ${className}`}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium">{notice.title}</span>
        {notice.cta && (
          <a href={notice.contact.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 underline">
            {notice.cta}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {dismiss}
      </div>
    );
  }
  return (
    <div
      role="status"
      data-testid="license-notice"
      className={`rounded-md border px-4 py-3 text-sm ${LEVEL_STYLES[notice.level]} ${className}`}
    >
      <div className="flex items-start gap-3">
        <Icon className="h-4 w-4 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0 space-y-1">
          <p className="font-medium">{notice.title}</p>
          {notice.body && <p className="opacity-90">{notice.body}</p>}
          {(notice.cta || (notice.offerInstall && onInstallKey)) && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {notice.cta && (
                <Button size="sm" asChild>
                  <a href={notice.contact.url} target="_blank" rel="noreferrer">
                    {notice.cta}
                    <ExternalLink className="h-3.5 w-3.5 ml-1.5" />
                  </a>
                </Button>
              )}
              {notice.offerInstall && onInstallKey && (
                <Button size="sm" variant="outline" onClick={onInstallKey}>
                  <KeyRound className="h-3.5 w-3.5 mr-1.5" />
                  Install a new key
                </Button>
              )}
              {notice.cta && (
                <a
                  href={`mailto:${notice.contact.email}`}
                  className="inline-flex items-center gap-1 text-xs underline opacity-80 hover:opacity-100"
                >
                  <Mail className="h-3 w-3" />
                  {notice.contact.email}
                </a>
              )}
            </div>
          )}
        </div>
        {dismiss}
      </div>
    </div>
  );
}

/** License detail for people who can act on it; null for everyone else (the
 *  endpoint answers 403) and while loading. */
export function useAdminLicense(enabled: boolean, refreshMs = 5 * 60 * 1000) {
  const [lic, setLic] = useState<AdminLicense | null>(null);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      setLic(await getAdminLicense());
    } catch {
      setLic(null);
    }
  }, [enabled]);
  useEffect(() => {
    refresh();
    if (!enabled) return;
    const t = setInterval(refresh, refreshMs);
    return () => clearInterval(t);
  }, [enabled, refresh, refreshMs]);
  return { lic, refresh };
}

const DISMISS_KEY = "cn-license-notice-dismissed";

function readDismissal(): { id: string; at: number } | null {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * App-wide license notice.
 *
 * Server admins and the key's owner see the specifics (trial days left, end of
 * a grace period, seats, a lapsed key) with a way to talk to PromptOwl. Anyone
 * else sees nothing at all — until the workspace actually becomes read-only,
 * and then only the neutral line. Admin notices can be hidden for
 * DISMISS_DAYS, except in the last few days before something changes.
 */
export function LicenseBanner({
  isAdmin,
  status,
  onInstallKey,
  className = "mb-4",
  compact = false,
}: {
  isAdmin: boolean;
  status: LicenseStatus | null;
  onInstallKey?: () => void;
  /** Spacing around the card; the shell passes its own where <main> has no padding. */
  className?: string;
  /** Nest and document pages: a dismissible (not yet urgent) notice shrinks to one line. */
  compact?: boolean;
}) {
  const readOnly = !!status && (!status.valid || status.suspended);
  // Probe the admin endpoint for admins, and — since a lapsed license stops
  // making its owner an admin — for anyone while the workspace is read-only.
  const { lic } = useAdminLicense(isAdmin || readOnly);
  const [dismissed, setDismissed] = useState(readDismissal);

  // A role grant hit the plan's limit (lib/api dispatches it). The dialog
  // already shows why; an admin also gets the way to change plans.
  const manageUrl = lic?.manage_url;
  useEffect(() => {
    if (!manageUrl) return;
    const onLimit = () =>
      toast("Your plan's limit was reached", {
        description: "Change your plan with PromptOwl to add more people.",
        action: { label: "Manage plan", onClick: () => window.open(manageUrl, "_blank", "noopener") },
      });
    window.addEventListener("license:plan-limit", onLimit);
    return () => window.removeEventListener("license:plan-limit", onLimit);
  }, [manageUrl]);

  const notice = lic ? adminLicenseNotice(lic) : readOnly ? neutralReadOnlyNotice() : null;
  if (!notice || isDismissed(notice, dismissed)) return null;
  return (
    <LicenseNoticeCard
      className={className}
      notice={notice}
      compact={compact && notice.dismissible}
      onInstallKey={lic ? onInstallKey : undefined}
      onDismiss={
        notice.dismissible
          ? () => {
              const d = { id: notice.id, at: Date.now() };
              setDismissed(d);
              try {
                localStorage.setItem(DISMISS_KEY, JSON.stringify(d));
              } catch {
                // private mode — the dismissal just won't persist
              }
            }
          : undefined
      }
    />
  );
}
