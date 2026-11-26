import { config } from "../config.js";

/**
 * FEATURE_SURFACES is the master switch (default off) and requires the
 * workflow plane and metacognition it reuses (PRD §5.1).
 */
export function surfacesEnabled(): boolean {
  // Never in AUTH_MODE=open: every caller there is an anonymous admin, and
  // Surfaces binds conversations and links identities (security L5).
  if (config.AUTH_MODE === "open") return false;
  return config.FEATURE_SURFACES && config.FEATURE_WORKFLOW_PLANE && config.FEATURE_METACOGNITION;
}

/** The server's one Slack app (its keys in Server settings → Surfaces or Control room → Setup)
 *  is live whenever Surfaces is. Lives here so core routes don't import an adapter's routes. */
export const hostedEnabled = (): boolean => surfacesEnabled();

/** Community is one organization per deployment; Surfaces rows carry this id
 *  so a multi-org host can partition later without a migration. */
export const ORG_ID = "default";
