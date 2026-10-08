import { existsSync, readFileSync, writeFileSync } from "fs";
import { config } from "../config.js";
import { SERVICE_VERSION } from "../shared/version.js";
import { getDb } from "../db/client.js";
import { insertOrReplace, nowExpr } from "../db/sql.js";
import { persistSetting } from "../db/settings.js";
import { encryptSecret, tryDecryptSecret } from "../shared/secret-box.js";

export interface LicenseSeats {
  /** Seats the license covers; null = unlimited. */
  licensed: number | null;
  /** People on this server at the last check; null = unknown. */
  used: number | null;
  overLimit: boolean;
}

export interface LicenseContact {
  url: string;
  email: string;
}

/** Where every license message points: PromptOwl sells licenses by hand. */
export const DEFAULT_LICENSE_CONTACT: LicenseContact = {
  url: "https://calendar.app.google/u2z8xh5PqDjQJih78",
  email: "support@promptowl.ai",
};

export interface LicenseInfo {
  valid: boolean;
  tier: string;
  org: string | null;
  limits: {
    maxNests: number;
    maxUsers: number;
    // Pricing entitlement (see getEntitlement). Optional: a PromptOwl that
    // predates it sends none, and the server then runs as Free.
    plan?: LicensePlan;
    maxAccountOwners?: number | null;
    maxSubscribers?: number | null;
  } | null;
  suspended: boolean;
  suspendedReason: string | null;
  ownerEmail: string | null;
  // License contract v2 — advisory fields from PromptOwl's latest answer.
  // Optional so a pre-v2 PromptOwl (and test mocks) still type-check.
  trial?: boolean;
  expiresAt?: string | null;
  seats?: LicenseSeats | null;
  /** not_found | deactivated | suspended | expired — why PromptOwl refused the
   *  key — or expired_grace: past its end date but still valid until graceEndsAt. */
  reason?: string | null;
  graceEndsAt?: string | null;
  contact?: LicenseContact;
  /** Named features PromptOwl says this licence unlocks (see
   *  entitlements.ts). null/absent = an older PromptOwl that sends none —
   *  tier defaults apply. */
  features?: string[] | null;
}


let currentLicense: LicenseInfo | null = null;

export function getCurrentLicense(): LicenseInfo | null {
  return currentLicense;
}

// ─── Pricing entitlement ────────────────────────────────────────────────
// PromptOwl owns the plan; we read it from validate `limits`. A missing field
// takes the plan's default, and no plan means Free. null = unlimited.

export type LicensePlan = "free" | "trial" | "self_hosted" | "enterprise";

export interface Entitlement {
  plan: LicensePlan;
  /** Billed users: Account Owners, nest owners, admins, reviewers. */
  maxUsers: number | null;
  maxAccountOwners: number | null;
  /** Editors. Free has none: adding one is a paid action. */
  maxSubscribers: number | null;
}

const PLAN_DEFAULTS: Record<LicensePlan, Omit<Entitlement, "plan">> = {
  free: { maxUsers: 10, maxAccountOwners: 1, maxSubscribers: 0 },
  trial: { maxUsers: 30, maxAccountOwners: null, maxSubscribers: null },
  self_hosted: { maxUsers: 30, maxAccountOwners: null, maxSubscribers: null },
  enterprise: { maxUsers: null, maxAccountOwners: null, maxSubscribers: null },
};

/** A cap from PromptOwl: null = unlimited, a whole number = the cap, anything
 *  else (missing, malformed) = the plan's default. */
