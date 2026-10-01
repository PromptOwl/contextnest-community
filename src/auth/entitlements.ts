/**
 * Licence entitlements — what the installed licence unlocks beyond "valid".
 *
 * Community has only ever gated on valid vs invalid; this is the first
 * feature that depends on the licence tier. Kept in its own module (reading
 * getCurrentLicense through the import, not from inside license.ts) so the
 * one place that decides "is this enterprise" is easy to find and the test
 * licence mock reaches it.
 */
import { getCurrentLicense } from "./license.js";

/** Tiers that carry the enterprise entitlements. */
const ENTERPRISE_TIERS = new Set(["enterprise"]);

/**
 * True when a valid, unsuspended licence of an enterprise tier is installed.
 * Evaluated live, so a licence that lapses or is downgraded switches the
 * enterprise features off on the next request without touching stored data.
 */
export function isEnterpriseLicense(): boolean {
  const lic = getCurrentLicense();
  return (
    !!lic?.valid &&
    !lic.suspended &&
    ENTERPRISE_TIERS.has(String(lic.tier || "").toLowerCase())
  );
}
