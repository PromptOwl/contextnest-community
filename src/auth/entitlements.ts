/**
 * Licence entitlements — the named features the installed licence unlocks
 * beyond "valid".
 *
 * PromptOwl's licence console sets a licence's tier and per-licence feature
 * overrides; its v2 validate answer carries the effective list as
 * `features`. Gate a feature with `hasEntitlement("<key>")`, never on a
 * tier, so enterprise features stack one key at a time. Keys are the wire
 * contract with PromptOwl (TheOwl lib/community-license/entitlements.ts):
 * add new keys there and here, never rename one.
 *
 * An older PromptOwl sends no `features`; then the tier's defaults below
 * apply, so nothing changes for existing enterprise licences. Evaluated
 * live, so a licence that lapses, is suspended or loses a feature switches
 * it off on the next request without touching stored data.
 */
import { getCurrentLicense } from "./license.js";

/** Features each tier gets when PromptOwl sends no explicit list. */
const TIER_DEFAULT_FEATURES: Record<string, readonly string[]> = {
  enterprise: ["hootie_branding"],
};

/** The features the installed licence unlocks right now (sorted). */
export function licenseFeatures(): string[] {
  const lic = getCurrentLicense();
  if (!lic?.valid || lic.suspended) return [];
  const list = (lic as { features?: unknown }).features;
  if (Array.isArray(list)) {
    return Array.from(new Set(list.filter((f): f is string => typeof f === "string"))).sort();
  }
  return [...(TIER_DEFAULT_FEATURES[String(lic.tier || "").toLowerCase()] ?? [])].sort();
}

/** Whether the installed licence unlocks `feature`. */
export function hasEntitlement(feature: string): boolean {
  return licenseFeatures().includes(feature);
}

/**
 * True when a valid, unsuspended licence of the enterprise tier is
 * installed. Kept for callers that genuinely mean the tier (display);
 * gate features with hasEntitlement() instead.
 */
export function isEnterpriseLicense(): boolean {
  const lic = getCurrentLicense();
  return !!lic?.valid && !lic.suspended && String(lic.tier || "").toLowerCase() === "enterprise";
}
