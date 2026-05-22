import { existsSync, readFileSync, writeFileSync } from "fs";
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
  ownerEmail: string | null;
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

export function isLicenseAdminUserId(userId: string): boolean {
  try {
    const row = getDb()
      .prepare("SELECT email FROM users WHERE id = ?")
      .get(userId) as { email?: string } | undefined;
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
function upsertEnvVar(
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
export async function installLicenseKey(key: string): Promise<LicenseInfo> {
  const trimmed = key.trim();
  if (!trimmed.startsWith("pk_")) {
    throw new Error("Invalid license key format. Must start with pk_.");
  }

  // Validate BEFORE persisting. A rejected key never touches disk, so a
  // restart won't load it back and the operator's existing working key
  // (if any) stays untouched on failure.
  const previousKey = process.env.PROMPTOWL_KEY || "";
  process.env.PROMPTOWL_KEY = trimmed;
  const info = await validateLicense({ forceFresh: true });

  if (!info.valid) {
    // Restore prior env so a working license isn't blown away by a
    // failed replacement attempt. Re-run validate to refresh
    // currentLicense back to the prior state.
    process.env.PROMPTOWL_KEY = previousKey;
    if (previousKey) {
      await validateLicense({ forceFresh: true });
    }
    return info;
  }

  // Validated — write the line into .env so a restart picks it up.
  try {
    upsertEnvVar(config.ENV_FILE_PATH, "PROMPTOWL_KEY", trimmed);
  } catch (err) {
    console.warn("[license] failed to write .env:", err);
  }

  // Restart the watcher so it picks up the new key without a process
  // restart.
  startLicenseWatcher();
  return info;
}

// ─── License watcher (long-poll) ──────────────────────────────────────
//
// PromptOwl exposes /api/license/listen which holds an HTTP request
// open until the license row mutates (toggle/delete) or ~25s elapses.
// We loop forever: open the connection, react to the response, then
// reconnect immediately. On error we back off exponentially up to a
// cap so a brief outage doesn't hammer the API.

let watcherActive = false;
let watcherAbort: AbortController | null = null;
const WATCHER_BACKOFF_MIN_MS = 2 * 1000;
const WATCHER_BACKOFF_MAX_MS = 60 * 1000;

export function startLicenseWatcher(): void {
  if (watcherActive) {
    // Cancel any in-flight long-poll so the loop restarts with the
    // current key. The loop guard below will pick up the new state.
    watcherAbort?.abort();
    return;
  }
  watcherActive = true;
  void runLicenseWatcher();
}

async function runLicenseWatcher(): Promise<void> {
  let backoff = WATCHER_BACKOFF_MIN_MS;
  while (watcherActive) {
    const key = config.PROMPTOWL_KEY;
    if (!key) {
      // Nothing to watch yet — wait a beat and check again. The
      // install endpoint calls startLicenseWatcher() once a key is
      // set, but this guards against startup ordering too.
      await sleep(WATCHER_BACKOFF_MAX_MS);
      continue;
    }
    try {
      watcherAbort = new AbortController();
      const promptowlUrl = config.PROMPTOWL_API_URL.replace(/\/$/, "");
      // Cap fetch lifetime under the longest reasonable upstream hold
      // so a stalled connection (e.g. Vercel buffering, dropped TCP)
      // cannot pin the watcher beyond ~30s. AbortSignal.any composes
      // the local abort (used by installLicenseKey) with the timeout.
      const fetchTimeout = AbortSignal.timeout(30 * 1000);
      const signal =
        typeof (AbortSignal as { any?: unknown }).any === "function"
          ? (AbortSignal as unknown as {
              any: (s: AbortSignal[]) => AbortSignal;
            }).any([watcherAbort.signal, fetchTimeout])
          : watcherAbort.signal;
      const res = await fetch(`${promptowlUrl}/api/license/listen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          since_updated_at: currentLicense
            ? new Date().toISOString()
            : undefined,
        }),
        signal,
      });

      if (!res.ok) {
        // Upstream gateway timeouts (Vercel/Cloudflare/nginx killing
        // the long-poll connection) carry no event payload — same
        // semantics as "no_change". Reconnect immediately without
        // inflating the backoff, otherwise repeated 504s ramp the
        // retry delay to 60s and stretch revoke-detection latency
        // to a full minute.
        if (res.status === 504 || res.status === 408 || res.status === 502) {
          backoff = WATCHER_BACKOFF_MIN_MS;
          continue;
        }
        throw new Error(`listen returned ${res.status}`);
      }

      const data = (await res.json()) as {
        event?: string;
        valid?: boolean;
      };

      backoff = WATCHER_BACKOFF_MIN_MS;

      // "no_change" means timed out without an event — just loop. Any
      // other event indicates a state change, so revalidate to refresh
      // currentLicense + clear the SQLite cache row (when valid:false
      // comes back).
      if (data.event && data.event !== "no_change") {
        console.log(
          `[license] event from PromptOwl: ${data.event} — revalidating`,
        );
        const wasValid = !!currentLicense?.valid;
        // Force a network round-trip; the 24h SQLite cache would
        // otherwise return the stale "valid" row and the revoke
        // transition would never be detected.
        await validateLicense({ forceFresh: true });
        const isValid = !!currentLicense?.valid;
        if (wasValid && !isValid) {
          handleLicenseRevoked();
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        // Caller aborted (e.g. installLicenseKey reset the watcher).
        // Loop again with fresh state.
        continue;
      }
      console.warn(
        `[license] watcher error: ${(err as Error).message}; backing off ${backoff}ms`,
      );
      await sleep(backoff);
      backoff = Math.min(backoff * 2, WATCHER_BACKOFF_MAX_MS);
    } finally {
      watcherAbort = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Safety revalidate ────────────────────────────────────────────────
//
// The long-poll watcher is the primary signal, but several conditions
// can silently drop revoke events: upstream serverless cold-starts,
// multi-instance PromptOwl deployments where the in-process event bus
// only fires on one instance, persistent network blackouts that
// exhaust the backoff. This timer runs a forceFresh validate every
// 60s as a floor on detection latency. Cheap (one HTTP call/minute)
// and idempotent with the watcher — whichever notices first wins.

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
        handleLicenseRevoked();
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
 * cookies, deletes the on-disk license env file so a restart doesn't
 * resurrect the dead key, and clears the in-process PROMPTOWL_KEY so
 * the next validate call starts from "unlicensed".
 */
function handleLicenseRevoked(): void {
  try {
    const db = getDb();
    const result = db.prepare("DELETE FROM sessions").run();
    console.warn(
      `[license] revoked — wiped ${result.changes} active session(s).`,
    );
  } catch (err) {
    console.warn("[license] failed to wipe sessions:", err);
  }
  try {
    upsertEnvVar(config.ENV_FILE_PATH, "PROMPTOWL_KEY", null);
    console.warn(
      `[license] revoked — removed PROMPTOWL_KEY from ${config.ENV_FILE_PATH}`,
    );
  } catch (err) {
    console.warn("[license] failed to strip key from .env:", err);
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

/**
 * Validate the PromptOwl license key.
 *
 * Checks local cache first (valid for 24h), then calls PromptOwl API.
 * Server always starts — invalid key just means unlicensed mode.
 */
export async function validateLicense(
  opts: { forceFresh?: boolean } = {},
): Promise<LicenseInfo> {
  const info = await _validateLicenseImpl(!!opts.forceFresh);
  currentLicense = info;
  return info;
}

async function _validateLicenseImpl(forceFresh: boolean): Promise<LicenseInfo> {
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
  const cached = db
    .prepare("SELECT * FROM license_cache WHERE key = ?")
    .get(key) as
    | {
      tier: string;
      org: string;
      limits_json: string;
      validated_at: string;
      owner_email: string | null;
    }
    | undefined;

  if (cached && !forceFresh) {
    const age = Date.now() - new Date(cached.validated_at + "Z").getTime();
    if (age < CACHE_TTL_MS) {
      return {
        valid: true,
        tier: cached.tier,
        org: cached.org,
        limits: cached.limits_json ? JSON.parse(cached.limits_json) : null,
        suspended: suspensionConfirmed,
        suspendedReason: suspensionReason,
        ownerEmail: cached.owner_email || null,
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
          ownerEmail: cached.owner_email || null,
        };
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
      // Explicit deactivation/revocation — PromptOwl reached us and said
      // the key is no longer valid. Clear any cached row so a subsequent
      // outage can't resurrect this license under the grace-period
      // fallback above.
      db.prepare("DELETE FROM license_cache WHERE key = ?").run(key);
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
      const limitsJson = data.limits ? JSON.stringify(data.limits) : null;
      db.prepare(
        `INSERT OR REPLACE INTO license_cache (key, tier, org, limits_json, owner_email, validated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      ).run(
        key,
        data.tier || "community",
        data.org || null,
        limitsJson,
        data.owner_email || null,
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
        ownerEmail: cached.owner_email || null,
      };
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
