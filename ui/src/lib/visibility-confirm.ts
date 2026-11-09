/**
 * Nest visibility tiers, worded for the server they're on.
 *
 * 'org' means "every authenticated account on this deployment"
 * (server: src/shared/access.ts). On a single-company self-hosted server
 * that is the organization, so the tier flips in one click. On a SHARED
 * deployment — the PromptOwl-hosted server, one install holding many
 * customers — it is every customer, so it needs the same acknowledgement
 * 'public' always needs, and the picker must say so instead of "everyone
 * signed in here". The server reports which it is on /health
 * (`shared_deployment`) and enforces the acknowledgement itself
 * (CU-wdqcq02mek). Pure so the rules stay unit-testable.
 */
import type { NestVisibility } from "./api";

export interface VisibilityContext {
  sharedDeployment: boolean;
}

/** Does choosing this tier need the acknowledgement dialog (and
 *  `acknowledge_public: true` on the wire)? Mirrors the server guard. */
export function visibilityNeedsAcknowledgement(
  next: NestVisibility,
  ctx: VisibilityContext,
): boolean {
  if (next === "public") return true;
  if (next === "org") return ctx.sharedDeployment;
  return false;
}

/** The one-line hint under each tier in the picker. */
export function visibilityTierHint(
  tier: NestVisibility,
  ctx: VisibilityContext,
): string {
  switch (tier) {
    case "private":
      return "Only people added to the nest";
    case "org":
      return ctx.sharedDeployment
        ? "Every account on this server can read — other organizations included"
        : "Everyone signed in here can read";
    case "public":
      return ctx.sharedDeployment
        ? "Anyone with the URL can read — on the internet and on this server"
        : "Anyone with the URL can read";
  }
}

export interface VisibilityConfirmCopy {
  title: string;
  body: string;
  confirm: string;
}

/** The acknowledgement dialog for a tier that needs one. */
export function visibilityConfirmCopy(
  tier: Exclude<NestVisibility, "private">,
  ctx: VisibilityContext,
): VisibilityConfirmCopy {
  if (tier === "public") {
    return {
      title: "Make this nest public?",
      body: ctx.sharedDeployment
        ? "This makes the nest readable by anyone on the internet — including every account on this server, which belongs to other organizations too. Anyone with the URL will be able to read it."
        : "This makes the nest readable by anyone on the internet, outside your organization. Anyone with the URL will be able to read it.",
      confirm: "Make public",
    };
  }
  // 'org' only ever needs a dialog on a shared deployment — see
  // visibilityNeedsAcknowledgement. On a single-organization server the tier
  // applies without one, so there is no self-hosted wording to return here;
  // a caller that reaches this with sharedDeployment=false is a bug.
  if (!ctx.sharedDeployment) {
    throw new Error("visibilityConfirmCopy('org') is only defined on a shared deployment");
  }
  return {
    title: "Open this nest to everyone on this server?",
    body: "This server is shared: Organization makes the nest readable by every account on this server, including other organizations — not just yours. Only choose it for context that any of them may see.",
    confirm: "Open to everyone here",
  };
}

/** Who may widen a nest, from /health (NEST_PUBLIC_VISIBILITY /
 *  NEST_ORG_VISIBILITY), plus whether the viewer is a server admin. */
export interface VisibilityPolicy {
  publicBy: "owners" | "admins";
  orgBy: "owners" | "admins";
  isServerAdmin: boolean;
}

const TIER_RANK: Record<NestVisibility, number> = { private: 0, org: 1, public: 2 };

/** Why the viewer can't move a nest from `current` to `target`, or null when
 *  they can. Mirrors the server (nests/visibility-service.ts): only widening
 *  to an admins-only tier is restricted; narrowing never is. */
export function visibilityBlockedReason(
  target: NestVisibility,
  current: NestVisibility,
  policy: VisibilityPolicy,
): string | null {
  if (TIER_RANK[target] <= TIER_RANK[current] || policy.isServerAdmin) return null;
  if (target === "public" && policy.publicBy === "admins")
    return "Only a server admin can make nests public on this server.";
  if (target === "org" && policy.orgBy === "admins")
    return "Only a server admin can make nests organization-wide on this server.";
  return null;
}

export interface VisibilityMenuOption {
  value: NestVisibility;
  label: string;
  /** The tier's one-liner, or why it's blocked when it is. */
  hint: string;
  disabled: boolean;
  current: boolean;
}

const TIER_LABELS: Array<[NestVisibility, string]> = [
  ["private", "Private"],
  ["org", "Organization"],
  ["public", "Public"],
];

/** The choices every visibility control offers — the nest header button,
 *  the document top bar and the Collaborators card alike: all three tiers
 *  from any tier, with a capped one disabled and explained. */
export function visibilityMenuOptions(
  current: NestVisibility,
  ctx: VisibilityContext,
  policy: VisibilityPolicy,
): VisibilityMenuOption[] {
  return TIER_LABELS.map(([value, label]) => {
    const reason = visibilityBlockedReason(value, current, policy);
    return {
      value,
      label,
      hint: reason ?? visibilityTierHint(value, ctx),
      disabled: reason !== null,
      current: value === current,
    };
  });
}

/** Settle a visibility save into what the control should show. Success takes
 *  the server's echoed (re-read) value verbatim; failure reverts to the
 *  PREVIOUS value — never one derived from the target, which once showed a
 *  public badge on a nest that never went public. */
export async function settleVisibilityChange(
  prev: NestVisibility,
  target: NestVisibility,
  send: () => Promise<{ visibility?: NestVisibility }>,
): Promise<{ visibility: NestVisibility; error: string | null }> {
  try {
    const result = await send();
    const visibility = result?.visibility || target;
    return {
      visibility,
      error:
        visibility === target
          ? null
          : "Server did not accept the change. You may not have admin access to this nest.",
    };
  } catch (err: any) {
    return { visibility: prev, error: err?.message || "Failed to change visibility" };
  }
}

/** A choice in the visibility picker: one of the three tiers, or "team", which
 *  opens team sharing instead of changing the tier. */
export type VisibilityPickerValue = NestVisibility | "team";

export interface VisibilityPickerOption extends Omit<VisibilityMenuOption, "value"> {
  value: VisibilityPickerValue;
}

/**
 * What the visibility picker offers. On a single-organization server this is
 * visibilityMenuOptions unchanged. On a shared deployment 'Organization'
 * reaches every organization on the server, so it is left out (unless the
 * nest is already org, so the current value still shows) and "Share with a
 * team…" takes its place when the host can open team sharing.
 */
export function visibilityPickerOptions(
  current: NestVisibility,
  ctx: VisibilityContext,
  policy: VisibilityPolicy,
  opts: { canShareWithTeam: boolean },
): VisibilityPickerOption[] {
  const tiers: VisibilityPickerOption[] = visibilityMenuOptions(current, ctx, policy);
  if (!ctx.sharedDeployment) return tiers;
  const out = tiers.filter((o) => o.value !== "org" || current === "org");
  if (opts.canShareWithTeam) {
    const at = out.findIndex((o) => o.value === "public");
    out.splice(at, 0, {
      value: "team",
      label: "Share with a team…",
      hint: "Only the members of a team you choose",
      disabled: false,
      current: false,
    });
  }
  return out;
}
