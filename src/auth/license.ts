import { existsSync, readFileSync, writeFileSync } from "fs";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { insertOrReplace, nowExpr } from "../db/sql.js";
import { persistSetting } from "../db/settings.js";

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
  ownerEmail: string | null;
  /** Named features PromptOwl says this licence unlocks (see
   *  entitlements.ts). null/absent = an older PromptOwl that sends none —
   *  tier defaults apply. */
  features?: string[] | null;
}

let currentLicense: LicenseInfo | null = null;

export function getCurrentLicense(): LicenseInfo | null {
  return currentLicense;
}

/**
 * Admin = the PromptOwl account that owns the currently-installed
 * license. We derive this live on every request rather than trusting a
 * stale users.is_admin DB column so transferring the license to a new
 * account immediately promotes the new owner and demotes the old one.
 */
export function isLicenseAdminEmail(
  email: string | null | undefined,
): boolean {
  if (!email) return false;
  const lic = currentLicense;
  if (!lic?.valid || !lic.ownerEmail) return false;
  return lic.ownerEmail.toLowerCase() === email.toLowerCase();
}

export async function isLicenseAdminUserId(userId: string): Promise<boolean> {
  try {
    const row = (await getDb().get(
      "SELECT email FROM users WHERE id = ?",
      [userId],
    )) as { email?: string } | undefined;
    return isLicenseAdminEmail(row?.email);
  } catch {
    return false;
  }
}

/**
 * Add, replace, or remove a single line in a dotenv-style file while
 * leaving every other entry intact. Used by the license install/revoke
 * flow so the operator's existing .env config isn't trampled.
 *
 * Pass value=null to delete the line.
 */
export function upsertEnvVar(
  filePath: string,
  varName: string,
  value: string | null,
): void {
  const prefix = `${varName}=`;
  let lines: string[] = [];
  if (existsSync(filePath)) {
    lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  }
  const filtered = lines.filter((line) => !line.trimStart().startsWith(prefix));
  if (value !== null) {
    filtered.push(`${prefix}${value}`);
  }
  while (filtered.length && filtered[filtered.length - 1] === "") {
    filtered.pop();
  }
  writeFileSync(filePath, filtered.join("\n") + "\n", "utf8");
}

/**
 * Persist a license key into the server's .env file (alongside any
 * other config the operator set) and re-validate. Validation runs BEFORE
 * the file is touched, so a bad key never ends up on disk.
 */
export interface InstallResult extends LicenseInfo {
  /** Whether the validated key was durably written to the database. When false
   *  the key works for this process but is lost on restart — the caller MUST
   *  surface this (it was previously swallowed). */
  persisted: boolean;
  /** Why the write failed, when persisted is false. */
  persistError?: string;
}

export async function installLicenseKey(key: string): Promise<InstallResult> {
  const trimmed = key.trim();
  if (!trimmed.startsWith("pk_")) {
    throw new Error("Invalid license key format. Must start with pk_.");
  }

  // Validate BEFORE persisting. A rejected key never touches disk, so a
  // restart won't load it back and the operator's existing working key
  // (if any) stays untouched on failure.
  const previousKey = process.env.PROMPTOWL_KEY || "";
  process.env.PROMPTOWL_KEY = trimmed;
  const info = await validateLicense({ forceFresh: true, strict: true });

  if (!info.valid) {
    // Restore prior env so a working license isn't blown away by a
    // failed replacement attempt. Re-run validate to refresh
    // currentLicense back to the prior state.
    process.env.PROMPTOWL_KEY = previousKey;
    if (previousKey) {
      await validateLicense({ forceFresh: true });
    }
    return { ...info, persisted: false };
  }

  // Validated — persist the key to the database so a restart (and every other
  // instance) picks it up. Report (don't swallow) a write failure: the key is
  // live in-memory now, but if it didn't reach the DB the operator is one
  // restart away from silently losing it. The DB is durable on Cloud Run where
  // the container filesystem is not (see db/settings.ts).
  try {
    await persistSetting("PROMPTOWL_KEY", trimmed);
    return { ...info, persisted: true };
  } catch (err) {
    const persistError = err instanceof Error ? err.message : String(err);
    console.warn(
      `[license] validated but FAILED to persist to the database: ${persistError}`,
    );
    return { ...info, persisted: false, persistError };
  }
}

// ─── Safety revalidate ────────────────────────────────────────────────
//
// Periodic forceFresh validate so deactivations/revocations from
// PromptOwl propagate within ~60s. One HTTP call per minute, idempotent.

let safetyPollHandle: NodeJS.Timeout | null = null;
const SAFETY_POLL_INTERVAL_MS = 60 * 1000;

export function startLicenseSafetyPoll(): void {
  if (safetyPollHandle) return;
  safetyPollHandle = setInterval(async () => {
    if (!config.PROMPTOWL_KEY) return;
    try {
      const wasValid = !!currentLicense?.valid;
      await validateLicense({ forceFresh: true });
      const isValid = !!currentLicense?.valid;
      if (wasValid && !isValid) {
        console.log("[license] safety poll detected revocation");
        await handleLicenseRevoked();
      }
    } catch (err) {
      // Don't escalate — the watcher and next safety tick will retry.
      console.warn(
        `[license] safety poll error: ${(err as Error).message}`,
      );
    }
  }, SAFETY_POLL_INTERVAL_MS);
  if (typeof safetyPollHandle.unref === "function") {
    safetyPollHandle.unref();
  }
}

