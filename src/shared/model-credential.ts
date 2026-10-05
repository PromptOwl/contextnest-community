import { config } from "../config.js";
import { getModelGateway } from "../auth/license.js";
import { hasEntitlement } from "../auth/entitlements.js";

/** Which key a model call uses, and where it goes. */
export interface ModelCredential {
  apiKey: string;
  baseUrl: string | null;
  /** own = the customer's key (unmetered); promptowl = the licence gateway (credits). */
  source: "own" | "promptowl";
}

/** Env names a server or nest stores its own Anthropic credential under. */
export const OWN_KEY_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"] as const;

/**
 * Pricing spec §6.1/§9.3: the server's own key only with the `byok` licence
 * feature (Enterprise); otherwise PromptOwl's gateway, metered in credits.
 * A nest's own key beats the server's. null = nothing to call with.
 * ponytail: Anthropic only; another provider = its env names + gateway route here.
 */
export function resolveModelCredential(
  nestEnv: Record<string, string> = {},
): ModelCredential | null {
  if (hasEntitlement("byok")) {
    const apiKey = nestEnv.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      const baseUrl = nestEnv.ANTHROPIC_BASE_URL || config.ANTHROPIC_BASE_URL || null;
      return { apiKey, baseUrl, source: "own" };
    }
  }
  const gateway = getModelGateway();
  return gateway ? { apiKey: gateway.key, baseUrl: gateway.baseUrl, source: "promptowl" } : null;
}
