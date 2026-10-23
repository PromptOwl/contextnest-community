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
