import type { AdminLicense, LicenseContact } from "./api";

/**
 * What the license means for the people on this server, in plain words.
 *
 * Licensing is a private conversation between PromptOwl and the customer's
 * admin. So:
 *   - admins (and the key's owner) get friendly, specific notices: what's
 *     happening, what still works, the date anything changes, and a way to
 *     talk to PromptOwl — never alarming, never a bare status;
 *   - everyone else gets one neutral line, and only once something actually
 *     stops working. No "license", "trial", "expired", "suspended" or
 *     "payment" in front of them, ever.
 *
 * Pure and unit-tested (license-messages.test.ts) so the wording can't drift
 * from the rules it describes.
 */

export const DEFAULT_CONTACT: LicenseContact = {
  url: "https://calendar.app.google/u2z8xh5PqDjQJih78",
  email: "support@promptowl.ai",
};

/** The only thing a non-admin is ever told. */
export const NEUTRAL_READ_ONLY =
  "This workspace is read-only right now. Your administrator has been notified.";

export type NoticeLevel = "info" | "warning";

export interface LicenseNotice {
  /** Stable per situation, so a dismissal sticks to what was dismissed. */
  id: string;
  level: NoticeLevel;
  title: string;
  body: string;
  /** Label for the "Talk to PromptOwl" button; null = no button (neutral). */
  cta: string | null;
  contact: LicenseContact;
  /** Offer a new-key install (the license lapsed or the key isn't recognised). */
  offerInstall: boolean;
  /** Admins may hide it for DISMISS_DAYS — never within CHANGE_SOON_DAYS of a change. */
  dismissible: boolean;
}

/** Days left inside which a paid license starts to mention its end date. */
export const EXPIRY_NOTICE_DAYS = 14;
/** Inside this many days of a change, a notice can't be dismissed. */
export const CHANGE_SOON_DAYS = 3;
/** How long a dismissal lasts. */
export const DISMISS_DAYS = 7;

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

