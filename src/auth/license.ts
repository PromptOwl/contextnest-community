import { config } from "../config.js";
import { getDb } from "../db/client.js";

export interface LicenseInfo {
  valid: boolean;
  tier: string;
  org: string | null;
  limits: {
    maxNests: number;
    maxUsers: number;
  } | null;
  suspended: boolean;
  suspendedReason: string | null;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Kill Switch ────────────────────────────────────────────────────────
//
// PromptOwl can remotely suspend a server by returning:
//   { valid: false, suspended: true, suspended_reason: "..." }
//
// Safety rails to prevent accidental triggers:
//   1. The API must return an explicit `suspended: true` flag — a simple
//      validation failure (expired key, network error) does NOT suspend.
//   2. Suspension requires TWO consecutive confirmations 1 hour apart.
//      A single bad response is ignored (could be a deploy glitch).
//   3. The server logs a loud warning but keeps running during the
//      confirmation window, so a mistaken flag can be reverted.
//   4. Even after suspension, the server stays up but returns 503 on
//      write endpoints. Reads still work so nobody loses access to data.
//
// On the PromptOwl side, the /api/license/validate endpoint should only
// set `suspended: true` via an admin-only action with confirmation UI —
// never automated, never from a cron job.
// ────────────────────────────────────────────────────────────────────────

let suspensionFirstSeen: number | null = null;
let suspensionConfirmed = false;
let suspensionReason: string | null = null;

const SUSPENSION_CONFIRM_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export function isSuspended(): boolean {
  return suspensionConfirmed;
}

export function getSuspensionReason(): string | null {
  return suspensionReason;
}

/**
 * Validate the PromptOwl license key.
 *
 * Checks local cache first (valid for 24h), then calls PromptOwl API.
 * Server always starts — invalid key just means unlicensed mode.
 */
export async function validateLicense(): Promise<LicenseInfo> {
  const key = config.PROMPTOWL_KEY;

  if (!key) {
    return {
      valid: false,
      tier: "none",
      org: null,
      limits: null,
      suspended: false,
      suspendedReason: null,
    };
  }

  // Check local cache
  const db = getDb();
  const cached = db
    .prepare("SELECT * FROM license_cache WHERE key = ?")
    .get(key) as
    | { tier: string; org: string; limits_json: string; validated_at: string }
    | undefined;

  if (cached) {
    const age = Date.now() - new Date(cached.validated_at + "Z").getTime();
    if (age < CACHE_TTL_MS) {
      return {
        valid: true,
        tier: cached.tier,
        org: cached.org,
        limits: cached.limits_json ? JSON.parse(cached.limits_json) : null,
        suspended: suspensionConfirmed,
        suspendedReason: suspensionReason,
      };
    }
  }

  // Call PromptOwl to validate
  try {
    const promptowlUrl = config.PROMPTOWL_API_URL.replace(/\/$/, "");
    const res = await fetch(`${promptowlUrl}/api/license/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });

    if (!res.ok) {
      if (cached) {
        console.warn(
          "  PromptOwl unreachable, using cached license (grace period)",
        );
        return {
          valid: true,
          tier: cached.tier,
          org: cached.org,
          limits: cached.limits_json ? JSON.parse(cached.limits_json) : null,
          suspended: suspensionConfirmed,
          suspendedReason: suspensionReason,
        };
      }
      return {
        valid: false,
        tier: "none",
        org: null,
        limits: null,
        suspended: false,
        suspendedReason: null,
      };
    }

    const data = (await res.json()) as {
      valid?: boolean;
      tier?: string;
      org?: string;
      limits?: { maxNests: number; maxUsers: number };
      suspended?: boolean;
      suspended_reason?: string;
    };

    // ── Kill switch: two-strike confirmation ──
    if (data.suspended === true) {
      if (!suspensionFirstSeen) {
        // First strike — start the confirmation window
        suspensionFirstSeen = Date.now();
        suspensionReason = data.suspended_reason || "Suspended by PromptOwl";
        console.warn(
          `\n  WARNING: PromptOwl has flagged this server for suspension.`,
        );
        console.warn(
          `  Reason: ${suspensionReason}`,
        );
        console.warn(
          `  This will be confirmed in ~1 hour. If this is an error,`,
        );
        console.warn(
          `  contact support@promptowl.ai to reverse it.\n`,
        );
      } else if (
        Date.now() - suspensionFirstSeen >= SUSPENSION_CONFIRM_WINDOW_MS
      ) {
        // Second strike after the window — confirm suspension
        suspensionConfirmed = true;
        suspensionReason = data.suspended_reason || "Suspended by PromptOwl";
        console.error(
          `\n  SERVER SUSPENDED: ${suspensionReason}`,
        );
        console.error(
          `  Write operations are disabled. Reads still work.`,
        );
        console.error(
          `  Contact support@promptowl.ai to resolve.\n`,
        );
      }
      // During the confirmation window, server runs normally
    } else {
      // Clear any pending suspension (PromptOwl reversed it)
      if (suspensionFirstSeen) {
        console.log("  Suspension flag cleared by PromptOwl.");
      }
      suspensionFirstSeen = null;
      suspensionConfirmed = false;
      suspensionReason = null;
    }

    if (!data.valid && !data.suspended) {
      return {
        valid: false,
        tier: "none",
        org: null,
        limits: null,
        suspended: false,
        suspendedReason: null,
      };
    }

    // Cache valid licenses
    if (data.valid) {
      const limitsJson = data.limits ? JSON.stringify(data.limits) : null;
      db.prepare(
        `INSERT OR REPLACE INTO license_cache (key, tier, org, limits_json, validated_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      ).run(key, data.tier || "community", data.org || null, limitsJson);
    }

    return {
      valid: data.valid !== false,
      tier: data.tier || "community",
      org: data.org || null,
      limits: data.limits || null,
      suspended: suspensionConfirmed,
      suspendedReason: suspensionReason,
    };
  } catch (err: any) {
    if (cached) {
      console.warn(
        `  PromptOwl validation failed (${err.message}), using cached license`,
      );
      return {
        valid: true,
        tier: cached.tier,
        org: cached.org,
        limits: cached.limits_json ? JSON.parse(cached.limits_json) : null,
        suspended: suspensionConfirmed,
        suspendedReason: suspensionReason,
      };
    }
    return {
      valid: false,
      tier: "none",
      org: null,
      limits: null,
      suspended: false,
      suspendedReason: null,
    };
  }
}