/**
 * Hard cleanup when PromptOwl revokes/deactivates the installed
 * license. Wipes all browser sessions so existing logins lose their
 * cookies, tombstones the persisted license key so a restart doesn't
 * resurrect the dead key, and clears the in-process PROMPTOWL_KEY so
 * the next validate call starts from "unlicensed".
 */
async function handleLicenseRevoked(): Promise<void> {
  try {
    const db = getDb();
    const result = await db.run("DELETE FROM sessions");
    console.warn(
      `[license] revoked — wiped ${result.changes} active session(s).`,
    );
  } catch (err) {
    console.warn("[license] failed to wipe sessions:", err);
  }
  try {
    await persistSetting("PROMPTOWL_KEY", null);
    console.warn(
      "[license] revoked — cleared persisted PROMPTOWL_KEY from the database",
    );
  } catch (err) {
    console.warn("[license] failed to clear persisted key:", err);
  }
  process.env.PROMPTOWL_KEY = "";
  currentLicense = {
    valid: false,
    tier: "none",
    org: null,
    limits: null,
    suspended: false,
    suspendedReason: null,
    ownerEmail: null,
  };
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

// ─── Rejection grace ────────────────────────────────────────────────────
//
// An explicit rejection (PromptOwl reached, answered valid:false, not
// suspended) used to drop a licensed server to unlicensed on the spot —
// every non-GET 503s, MCP dies. One bad answer from the licensing service
// (a deploy blip, a race during key rotation) must not do that to a paying
// server, so a key that is already cached keeps serving until PromptOwl
// rejects it REJECTION_STRIKES_TO_REVOKE times in a row (~3 min at the 60s
// safety poll). Any valid answer resets the streak. Unreachable/5xx answers
// don't count either way — they already fall back to the cache.
// CU-wdqcq01kh5.
// ────────────────────────────────────────────────────────────────────────

const REJECTION_STRIKES_TO_REVOKE = 3;
let rejectionStreak = 0;
let rejectionKey: string | null = null;

/** Consecutive explicit rejections of the installed key not yet acted on. */
export function getPendingRejections(): number {
  return rejectionKey === config.PROMPTOWL_KEY ? rejectionStreak : 0;
}

type CachedLicenseRow = {
  tier: string;
  org: string;
  limits_json: string;
  validated_at: string;
  owner_email: string | null;
  features_json?: string | null;
};

/** Longest feature key accepted from PromptOwl; longer entries are dropped. */
const MAX_FEATURE_KEY = 64;

/**
 * PromptOwl's `features` → a clean, deduped, sorted string list, or null
 * when it sent none. The one sanitiser for licence features (entitlements.ts
 * uses it too). null and [] mean different things and must stay distinct:
 * null = an older PromptOwl, tier defaults apply; [] = no features (e.g.
 * revoked). A row cached before migration 048 reads as null, so during an
 * outage right after upgrading, tier defaults apply until the next
 * successful check — a deliberate fail-open for a window of one poll.
 */
export function sanitizeFeatures(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const keep = raw.filter(
    (f): f is string => typeof f === "string" && f.length > 0 && f.length <= MAX_FEATURE_KEY,
  );
  if (keep.length !== raw.length) {
    console.warn(`[license] ignored ${raw.length - keep.length} malformed licence feature entr${raw.length - keep.length === 1 ? "y" : "ies"}`);
  }
  return Array.from(new Set(keep)).sort();
}

function cachedFeatures(json: string | null | undefined): string[] | null {
  if (!json) return null;
  try {
    return sanitizeFeatures(JSON.parse(json));
  } catch {
    return null;
  }
}

function fromCache(cached: CachedLicenseRow): LicenseInfo {
  return {
    valid: true,
    tier: cached.tier,
    org: cached.org,
    limits: cached.limits_json ? JSON.parse(cached.limits_json) : null,
    suspended: suspensionConfirmed,
    suspendedReason: suspensionReason,
    ownerEmail: cached.owner_email || null,
    features: cachedFeatures(cached.features_json),
  };
}

/**
 * Validate the PromptOwl license key.
 *
 * Checks local cache first (valid for 24h), then calls PromptOwl API.
 * Server always starts — invalid key just means unlicensed mode.
 *
 * `strict` skips the rejection grace: installing a key must fail the moment
 * PromptOwl rejects it, even if an older cache row for that key exists.
 */
export async function validateLicense(
  opts: { forceFresh?: boolean; strict?: boolean } = {},
): Promise<LicenseInfo> {
  const info = await _validateLicenseImpl(!!opts.forceFresh, !!opts.strict);
  currentLicense = info;
  return info;
}

async function _validateLicenseImpl(
  forceFresh: boolean,
  strict: boolean,
): Promise<LicenseInfo> {
  const key = config.PROMPTOWL_KEY;

  if (!key) {
    return {
      valid: false,
      tier: "none",
      org: null,
      limits: null,
      suspended: false,
      suspendedReason: null,
      ownerEmail: null,
    };
  }

  // Check local cache
  const db = getDb();
  const cached = (await db.get(
    "SELECT * FROM license_cache WHERE key = ?",
    [key],
  )) as CachedLicenseRow | undefined;

  if (cached && !forceFresh) {
    const age = Date.now() - new Date(cached.validated_at + "Z").getTime();
    if (age < CACHE_TTL_MS) {
      return fromCache(cached);
    }
  }

  // Call PromptOwl to validate
  try {
    const promptowlUrl = config.PROMPTOWL_API_URL.replace(/\/$/, "");
    const res = await fetch(`${promptowlUrl}/api/license/validate`, {
      method: "POST",
      headers: config.PROMPTOWL_FETCH_HEADERS,
      body: JSON.stringify({ key }),
    });

    if (!res.ok) {
      if (cached) {
        console.warn(
          "  PromptOwl unreachable, using cached license (grace period)",
        );
        return fromCache(cached);
      }
      return {
        valid: false,
        tier: "none",
        org: null,
        limits: null,
        suspended: false,
        suspendedReason: null,
        ownerEmail: null,
      };
    }

    const data = (await res.json()) as {
      valid?: boolean;
      tier?: string;
      org?: string;
      limits?: { maxNests: number; maxUsers: number };
      suspended?: boolean;
      suspended_reason?: string;
      owner_email?: string | null;
      features?: unknown;
    };
    const features = sanitizeFeatures(data.features);

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

      // A suspension is never a revocation. PromptOwl sends valid:false
      // alongside suspended:true, and returning that as-is flipped the
      // license invalid on the FIRST strike — the safety poll then read it
      // as a revocation (wiped every session, deleted the key) before the
      // 1h window could run. Keep serving on the cached license: during the
      // window nothing changes, and once confirmed isSuspended() blocks
      // writes while reads keep working.
      if (data.valid !== true) {
        rejectionStreak = 0;
        rejectionKey = null;
        if (cached) return fromCache(cached);
        // Never licensed on this key — nothing to keep serving.
        return {
          valid: false,
          tier: "none",
          org: null,
          limits: null,
          suspended: suspensionConfirmed,
          suspendedReason: suspensionReason,
          ownerEmail: data.owner_email || null,
        };
      }
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
      // Explicit rejection. Hold on to a previously-valid license until the
      // rejection is confirmed (see "Rejection grace" above); a key with no
      // cache row — or a strict install — has nothing to protect.
      if (cached && !strict) {
        rejectionStreak = rejectionKey === key ? rejectionStreak + 1 : 1;
        rejectionKey = key;
        if (rejectionStreak < REJECTION_STRIKES_TO_REVOKE) {
          console.warn(
            `[license] PromptOwl rejected the license (${rejectionStreak}/${REJECTION_STRIKES_TO_REVOKE}); keeping the cached license until the rejection is confirmed`,
          );
          return fromCache(cached);
        }
      }
      rejectionStreak = 0;
      rejectionKey = null;
      // Confirmed deactivation/revocation. Clear any cached row so a
      // subsequent outage can't resurrect this license under the
      // grace-period fallback above.
      await db.run("DELETE FROM license_cache WHERE key = ?", [key]);
      return {
        valid: false,
        tier: "none",
        org: null,
        limits: null,
        suspended: false,
        suspendedReason: null,
        ownerEmail: data.owner_email || null,
      };
    }

    // Cache valid licenses
    if (data.valid) {
      rejectionStreak = 0;
      rejectionKey = null;
      const limitsJson = data.limits ? JSON.stringify(data.limits) : null;
      await db.run(
        insertOrReplace(
          db,
          `INSERT INTO license_cache (key, tier, org, limits_json, owner_email, features_json, validated_at)
           VALUES (?, ?, ?, ?, ?, ?, ${nowExpr(db)})`,
          ["key"],
          `tier = excluded.tier, org = excluded.org, limits_json = excluded.limits_json, owner_email = excluded.owner_email, features_json = excluded.features_json, validated_at = ${nowExpr(db)}`,
        ),
        [
          key,
          data.tier || "community",
          data.org || null,
          limitsJson,
          data.owner_email || null,
          features ? JSON.stringify(features) : null,
        ],
      );
    }

    return {
      valid: data.valid !== false,
      tier: data.tier || "community",
      org: data.org || null,
      limits: data.limits || null,
      suspended: suspensionConfirmed,
      suspendedReason: suspensionReason,
      ownerEmail: data.owner_email || null,
      features,
    };
  } catch (err: any) {
    if (cached) {
      console.warn(
        `  PromptOwl validation failed (${err.message}), using cached license`,
      );
      return fromCache(cached);
    }
    return {
      valid: false,
      tier: "none",
      org: null,
      limits: null,
      suspended: false,
      suspendedReason: null,
      ownerEmail: null,
    };
  }
}
