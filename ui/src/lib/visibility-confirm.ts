/**
 * Nest visibility tiers, worded for the server they're on.
 *
 * 'org' means "every authenticated account on this deployment"
 * (server: src/shared/access.ts). On a single-company self-hosted server
 * that is the organisation, so the tier flips in one click. On a SHARED
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
        ? "Every account on this server can read — other organisations included"
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
        ? "This makes the nest readable by anyone on the internet — including every account on this server, which belongs to other organisations too. Anyone with the URL will be able to read it."
        : "This makes the nest readable by anyone on the internet, outside your organization. Anyone with the URL will be able to read it.",
      confirm: "Make public",
    };
  }
  return {
    title: "Open this nest to everyone on this server?",
    body: "This server is shared: “Organization” makes the nest readable by every account on this server, including other organisations — not just yours. Only choose it for context that any of them may see.",
    confirm: "Open to everyone here",
  };
}
