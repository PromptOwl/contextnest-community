import { existsSync } from "node:fs";
import { bootEnv, bootExecArgv } from "./boot-env.js";

/**
 * Corporate egress proxy + custom CA support — status and startup messages.
 *
 * Outbound HTTP(S) (licensing, PromptOwl sign-in, model providers, OIDC,
 * Slack/Teams webhooks, telemetry) all goes through Node's built-in fetch.
 * Node routes fetch through HTTPS_PROXY / HTTP_PROXY (honouring NO_PROXY) when
 * env-proxy support is on: NODE_USE_ENV_PROXY=1 or --use-env-proxy, on
 * Node ≥ 22.21 or ≥ 24.5. The Docker image sets NODE_USE_ENV_PROXY=1. No extra
 * dependency is involved.
 *
 * NOT proxied: SMTP (nodemailer opens raw TCP), Postgres (pg), and — on
 * purpose — metacognition feed / MCP fetches (metacognition/net.ts), whose
 * SSRF check must resolve the host itself, which a proxy would do instead.
 */

export interface ProxyEnv {
  HTTPS_PROXY?: string;
  HTTP_PROXY?: string;
  NO_PROXY?: string;
  NODE_USE_ENV_PROXY?: string;
}

export interface EgressProxyStatus {
  /** A proxy URL is configured (now, from any source). */
  configured: boolean;
  /** Node will actually route fetch through it. */
  active: boolean;
  https?: string;
  http?: string;
  noProxy?: string;
  /** Why a configured proxy is NOT active, with the fix. */
  problem?: string;
}

/** Strip credentials from a proxy URL for display: http://user:pw@h:3128 → http://***@h:3128 */
export function redactProxyUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "";
    }
    return u.toString().replace(/\/$/, "");
  } catch {
    return "(unparseable proxy URL)";
  }
}

/** Node versions whose built-in fetch honours NODE_USE_ENV_PROXY. */
export function nodeSupportsEnvProxy(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major === 22) return minor >= 21;
  if (major === 24) return minor >= 5;
  return major >= 25;
}

function pick(env: Record<string, string | undefined>, upper: string): string | undefined {
  return env[upper] || env[upper.toLowerCase()] || undefined;
}

export function egressProxyStatus(opts: {
  boot: Record<string, string | undefined>;
  live: Record<string, string | undefined>;
  execArgv: readonly string[];
  version: string;
}): EgressProxyStatus {
  const liveHttps = pick(opts.live, "HTTPS_PROXY");
  const liveHttp = pick(opts.live, "HTTP_PROXY");
  const configured = !!(liveHttps || liveHttp);
  const status: EgressProxyStatus = {
    configured,
    active: false,
    ...(liveHttps ? { https: redactProxyUrl(liveHttps) } : {}),
    ...(liveHttp ? { http: redactProxyUrl(liveHttp) } : {}),
    ...(pick(opts.live, "NO_PROXY") ? { noProxy: pick(opts.live, "NO_PROXY") } : {}),
  };
  if (!configured) return status;

  const atBoot = !!(pick(opts.boot, "HTTPS_PROXY") || pick(opts.boot, "HTTP_PROXY"));
  const enabled = opts.boot.NODE_USE_ENV_PROXY === "1" || opts.execArgv.includes("--use-env-proxy");
  if (!nodeSupportsEnvProxy(opts.version)) {
    status.problem = `Node ${opts.version} can't route fetch through a proxy. Run Node ≥ 22.21 (the Docker image does).`;
  } else if (!atBoot) {
    status.problem =
      "The proxy is set only in .env, which loads after Node has configured networking. Set HTTPS_PROXY / HTTP_PROXY / NO_PROXY in the process environment (docker -e, systemd Environment=, or your shell).";
  } else if (!enabled) {
    status.problem =
      "Node's proxy support is off. Set NODE_USE_ENV_PROXY=1 in the process environment (the Docker image sets it), or start with node --use-env-proxy.";
  } else {
    status.active = true;
  }
  return status;
}

export interface ExtraCaStatus {
  set: boolean;
  path?: string;
  /** Set at process start — Node ignores it otherwise. */
  atBoot: boolean;
  exists: boolean;
  problem?: string;
}

/** NODE_EXTRA_CA_CERTS — the PEM bundle a TLS-inspecting proxy re-signs with. */
export function extraCaStatus(opts: {
  boot: Record<string, string | undefined>;
  live: Record<string, string | undefined>;
  fileExists?: (p: string) => boolean;
}): ExtraCaStatus {
  const path = opts.live.NODE_EXTRA_CA_CERTS || undefined;
  if (!path) return { set: false, atBoot: false, exists: false };
  const atBoot = opts.boot.NODE_EXTRA_CA_CERTS === path;
  const exists = (opts.fileExists ?? existsSync)(path);
  const status: ExtraCaStatus = { set: true, path, atBoot, exists };
  if (!exists) status.problem = `NODE_EXTRA_CA_CERTS points at ${path}, which doesn't exist.`;
  else if (!atBoot)
    status.problem = "NODE_EXTRA_CA_CERTS is set only in .env; Node reads it at process start. Set it in the process environment.";
  return status;
}

/** Current process status, for startup logs and the admin status surface. */
export function currentEgressProxyStatus(): EgressProxyStatus {
  return egressProxyStatus({ boot: bootEnv, live: process.env, execArgv: bootExecArgv, version: process.version });
}

export function currentExtraCaStatus(): ExtraCaStatus {
  return extraCaStatus({ boot: bootEnv, live: process.env });
}

/** Startup lines describing proxy / CA state. Empty when neither is configured. */
export function networkStartupLines(proxy: EgressProxyStatus, ca: ExtraCaStatus): { info: string[]; warn: string[] } {
  const info: string[] = [];
  const warn: string[] = [];
  if (proxy.configured) {
    const where = [proxy.https && `https → ${proxy.https}`, proxy.http && `http → ${proxy.http}`]
      .filter(Boolean)
      .join(", ");
    if (proxy.active) {
      info.push(`  Egress proxy: ${where}${proxy.noProxy ? ` (bypass: ${proxy.noProxy})` : ""} — SMTP, Postgres and agent feed/MCP fetches connect directly`);
    } else {
      warn.push(`  ⚠️  Egress proxy configured (${where}) but NOT in use: ${proxy.problem}`);
    }
  }
  if (ca.set) {
    if (ca.problem) warn.push(`  ⚠️  ${ca.problem}`);
    else info.push(`  Extra CA certificates: ${ca.path}`);
  }
  return { info, warn };
}