function capOr(v: unknown, fallback: number | null): number | null {
  if (v === null) return null;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

export function entitlementOf(lic: LicenseInfo | null | undefined): Entitlement {
  const l = lic?.valid ? lic.limits : null;
  const plan: LicensePlan =
    l?.plan && l.plan in PLAN_DEFAULTS ? l.plan : "free";
  const d = PLAN_DEFAULTS[plan];
  // Limits only count once PromptOwl names a plan: an older PromptOwl's
  // maxUsers (0 = unlimited) must not lift a Free server's cap.
  if (!l?.plan) return { plan, ...d };
  const maxUsers = capOr(l.maxUsers, d.maxUsers);
  return {
    plan,
    maxUsers: maxUsers === 0 ? null : maxUsers, // 0 = unlimited (older contract)
    maxAccountOwners: capOr(l.maxAccountOwners, d.maxAccountOwners),
    maxSubscribers: capOr(l.maxSubscribers, d.maxSubscribers),
  };
}

export function getEntitlement(): Entitlement {
  return entitlementOf(currentLicense);
}

// ─── Model gateway ──────────────────────────────────────────────────────
// The license's LiteLLM key (models on PromptOwl credits). Kept off LicenseInfo,
// which routes echo back; encrypted in license_cache, dropped once invalid.

export interface ModelGateway {
  baseUrl: string;
  key: string;
  /** PromptOwl's default team model name (e.g. "default-claude/claude-sonnet-5"). */
  defaultModel: string | null;
}

let currentGateway: ModelGateway | null = null;

export function getModelGateway(): ModelGateway | null {
  return currentGateway;
}

function parseGateway(raw: unknown): ModelGateway | null {
  const g = (raw && typeof raw === "object" ? raw : {}) as {
    baseUrl?: unknown;
    key?: unknown;
    defaultModel?: unknown;
  };
  const defaultModel =
    typeof g.defaultModel === "string" && /^[\w./:@-]{1,128}$/.test(g.defaultModel) ? g.defaultModel : null;
  return typeof g.baseUrl === "string" &&
    /^https?:\/\/[^\s"'<>]+$/i.test(g.baseUrl) &&
    typeof g.key === "string" &&
    g.key.length > 0
    ? { baseUrl: g.baseUrl.replace(/\/+$/, ""), key: g.key, defaultModel }
    : null;
}

async function gatewayFromCache<T>(
  stored: string | null | undefined,
  parse: (raw: unknown) => T | null,
): Promise<T | null> {
  if (!stored) return null;
  const plain = await tryDecryptSecret(stored, "the license model gateway key");
  if (!plain) return null;
  try {
    return parse(JSON.parse(plain));
  } catch {
    return null;
  }
}

/** The licence's own-provider key (byok): only the models it lists go through it. */
export interface OwnGateway {
  baseUrl: string;
  key: string;
  models: string[];
  /** Masked key tail per provider, for the settings page. */
  providers: Record<string, { masked: string; updatedAt: string | null }>;
}

let currentOwnGateway: OwnGateway | null = null;

export function getOwnGateway(): OwnGateway | null {
  return currentOwnGateway;
}

function parseOwnGateway(raw: unknown): OwnGateway | null {
  const base = parseGateway(raw);
  if (!base) return null;
  const g = raw as { models?: unknown; providers?: unknown };
  const models = Array.isArray(g.models)
    ? g.models.filter((m): m is string => typeof m === "string" && /^[\w./:@-]{1,160}$/.test(m))
    : [];
  const providers: OwnGateway["providers"] = {};
  if (g.providers && typeof g.providers === "object") {
    for (const [p, v] of Object.entries(g.providers as Record<string, any>)) {
      if (/^[a-z]{1,32}$/.test(p) && typeof v?.masked === "string") {
        providers[p] = { masked: v.masked.slice(-4), updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : null };
      }
    }
  }
  return { baseUrl: base.baseUrl, key: base.key, models, providers };
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
        // A lapsed license (expired, deactivated, not found) is a
        // conversation between PromptOwl and this server's admin, not a
        // reason to throw everyone out mid-task. The server goes read-only —
        // the license gate refuses writes — but sessions and the installed
        // key stay put, so when PromptOwl renews or reactivates the key the
        // next poll restores the server with nothing to reinstall. (This
        // used to wipe every session and delete the key.)
        console.warn(
          `[license] license is no longer valid (${
            currentLicense?.reason || "rejected"
          }) — server is read-only until PromptOwl restores it or a new key is installed`,
        );
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

// ─── License v2 metadata ────────────────────────────────────────────────
//
// trial / expiry / seats / reason / contact from PromptOwl's most recent
// answer (valid or not). Kept in memory rather than license_cache: every
// field is advisory and refreshed by the 60s safety poll, and a rejection's
// reason has to outlive the cache row it deletes — that's what lets the setup
// screen say "your trial ended on …" instead of a bare "no license".
// ────────────────────────────────────────────────────────────────────────

type LicenseMeta = Pick<
  LicenseInfo,
  "trial" | "expiresAt" | "seats" | "reason" | "graceEndsAt" | "contact"
>;

let lastMeta: LicenseMeta | null = null;
let lastCheckedAt: string | null = null;
// The PromptOwl account that owns the installed key, remembered across a
// lapse: once the license stops being valid, currentLicense.ownerEmail can go
// null, but the owner is still the person who should hear why and fix it.
let lastOwnerEmail: string | null = null;

/** Owner of the installed key — while valid, or as last reported. */
export function getLicenseOwnerEmail(): string | null {
  return currentLicense?.ownerEmail || lastOwnerEmail;
}

/** When PromptOwl last answered a validate (any answer), ISO; null = never. */
export function getLastLicenseCheck(): string | null {
  return lastCheckedAt;
}

function safeContact(raw: unknown): LicenseContact {
  const c = (raw && typeof raw === "object" ? raw : {}) as {
    url?: unknown;
    email?: unknown;
  };
  // Rendered as a link in the UI: http(s) only, never javascript: etc.
  const url =
    typeof c.url === "string" && /^https?:\/\/[^\s"'<>]+$/i.test(c.url)
      ? c.url
      : DEFAULT_LICENSE_CONTACT.url;
  const email =
    typeof c.email === "string" && /^[^\s@<>"']+@[^\s@<>"']+$/.test(c.email)
      ? c.email
      : DEFAULT_LICENSE_CONTACT.email;
  return { url, email };
}

/** Parse the v2 fields out of a validate answer. A pre-v2 PromptOwl sends
 *  none of them: seats are then derived from limits + the count we sent. */
function isoOrNull(v: unknown): string | null {
  return typeof v === "string" && !isNaN(Date.parse(v))
    ? new Date(v).toISOString()
    : null;
}

function parseMeta(
  data: Record<string, any>,
  usersSent: number | null,
): LicenseMeta {
  const limit =
    typeof data.limits?.maxUsers === "number" && data.limits.maxUsers > 0
      ? data.limits.maxUsers
      : null;
  const s = data.seats && typeof data.seats === "object" ? data.seats : null;
  const licensed =
    typeof s?.licensed === "number" && s.licensed > 0 ? s.licensed : limit;
  const used = typeof s?.used === "number" ? s.used : usersSent;
  const overLimit =
    typeof s?.over_limit === "boolean"
      ? s.over_limit
      : licensed != null && used != null && used > licensed;
  return {
    trial: data.trial === true,
    expiresAt: isoOrNull(data.expires_at),
    seats: { licensed, used, overLimit },
    reason: typeof data.reason === "string" ? data.reason : null,
    graceEndsAt: isoOrNull(data.grace_ends_at),
    contact: safeContact(data.contact),
  };
}

function withMeta(info: LicenseInfo): LicenseInfo {
  return {
    ...info,
    ...(lastMeta ?? {}),
    contact: lastMeta?.contact ?? DEFAULT_LICENSE_CONTACT,
  };
}

/** What we tell PromptOwl about this server on every validate (contract v2):
 *  the seat count the license is billed and enforced on, plus version/URL so
 *  PromptOwl can show the operator which server a key is running on. Sent
 *  regardless of TELEMETRY_ENABLED — it is part of license validation, not
 *  analytics, and carries no content. */
async function serverReport(): Promise<{
  stats?: { users: number; subscribers: number; nests: number };
  server: { version: string; public_url?: string };
}> {
  const server: { version: string; public_url?: string } = {
    version: SERVICE_VERSION,
  };
  if (config.PUBLIC_BASE_URL) server.public_url = config.PUBLIC_BASE_URL;
  try {
    const db = getDb();
    // Billed users/subscribers (seats.ts), not every account: that's what
    // the plan caps. Imported lazily — seats.ts imports this module.
    const { countBilled } = await import("./seats.js");
    const { users, subscribers } = await countBilled();
    const nests =
      ((await db.get("SELECT COUNT(*) as c FROM nests")) as { c: number })?.c ||
      0;
    return { stats: { users, subscribers, nests: Number(nests) }, server };
  } catch {
    return { server };
  }
}

type CachedLicenseRow = {
  tier: string;
  org: string;
  limits_json: string;
  validated_at: string;
  owner_email: string | null;
  features_json?: string | null;
  gateway_json?: string | null;
  own_gateway_json?: string | null;
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

async function fromCache(cached: CachedLicenseRow): Promise<LicenseInfo> {
  if (cached.owner_email) lastOwnerEmail = cached.owner_email;
  currentGateway = await gatewayFromCache(cached.gateway_json, parseGateway);
  currentOwnGateway = await gatewayFromCache(cached.own_gateway_json, parseOwnGateway);
  return withMeta({
    valid: true,
    tier: cached.tier,
    org: cached.org,
    limits: cached.limits_json ? JSON.parse(cached.limits_json) : null,
    suspended: suspensionConfirmed,
    suspendedReason: suspensionReason,
    ownerEmail: cached.owner_email || null,
    features: cachedFeatures(cached.features_json),
  });
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
  if (!info.valid) {
    currentGateway = null;
    currentOwnGateway = null;
  }
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
    const report = await serverReport();
    const res = await fetch(`${promptowlUrl}/api/license/validate`, {
      method: "POST",
      headers: config.PROMPTOWL_FETCH_HEADERS,
      body: JSON.stringify({ key, ...report }),
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
      limits?: LicenseInfo["limits"];
      gateway?: unknown;
      own_gateway?: unknown;
      suspended?: boolean;
      suspended_reason?: string;
      owner_email?: string | null;
      features?: unknown;
      // v2 (optional): reason, trial, expires_at, seats, contact
      [k: string]: unknown;
    };
    const features = sanitizeFeatures(data.features);
    lastMeta = parseMeta(data, report.stats?.users ?? null);
    lastCheckedAt = new Date().toISOString();
    if (data.owner_email) lastOwnerEmail = data.owner_email;
    else if (cached?.owner_email) lastOwnerEmail = cached.owner_email;

    // ── Kill switch: two-strike confirmation ──
    // Spec §9.4: two suspended answers inside one hour suspend the server —
    // with the 60s poll that is about a minute, and one stray answer can't.
    if (data.suspended === true) {
      if (
        !suspensionConfirmed &&
        (!suspensionFirstSeen ||
          Date.now() - suspensionFirstSeen > SUSPENSION_CONFIRM_WINDOW_MS)
      ) {
        // First strike (or the last one is over an hour old) — start the window
        suspensionFirstSeen = Date.now();
        suspensionReason = data.suspended_reason || "Suspended by PromptOwl";
        console.warn(
          `\n  WARNING: PromptOwl has flagged this server for suspension.`,
        );
        console.warn(
          `  Reason: ${suspensionReason}`,
        );
        console.warn(
          `  It is confirmed on the next check (about a minute). If this is an error,`,
        );
        console.warn(
          `  contact support@promptowl.ai to reverse it.\n`,
        );
      } else {
        // Second strike inside the window — confirm suspension (logged once)
        const announce = !suspensionConfirmed;
        suspensionConfirmed = true;
        suspensionReason = data.suspended_reason || "Suspended by PromptOwl";
        if (announce) {
          console.error(`\n  SERVER SUSPENDED: ${suspensionReason}`);
          console.error(`  Write operations are disabled. Reads still work.`);
          console.error(`  Contact support@promptowl.ai to resolve.\n`);
        }
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
        return withMeta({
          valid: false,
          tier: "none",
          org: null,
          limits: null,
          suspended: suspensionConfirmed,
          suspendedReason: suspensionReason,
          ownerEmail: data.owner_email || null,
        });
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
      return withMeta({
        valid: false,
        tier: "none",
        org: null,
        limits: null,
        suspended: false,
        suspendedReason: null,
        ownerEmail: data.owner_email || null,
      });
    }

    // Cache valid licenses
    if (data.valid) {
      rejectionStreak = 0;
      rejectionKey = null;
      const limitsJson = data.limits ? JSON.stringify(data.limits) : null;
      currentGateway = parseGateway(data.gateway);
      const gatewayJson = currentGateway
        ? await encryptSecret(JSON.stringify(currentGateway))
        : null;
      currentOwnGateway = parseOwnGateway(data.own_gateway);
      const ownGatewayJson = currentOwnGateway
        ? await encryptSecret(JSON.stringify(currentOwnGateway))
        : null;
      await db.run(
        insertOrReplace(
          db,
          `INSERT INTO license_cache (key, tier, org, limits_json, owner_email, features_json, gateway_json, own_gateway_json, validated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${nowExpr(db)})`,
          ["key"],
          `tier = excluded.tier, org = excluded.org, limits_json = excluded.limits_json, owner_email = excluded.owner_email, features_json = excluded.features_json, gateway_json = excluded.gateway_json, own_gateway_json = excluded.own_gateway_json, validated_at = ${nowExpr(db)}`,
        ),
        [
          key,
          data.tier || "community",
          data.org || null,
          limitsJson,
          data.owner_email || null,
          features ? JSON.stringify(features) : null,
          gatewayJson,
          ownGatewayJson,
        ],
      );
    }

    return withMeta({
      valid: data.valid !== false,
      tier: data.tier || "community",
      org: data.org || null,
      limits: data.limits || null,
      suspended: suspensionConfirmed,
      suspendedReason: suspensionReason,
      ownerEmail: data.owner_email || null,
      features,
    });
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