function daysUntil(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return isNaN(t) ? null : Math.ceil((t - now) / 86_400_000);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Only http(s) links are rendered — never trust a URL into an href blindly. */
export function safeContact(c: LicenseContact | undefined): LicenseContact {
  if (!c) return DEFAULT_CONTACT;
  return {
    url: /^https?:\/\//i.test(c.url) ? c.url : DEFAULT_CONTACT.url,
    email: c.email || DEFAULT_CONTACT.email,
  };
}

/** Dismissible unless the next change is within CHANGE_SOON_DAYS. */
function dismissibleUntil(changeIso: string | null | undefined, now: number): boolean {
  const d = daysUntil(changeIso, now);
  return d == null || d > CHANGE_SOON_DAYS;
}

/**
 * The single most useful notice for someone who can act on the license
 * (server admin or the key's owner), or null when there's nothing to say.
 */
export function adminLicenseNotice(
  lic: AdminLicense | null,
  now: number = Date.now(),
): LicenseNotice | null {
  if (!lic) return null;
  const contact = safeContact(lic.contact);
  const base = { contact, offerInstall: false };
  const trialOrLicense = lic.trial ? "trial" : "license";

  // ── The license is not valid: the workspace is read-only for everyone ──
  if (!lic.valid) {
    const ended = formatDate(lic.expires_at);
    switch (lic.reason) {
      case "expired":
        return {
          ...base,
          id: "lapsed:expired",
          level: "warning",
          title: `Your ${trialOrLicense} has ended`,
          body: `${
            ended ? `It ended on ${ended}, and t` : "T"
          }he workspace is read-only for everyone until it's renewed. Nothing has been deleted, and it unlocks by itself within a minute of renewal.`,
          cta: "Talk to us to continue",
          dismissible: false,
        };
      case "deactivated":
        return {
          ...base,
          id: "lapsed:deactivated",
          level: "warning",
          title: "This server's license key was deactivated",
          body: "The workspace is read-only for everyone until the key is reactivated or a new one is installed. Nothing has been deleted.",
          cta: "Talk to PromptOwl",
          offerInstall: true,
          dismissible: false,
        };
      case "suspended":
        return {
          ...base,
          id: "lapsed:suspended",
          level: "warning",
          title: "Editing is paused on this server",
          body: "PromptOwl paused this server's license. The workspace is read-only for everyone until it's sorted out. Nothing has been deleted.",
          cta: "Talk to PromptOwl",
          dismissible: false,
        };
      default:
        return {
          ...base,
          id: `lapsed:${lic.reason ?? "unknown"}`,
          level: "warning",
          title: "PromptOwl doesn't recognise this server's license key",
          body: "The workspace is read-only for everyone until a valid key is installed. Nothing has been deleted.",
          cta: "Talk to PromptOwl",
          offerInstall: true,
          dismissible: false,
        };
    }
  }

  if (lic.suspended) {
    return {
      ...base,
      id: "suspended",
      level: "warning",
      title: "Editing is paused on this server",
      body: `PromptOwl paused this server's license${
        lic.suspended_reason ? ` (${lic.suspended_reason})` : ""
      }. Everyone can still read; creating and editing resume as soon as it's sorted out.`,
      cta: "Talk to PromptOwl",
      dismissible: false,
    };
  }

  if (lic.pending_rejections > 0) {
    return {
      ...base,
      id: "rejections",
      level: "warning",
      title: "We couldn't confirm this server's license",
      body: `PromptOwl's last ${plural(
        lic.pending_rejections,
        "check",
        "checks",
      )} didn't confirm the license. Everything keeps working for now; if it isn't sorted out in the next few minutes, the workspace becomes read-only until it is.`,
      cta: "Talk to PromptOwl",
      dismissible: false,
    };
  }

  // ── Past the end date, inside the grace period: still fully working ──
  if (lic.reason === "expired_grace") {
    const ended = formatDate(lic.expires_at);
    const until = formatDate(lic.grace_ends_at);
    return {
      ...base,
      id: `grace:${lic.grace_ends_at ?? ""}`,
      level: dismissibleUntil(lic.grace_ends_at, now) ? "info" : "warning",
      title: `Your ${trialOrLicense} ended${ended ? ` on ${ended}` : ""}`,
      body: `Everything keeps working${
        until ? ` until ${until}` : " for now"
      }. Talk to us to continue without a break.`,
      cta: "Talk to us to continue",
      dismissible: dismissibleUntil(lic.grace_ends_at, now),
    };
  }

  const { licensed, used } = lic.seats;
  if (licensed != null && lic.seats.over_limit) {
    return {
      ...base,
      id: `seats:${licensed}`,
      level: "info",
      title: "Your team has grown past your seats",
      body: `You have ${plural(used, "person", "people")} on a ${licensed}-seat license. Everyone can keep working. We'll reach out about adding seats, or contact us anytime.`,
      cta: "Talk to us about seats",
      dismissible: true,
    };
  }

  const days = daysUntil(lic.expires_at, now);
  const ends = formatDate(lic.expires_at);
  if (lic.trial && days != null && days >= 0) {
    return {
      ...base,
      id: `trial:${lic.expires_at}`,
      level: dismissibleUntil(lic.expires_at, now) ? "info" : "warning",
      title:
        days === 0
          ? "Your trial ends today"
          : `Your trial ends in ${plural(days, "day", "days")}`,
      body: `Your free trial runs until ${ends}. Talk to us to keep going on a paid license; nothing changes for your team in the meantime.`,
      cta: "Talk to us about a license",
      dismissible: dismissibleUntil(lic.expires_at, now),
    };
  }
  if (!lic.trial && days != null && days >= 0 && days <= EXPIRY_NOTICE_DAYS) {
    return {
      ...base,
      id: `renew:${lic.expires_at}`,
      level: dismissibleUntil(lic.expires_at, now) ? "info" : "warning",
      title:
        days === 0
          ? "Your license renews today"
          : `Your license is up for renewal in ${plural(days, "day", "days")}`,
      body: `This server's license runs until ${ends}. Talk to us to renew and keep everything running without a break.`,
      cta: "Talk to us to renew",
      dismissible: dismissibleUntil(lic.expires_at, now),
    };
  }
  return null;
}

/** What a non-admin sees once the workspace is actually read-only. */
export function neutralReadOnlyNotice(): LicenseNotice {
  return {
    id: "neutral-read-only",
    level: "info",
    title: NEUTRAL_READ_ONLY,
    body: "",
    cta: null,
    contact: DEFAULT_CONTACT,
    offerInstall: false,
    dismissible: false,
  };
}

/** Is a dismissal recorded at `dismissedAt` (ms) still in force? */
export function isDismissed(
  notice: LicenseNotice,
  dismissed: { id: string; at: number } | null,
  now: number = Date.now(),
): boolean {
  if (!notice.dismissible || !dismissed) return false;
  return dismissed.id === notice.id && now - dismissed.at < DISMISS_DAYS * 86_400_000;
}
