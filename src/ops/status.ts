/**
 * Network & status — the server-side half of Settings → Network & status.
 *
 * `buildStatusReport` answers "is this server healthy, and how is it wired to
 * the network?" for an operator running it behind a firewall, VPN or proxy.
 * Every check carries a plain-language `fix` when it isn't green, so the page
 * reads as a runbook rather than a dashboard.
 *
 * Admin-only (the routes gate on serverAdminAllowed) and secret-free: nothing
 * here returns a credential, a connection string with its userinfo, or a
 * webhook path. Hosts and ports only — what a firewall rule needs.
 *
 * `/health` stays as it was: it is public, and none of this belongs on it.
 */
import { promises as fsp, constants as fsConstants } from "node:fs";
import path from "node:path";
import { getDb } from "../db/client.js";
import { HISTORICAL_MIGRATIONS } from "../db/migrations.postgres.js";
import { config } from "../config.js";
import { getCurrentLicense, getLastLicenseCheck, getModelGateway, getOfflineLock, getOwnGateway, isSuspended } from "../auth/license.js";
import { isOidcReady } from "../auth/oidc.js";
import { isEmailConfigured, transportSettings } from "../notify/email.js";
import { schedulerState } from "../workflow/scheduler.js";
import { SERVICE_VERSION } from "../shared/version.js";
import { isPrivateHost } from "../shared/private-host.js";

export type CheckState = "green" | "amber" | "red" | "off";

export interface StatusCheck {
  id: string;
  group: "data" | "license" | "network" | "services" | "runtime";
  label: string;
  state: CheckState;
  detail: string;
  /** What to do about it; present whenever state is amber or red. */
  fix?: string;
}

/** One host this server dials out to — a row in the egress allowlist. */
export interface EgressTarget {
  id: string;
  purpose: string;
  host: string;
  port: number;
  protocol: "https" | "smtp" | "postgres";
  /** The setting that decides it, for the operator who wants to change it. */
  configuredBy: string;
  /** Always needed, or only for the feature named in `purpose`. */
  required: boolean;
}

export interface AddressInfo {
  /** PUBLIC_BASE_URL when pinned; else what this request's origin looked like. */
  effectiveBaseUrl: string;
  pinned: boolean;
  requestOrigin: string;
  forwarded: { proto: string | null; host: string | null; for: string | null };
  privateHost: boolean;
}

export interface StatusReport {
  generatedAt: string;
  version: string;
  build: string | null;
  /** Port the app listens on — what a proxy, tunnel or port forward targets. */
  listenPort: number;
  checks: StatusCheck[];
  address: AddressInfo;
  egress: EgressTarget[];
}

/** Strip userinfo, query and fragment: `postgres://u:p@db:5432/x?ssl=1` → `postgres://db:5432/x`. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return "(unparseable URL)";
  }
}

function hostPort(raw: string, fallbackPort: number): { host: string; port: number } | null {
  try {
    const u = new URL(raw);
    if (!u.hostname) return null;
    return { host: u.hostname.replace(/^\[|\]$/g, ""), port: u.port ? Number(u.port) : fallbackPort };
  } catch {
    return null;
  }
}

const SMTP_DEFAULT_PORT: Record<string, number> = { "smtps:": 465, "smtp:": 587 };

/**
 * Every host the current configuration makes this server call, derived from
 * config only. This list is also the ONLY set the egress test will dial — no
 * request ever supplies a target.
 */
export function egressTargets(): EgressTarget[] {
  const out: EgressTarget[] = [];
  const add = (t: Omit<EgressTarget, "host" | "port">, url: string, port: number) => {
    const hp = hostPort(url, port);
    if (hp && !out.some((o) => o.host === hp.host && o.port === hp.port && o.protocol === t.protocol)) {
      out.push({ ...t, ...hp });
    }
  };

  add(
    {
      id: "promptowl",
      purpose: "License checks, PromptOwl sign-in, team import",
      protocol: "https",
      configuredBy: "PROMPTOWL_API_URL",
      required: true,
    },
    config.PROMPTOWL_API_URL,
    443,
  );
  const gw = getModelGateway();
  if (gw) {
    add(
      { id: "model-gateway", purpose: "AI model calls (PromptOwl credits)", protocol: "https", configuredBy: "your license", required: false },
      gw.baseUrl,
      443,
    );
  }
  const own = getOwnGateway();
  if (own) {
    add(
      { id: "own-gateway", purpose: "AI model calls (your own provider keys)", protocol: "https", configuredBy: "Settings → Hootie", required: false },
      own.baseUrl,
      443,
    );
  }
  add(
    { id: "anthropic", purpose: "AI model calls with a nest's own Anthropic key", protocol: "https", configuredBy: "a nest's model key", required: false },
    "https://api.anthropic.com",
    443,
  );
  if (config.OIDC_ISSUER) {
    add(
      { id: "oidc", purpose: "Single sign-on (discovery, keys, token exchange)", protocol: "https", configuredBy: "OIDC_ISSUER", required: config.OIDC_ENABLED },
      config.OIDC_ISSUER,
      443,
    );
  }
  const mail = transportSettings();
  if (mail?.provider === "smtp") {
    let port = 587;
    try {
      port = SMTP_DEFAULT_PORT[new URL(mail.url).protocol] ?? 587;
    } catch {
      // add() below drops an unparseable URL
    }
    add({ id: "smtp", purpose: "Email (invites, review requests)", protocol: "smtp", configuredBy: "SMTP_URL", required: false }, mail.url, port);
  } else if (mail?.provider === "ses") {
    add(
      { id: "ses", purpose: "Email via Amazon SES", protocol: "https", configuredBy: "SES_REGION", required: false },
      `https://email.${mail.region}.amazonaws.com`,
      443,
    );
  }
  for (const [id, url, label] of [
    ["slack", config.SLACK_WEBHOOK_URL, "Slack notifications"],
    ["teams", config.MSTEAMS_WEBHOOK_URL, "Microsoft Teams notifications"],
  ] as const) {
    if (url) {
      add(
        { id, purpose: label, protocol: "https", configuredBy: id === "slack" ? "SLACK_WEBHOOK_URL" : "MSTEAMS_WEBHOOK_URL", required: false },
        url,
        443,
      );
    }
  }
  if (config.TELEMETRY_ENABLED) {
    add(
      { id: "posthog", purpose: "Usage telemetry (optional)", protocol: "https", configuredBy: "POSTHOG_HOST / TELEMETRY_ENABLED", required: false },
      config.POSTHOG_HOST,
      443,
    );
  }
  if (config.DB_DRIVER === "postgres" && !config.CLOUD_SQL_CONNECTION_NAME) {
    const url = config.DATABASE_URL || `postgres://${config.DB_HOST || "localhost"}:${config.DB_PORT}`;
    add({ id: "postgres", purpose: "Database", protocol: "postgres", configuredBy: config.DATABASE_URL ? "DATABASE_URL" : "DB_HOST / DB_PORT", required: true }, url, 5432);
  }
  return out;
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function bytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

async function databaseChecks(): Promise<StatusCheck[]> {
  const checks: StatusCheck[] = [];
  const db = getDb();
  const driver = db.dialect === "postgres" ? "Postgres" : "SQLite";
  const where =
    db.dialect === "postgres"
      ? config.CLOUD_SQL_CONNECTION_NAME
        ? `Cloud SQL ${config.CLOUD_SQL_CONNECTION_NAME}`
        : config.DATABASE_URL
          ? redactUrl(config.DATABASE_URL)
          : `${config.DB_HOST || "localhost"}:${config.DB_PORT}/${config.DB_NAME || ""}`
      : config.DATABASE_PATH;

  const t0 = performance.now();
  try {
    await db.get("SELECT 1 AS ok");
    const ms = Math.round(performance.now() - t0);
    checks.push({
      id: "db",
      group: "data",
      label: "Database",
      state: ms > 500 ? "amber" : "green",
      detail: `${driver} at ${where} — answered in ${ms} ms`,
      ...(ms > 500 && {
        fix: "Slow round trip. For Postgres, put the server and database in the same region or network; check the database's CPU and connection count.",
      }),
    });
  } catch (err) {
    checks.push({
      id: "db",
      group: "data",
      label: "Database",
      state: "red",
      detail: `${driver} at ${where} — ${(err as Error).message}`,
      fix:
        db.dialect === "postgres"
          ? "Check DATABASE_URL (or DB_HOST/DB_PORT), that the database accepts connections from this server's address, and DB_SSL/DB_SSL_CA if it requires TLS."
          : "Check that DATABASE_PATH is on a writable, mounted volume.",
    });
    return checks;
  }

  // Migration head: the newest numbered migration recorded vs. the newest this build knows.
  const expected = HISTORICAL_MIGRATIONS.filter((id) => /^\d{3}_/.test(id)).sort().at(-1) ?? null;
  try {
    const rows = await db.all<{ id: string }>("SELECT id FROM schema_migrations");
    const applied = rows.map((r) => r.id).filter((id) => /^\d{3}_/.test(id)).sort().at(-1) ?? null;
    const behind = !!expected && (!applied || applied < expected);
    // Newer than this build: an older image was rolled back onto a migrated database.
    const ahead = !!expected && !!applied && applied > expected;
    checks.push({
      id: "migrations",
      group: "data",
      label: "Schema migrations",
      state: behind || ahead ? "amber" : "green",
      detail: behind
        ? `Database is at ${applied ?? "none"}; this build expects ${expected}`
        : ahead
          ? `Database is at ${applied}, newer than this build (${expected})`
          : `Up to date (${applied})`,
      ...(behind && {
        fix: "Restart the server so it applies pending migrations at startup. If it keeps falling behind, look for a migration error in the startup log.",
      }),
      ...(ahead && {
        fix: "A newer version migrated this database. Run that version again (or newer); an older build may misread the schema.",
      }),
    });
  } catch (err) {
    checks.push({
      id: "migrations",
      group: "data",
      label: "Schema migrations",
      state: "red",
      detail: `Couldn't read schema_migrations: ${(err as Error).message}`,
      fix: "The database may not have been initialised by this server. Check the startup log.",
    });
  }

  if (db.dialect === "sqlite") {
    let size = 0;
    for (const f of [config.DATABASE_PATH, `${config.DATABASE_PATH}-wal`]) {
      size += await fsp.stat(f).then((s) => s.size, () => 0);
    }
    checks.push({
      id: "db-size",
      group: "data",
      label: "Database file",
      state: "green",
      detail: `${bytes(size)} (including the write-ahead log). Back this file up with the nest folder — there is no built-in backup.`,
    });
  }
  return checks;
}

async function diskChecks(): Promise<StatusCheck[]> {
  const checks: StatusCheck[] = [];
  try {
    const s = await fsp.statfs(config.DATA_ROOT);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const pct = total > 0 ? (free / total) * 100 : 100;
    const state: CheckState = pct < 3 ? "red" : pct < 10 ? "amber" : "green";
    checks.push({
      id: "disk",
      group: "data",
      label: "Disk space",
      state,
      detail: `${bytes(free)} free of ${bytes(total)} (${pct.toFixed(0)}%) on the volume holding DATA_ROOT`,
      ...(state !== "green" && {
        fix: "Grow the volume or move DATA_ROOT to a larger one. SQLite and nest files stop accepting writes when the disk fills.",
      }),
    });
  } catch (err) {
    checks.push({
      id: "disk",
      group: "data",
      label: "Disk space",
      state: "amber",
      detail: `Couldn't read free space for DATA_ROOT: ${(err as Error).message}`,
      fix: "Check that DATA_ROOT exists and is mounted.",
    });
  }
  try {
    // Read-only check. The folder is created with the first nest, so until then test its nearest existing parent.
    let dir = config.NEST_STORAGE_ROOT;
    while (!(await fsp.stat(dir).then(() => true, () => false)) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    await fsp.access(dir, fsConstants.W_OK);
    const detail = dir === config.NEST_STORAGE_ROOT ? `Writable: ${dir}` : `${config.NEST_STORAGE_ROOT} is created with the first nest; ${dir} is writable`;
    checks.push({ id: "storage", group: "data", label: "Nest storage", state: "green", detail });
  } catch (err) {
    checks.push({
      id: "storage",
      group: "data",
      label: "Nest storage",
      state: "red",
      detail: `${config.NEST_STORAGE_ROOT} is not writable: ${(err as Error).message}`,
      fix: "Give the server's user write access to NEST_STORAGE_ROOT (in Docker: mount the volume and check its owner).",
    });
  }
  return checks;
}

/** What /readyz gates on: the database answers and nest storage is writable.
 *  Same checks as the status page; states only, so it is safe to serve publicly. */
export async function readiness(): Promise<{ ready: boolean; checks: { db: boolean; storage: boolean } }> {
  const all = [...(await databaseChecks()), ...(await diskChecks())];
  const ok = (id: string) => all.find((c) => c.id === id)?.state !== "red";
  const checks = { db: ok("db"), storage: ok("storage") };
  return { ready: checks.db && checks.storage, checks };
}

function licenseCheck(now: number): StatusCheck {
  const lic = getCurrentLicense();
  const last = getLastLicenseCheck();
  const lastTxt = last ? `last checked with PromptOwl ${ago(last, now)}` : "not checked with PromptOwl since this server started";
  if (isSuspended() || lic?.suspended) {
    return {
      id: "license",
      group: "license",
      label: "License",
      state: "red",
      detail: `Suspended${lic?.suspendedReason ? `: ${lic.suspendedReason}` : ""} — ${lastTxt}`,
      fix: "See Settings → License for the reason and who to contact.",
    };
  }
  if (!lic?.valid) {
    return {
      id: "license",
      group: "license",
      label: "License",
      state: "red",
      detail: `No valid license — ${lastTxt}`,
      fix: "Install a key in Settings → License. Without one, everything except reads is refused.",
    };
  }
  const egress = `Allow outbound HTTPS to ${hostPort(config.PROMPTOWL_API_URL, 443)?.host ?? "PromptOwl"} — see the egress table below.`;
  const offlineSince = getOfflineLock();
  if (offlineSince) {
    return {
      id: "license",
      group: "license",
      label: "License",
      state: "red",
      detail: `Read-only: PromptOwl unreachable since the last good check at ${offlineSince} (24-hour offline limit)`,
      fix: `${egress} Writing comes back on the next successful check.`,
    };
  }
  const stale = !last || now - Date.parse(last) > 24 * 3600_000;
  return {
    id: "license",
    group: "license",
    label: "License",
    state: stale ? "amber" : "green",
    detail: `Valid (${lic.tier}) — ${lastTxt}`,
    ...(stale && {
      fix: `The server can't reach PromptOwl to re-check its license. ${egress} It goes read-only 24 hours after the last successful check.`,
    }),
  };
}

function servicesChecks(now: number): StatusCheck[] {
  const checks: StatusCheck[] = [];
  checks.push(
    isEmailConfigured()
      ? { id: "email", group: "services", label: "Email", state: "green", detail: `Sending via ${config.EMAIL_PROVIDER.toUpperCase()} from ${config.NOTIFY_EMAIL_FROM}` }
      : {
          id: "email",
          group: "services",
          label: "Email",
          state: "amber",
          detail: "Not configured — invites, review requests and email-gated links can't be sent",
          fix: "Set up SMTP or SES in Settings → Notifications, then send a test from there.",
        },
  );

  if (!config.OIDC_ENABLED) {
    checks.push({ id: "oidc", group: "services", label: "Single sign-on", state: "off", detail: "Off" });
  } else {
    checks.push(
      isOidcReady()
        ? { id: "oidc", group: "services", label: "Single sign-on", state: "green", detail: `On — issuer ${redactUrl(config.OIDC_ISSUER)}. Use "Test discovery" to confirm this server can reach it.` }
        : {
            id: "oidc",
            group: "services",
            label: "Single sign-on",
            state: "red",
            detail: "On, but the issuer, client ID or client secret is missing — the SSO button is hidden",
            fix: "Finish the setup in Settings → Single sign-on, or follow the Entra walkthrough below.",
          },
    );
  }

  if (!config.FEATURE_WORKFLOW_PLANE) {
    checks.push({ id: "scheduler", group: "services", label: "Workflow scheduler", state: "off", detail: "Workflow plane is off" });
  } else {
    const s = schedulerState();
    const fresh = !!s.lastTickAt && now - Date.parse(s.lastTickAt) < 3 * 60_000;
    checks.push(
      !s.running
        ? {
            id: "scheduler",
            group: "services",
            label: "Workflow scheduler",
            state: "red",
            detail: "Enabled but not running",
            fix: "Restart the server; the scheduler starts at boot when the workflow plane is on.",
          }
        : s.lastTickError
          ? {
              id: "scheduler",
              group: "services",
              label: "Workflow scheduler",
              state: "amber",
              detail: `Last tick failed ${ago(s.lastTickAt!, now)}: ${s.lastTickError}`,
              fix: "Check the server log for [scheduler] errors.",
            }
          : {
              id: "scheduler",
              group: "services",
              label: "Workflow scheduler",
              state: fresh || !s.lastTickAt ? "green" : "amber",
              detail: s.lastTickAt ? `Last tick ${ago(s.lastTickAt, now)}` : "Running — first tick within a minute of startup",
              ...(!fresh && s.lastTickAt && { fix: "Ticks run every minute. A stale tick usually means the process is overloaded or paused (e.g. a CPU-throttled Cloud Run instance)." }),
            },
    );
  }
  return checks;
}

function addressInfo(reqUrl: string, header: (name: string) => string | undefined): AddressInfo {
  let requestOrigin = "";
  try {
    requestOrigin = new URL(reqUrl).origin;
  } catch {
    // leave blank
  }
  const pinned = !!config.PUBLIC_BASE_URL;
  const effectiveBaseUrl = config.PUBLIC_BASE_URL ? redactUrl(config.PUBLIC_BASE_URL) : requestOrigin;
  return {
    effectiveBaseUrl,
    pinned,
    requestOrigin,
    forwarded: {
      proto: header("x-forwarded-proto") ?? null,
      host: header("x-forwarded-host") ?? null,
      for: header("x-forwarded-for") ? "present" : null,
    },
    privateHost: isPrivateHost(effectiveBaseUrl),
  };
}

function addressCheck(a: AddressInfo): StatusCheck {
  if (!a.pinned) {
    return {
      id: "base-url",
      group: "network",
      label: "Public address",
      state: "amber",
      detail: `Not set — links and connector setup use whatever address each request arrived on (${a.requestOrigin || "unknown"})`,
      fix: "Set the public base URL in Settings → Basic to the address people and agents use (e.g. https://nest.example.com). Required behind a reverse proxy and for Agent OAuth.",
    };
  }
  let pinnedUrl: URL | null = null;
  try {
    pinnedUrl = new URL(config.PUBLIC_BASE_URL);
  } catch {
    // shape is validated on save; treat as mismatch below
  }
  if (pinnedUrl?.protocol === "http:" && !isPrivateHost(config.PUBLIC_BASE_URL)) {
    return {
      id: "base-url",
      group: "network",
      label: "Public address",
      state: "red",
      detail: `${redactUrl(config.PUBLIC_BASE_URL)} is plain HTTP on a public name`,
      fix: "Serve the server over HTTPS (reverse proxy or tunnel) and update the public base URL. Sign-in cookies and API keys travel in the clear otherwise.",
    };
  }
  if (a.privateHost) {
    return {
      id: "base-url",
      group: "network",
      label: "Public address",
      state: "amber",
      detail: `${redactUrl(config.PUBLIC_BASE_URL)} is a private-network address`,
      fix: "People on your network and Claude Code work. Hosted connectors (claude.ai, ChatGPT) can't reach it — see the VPN-only scenario below.",
    };
  }
  const reqHost = (() => {
    try {
      return new URL(a.requestOrigin).host;
    } catch {
      return "";
    }
  })();
  if (pinnedUrl && reqHost && pinnedUrl.host !== reqHost && !a.forwarded.host) {
    return {
      id: "base-url",
      group: "network",
      label: "Public address",
      state: "amber",
      detail: `Set to ${redactUrl(config.PUBLIC_BASE_URL)}, but this page was loaded via ${a.requestOrigin}`,
      fix: "Fine if you're on an internal address on purpose. Otherwise make sure your proxy or DNS sends people to the public base URL.",
    };
  }
  return { id: "base-url", group: "network", label: "Public address", state: "green", detail: redactUrl(config.PUBLIC_BASE_URL) };
}

export async function buildStatusReport(reqUrl: string, header: (name: string) => string | undefined): Promise<StatusReport> {
  const now = Date.now();
  const address = addressInfo(reqUrl, header);
  const build = config.GIT_SHA || null;
  const checks: StatusCheck[] = [
    ...(await databaseChecks()),
    ...(await diskChecks()),
    licenseCheck(now),
    addressCheck(address),
    ...servicesChecks(now),
    {
      id: "version",
      group: "runtime",
      label: "Version",
      state: "green",
      detail: `ContextNest Community ${SERVICE_VERSION}${build ? ` (build ${build.slice(0, 12)})` : ""}, Node ${process.versions.node}, auth mode ${config.AUTH_MODE}`,
    },
  ];
  return {
    generatedAt: new Date(now).toISOString(),
    version: SERVICE_VERSION,
    build,
    listenPort: config.PORT,
    checks,
    address,
    egress: egressTargets(),
  };
}
