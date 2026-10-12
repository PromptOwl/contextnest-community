/**
 * Active network probes for Settings → Network & status.
 *
 * - `runEgressChecks`: dial every host in `egressTargets()` and report how far
 *   each got — DNS, TCP, TLS, HTTP. The list comes from config only; nothing
 *   in a request can add or change a target, so this can't be pointed at an
 *   arbitrary host (no SSRF). Redirects are never followed.
 * - `runInboundCheck`: resolve the saved public base URL and fetch its
 *   /health over verified TLS. Proves the name resolves and serves a valid
 *   certificate FROM THIS SERVER — not that the internet can reach it.
 * - `runOidcDiscoveryCheck`: fetch the configured issuer's discovery document.
 *
 * Results carry hosts, ports, timings and error text — never credentials.
 */
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import { config } from "../config.js";
import { isPrivateAddress } from "../metacognition/net.js";
import { transportSettings, verifyEmailTransport } from "../notify/email.js";
import { SERVICE_VERSION } from "../shared/version.js";
import { currentEgressProxyStatus, type EgressProxyStatus } from "../shared/egress-proxy.js";
import { egressTargets, redactUrl, type EgressTarget } from "./status.js";

export const PROBE_TIMEOUT_MS = 5_000;

export type StageName = "dns" | "tcp" | "tls" | "http" | "smtp";

export interface Stage {
  stage: StageName;
  ok: boolean;
  ms: number;
  detail: string;
}

export interface ProbeResult {
  id: string;
  purpose: string;
  host: string;
  port: number;
  ok: boolean;
  stages: Stage[];
  /** Short operator-facing explanation of the first failed stage. */
  hint?: string;
}

export interface EgressReport {
  ranAt: string;
  /** HTTPS probes went through this proxy (credentials stripped); null = direct. */
  proxy: string | null;
  /** A proxy is configured but Node isn't using it — why, and the fix. */
  proxyProblem: string | null;
  results: ProbeResult[];
  /** Seconds this server's clock differs from PromptOwl's (positive = ahead), when measurable. */
  clockSkewSeconds: number | null;
}

/** Test seam: everything that touches the network. */
export interface NetIO {
  lookup(host: string): Promise<Array<{ address: string; family: number }>>;
  tcp(host: string, port: number, timeoutMs: number): Promise<void>;
  tls(host: string, port: number, timeoutMs: number): Promise<{ authorized: boolean; error?: string; validTo?: string }>;
  httpGet(url: string, timeoutMs: number): Promise<{ status: number; date: string | null; body: string }>;
  smtpVerify(): Promise<{ ok: true } | { ok: false; error: string }>;
  /** fetch(), which Node routes through HTTPS_PROXY when env-proxy support is on. */
  proxiedGet(url: string, timeoutMs: number): Promise<{ status: number; date: string | null; body: string }>;
  /** Egress proxy state, as the server's own fetch sees it. */
  proxy(): EgressProxyStatus;
}

/** Whether NO_PROXY sends this host direct, the way Node's env proxy decides it. */
export function bypassesProxy(host: string, port: number, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const h = host.toLowerCase();
  return noProxy.split(/[\s,]+/).some((raw) => {
    if (raw === "*") return true;
    const m = /^(.*?)(?::(\d+))?$/.exec(raw.toLowerCase())!;
    if (m[2] && Number(m[2]) !== port) return false;
    const entry = m[1].replace(/^\*?\./, "");
    return !!entry && (h === entry || h.endsWith(`.${entry}`));
  });
}

/** A host as it goes in a URL: IPv6 literals need brackets. */
const urlHost = (host: string) => (net.isIPv6(host) ? `[${host}]` : host);

/** Rejects after `ms` whatever `p` is doing; `onTimeout` releases its socket. */
export function withDeadline<T>(p: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${what} took longer than ${ms / 1000}s`));
    }, ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** GET the way the server's own fetch would reach this URL: via the egress proxy unless NO_PROXY says direct. */
function getLikeServer(io: NetIO, url: string) {
  const p = io.proxy();
  const u = new URL(url);
  const proxied = p.active && !bypassesProxy(u.hostname.replace(/^\[|\]$/g, ""), Number(u.port) || 443, p.noProxy);
  return proxied ? io.proxiedGet(url, PROBE_TIMEOUT_MS) : io.httpGet(url, PROBE_TIMEOUT_MS);
}

const realIO: NetIO = {
  lookup: (host) => withDeadline(dns.promises.lookup(host, { all: true, verbatim: true }), PROBE_TIMEOUT_MS, "DNS lookup"),
  tcp: (host, port, timeoutMs) =>
    new Promise((resolve, reject) => {
      const sock = net.connect({ host, port });
      const done = (err?: Error) => {
        sock.destroy();
        err ? reject(err) : resolve();
      };
      sock.setTimeout(timeoutMs, () => done(new Error(`no answer within ${timeoutMs / 1000}s`)));
      sock.once("connect", () => done());
      sock.once("error", (e) => done(e));
    }),
  tls: (host, port, timeoutMs) =>
    new Promise((resolve, reject) => {
      const sock = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
      sock.setTimeout(timeoutMs, () => {
        sock.destroy();
        reject(new Error(`TLS handshake took longer than ${timeoutMs / 1000}s`));
      });
      sock.once("secureConnect", () => {
        const cert = sock.getPeerCertificate();
        const out = {
          authorized: sock.authorized,
          ...(sock.authorizationError ? { error: String(sock.authorizationError) } : {}),
          ...(cert?.valid_to ? { validTo: cert.valid_to } : {}),
        };
        sock.destroy();
        resolve(out);
      });
      sock.once("error", (e) => {
        sock.destroy();
        reject(e);
      });
    }),
  httpGet: (url, timeoutMs) => {
    let req: ReturnType<typeof https.request> | undefined;
    // The socket timeout only fires when idle; the deadline also stops a slow-drip body.
    return withDeadline(new Promise((resolve, reject) => {
      // https.request never follows redirects; certificate checks stay on.
      req = https.request(url, { method: "GET", timeout: timeoutMs, headers: { Accept: "application/json" } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length < 16_384) body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, date: (res.headers.date as string) ?? null, body }));
        res.on("error", reject);
      });
      req.on("timeout", () => req!.destroy(new Error(`no response within ${timeoutMs / 1000}s`)));
      req.on("error", reject);
      req.end();
    }), timeoutMs, "The request", () => req?.destroy());
  },
  smtpVerify: async () => {
    const s = transportSettings();
    return s ? verifyEmailTransport(s) : { ok: false, error: "email is not configured" };
  },
  proxiedGet: async (url, timeoutMs) => {
    // The abort signal covers the body read too, so a slow drip can't outlast the timeout.
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
    let body = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body ?? []) {
      body += decoder.decode(chunk, { stream: true });
      if (body.length >= 16_384) break; // breaking the loop cancels the stream
    }
    return { status: res.status, date: res.headers.get("date"), body };
  },
  proxy: currentEgressProxyStatus,
};

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: Error; ms: number }> {
  const t0 = performance.now();
  try {
    const value = await fn();
    return { value, ms: Math.round(performance.now() - t0) };
  } catch (error) {
    return { error: error as Error, ms: Math.round(performance.now() - t0) };
  }
}

const HINTS: Record<StageName, string> = {
  dns: "This server can't resolve the name. Check its DNS servers, or whether outbound DNS is blocked.",
  tcp: "The name resolves but the connection is blocked or dropped. Allow outbound traffic to this host and port in your firewall, or route it through your egress proxy.",
  tls: "Connected, but the certificate wasn't trusted. A TLS-inspecting proxy is the usual cause — give the server your proxy's CA with NODE_EXTRA_CA_CERTS.",
  http: "Connected over TLS, but the HTTP request failed. A proxy or WAF may be rejecting it.",
  smtp: "The mail server answered but refused the login or the connection. Check SMTP_URL (host, port, credentials) in Settings → Notifications.",
};

async function probe(t: EgressTarget, io: NetIO, proxy: string | null): Promise<{ result: ProbeResult; date: string | null }> {
  const stages: Stage[] = [];
  let date: string | null = null;
  const finish = (ok: boolean, failed?: StageName, hint?: string) => ({
    result: { id: t.id, purpose: t.purpose, host: t.host, port: t.port, ok, stages, ...(failed && { hint: hint ?? HINTS[failed] }) },
    date,
  });

  // Behind an egress proxy the proxy does DNS, TCP and TLS to the target, so
  // dialling directly would report a false "blocked". Probe the way the
  // server's own traffic goes: one fetch through the proxy. SMTP and Postgres
  // aren't proxied (raw sockets), so they still go direct below.
  if (proxy && t.protocol === "https") {
    const h = await timed(() => io.proxiedGet(`https://${urlHost(t.host)}${t.port === 443 ? "" : `:${t.port}`}/`, PROBE_TIMEOUT_MS));
    if (h.error) {
      const cause = (h.error as Error & { cause?: Error }).cause?.message ?? h.error.message;
      stages.push({ stage: "http", ok: false, ms: h.ms, detail: `via ${proxy}: ${cause}` });
      return finish(
        false,
        "http",
        /certificate|self[- ]signed|CERT_/i.test(cause)
          ? HINTS.tls
          : "The proxy refused or couldn't reach this host. Add it to the proxy's allowlist, or to NO_PROXY if it should go direct.",
      );
    }
    date = h.value!.date;
    stages.push({ stage: "http", ok: true, ms: h.ms, detail: `HTTP ${h.value!.status} via ${proxy}` });
    return finish(true);
  }

  const d = await timed(() => io.lookup(t.host));
  if (d.error || !d.value?.length) {
    stages.push({ stage: "dns", ok: false, ms: d.ms, detail: d.error?.message ?? "no addresses" });
    return finish(false, "dns");
  }
  const addrs = d.value.map((a) => a.address);
  const priv = addrs.some((a) => isPrivateAddress(a));
  stages.push({ stage: "dns", ok: true, ms: d.ms, detail: `${addrs.slice(0, 3).join(", ")}${priv ? " (private network)" : ""}` });

  if (t.protocol === "smtp") {
    const s = await timed(() => io.smtpVerify());
    const ok = !!s.value?.ok;
    stages.push({
      stage: "smtp",
      ok,
      ms: s.ms,
      detail: ok ? "Connected and authenticated" : s.error?.message ?? (s.value as { error: string } | undefined)?.error ?? "failed",
    });
    return finish(ok, ok ? undefined : "smtp");
  }

  const c = await timed(() => io.tcp(t.host, t.port, PROBE_TIMEOUT_MS));
  stages.push({ stage: "tcp", ok: !c.error, ms: c.ms, detail: c.error ? c.error.message : `Connected to port ${t.port}` });
  if (c.error) return finish(false, "tcp");
  if (t.protocol === "postgres") return finish(true);

  const s = await timed(() => io.tls(t.host, t.port, PROBE_TIMEOUT_MS));
  const trusted = !!s.value?.authorized;
  stages.push({
    stage: "tls",
    ok: trusted,
    ms: s.ms,
    detail: s.error ? s.error.message : trusted ? `Certificate valid${s.value?.validTo ? ` until ${s.value.validTo}` : ""}` : `Untrusted certificate: ${s.value?.error ?? "unknown reason"}`,
  });
  if (!trusted) return finish(false, "tls");

  // Origin only: webhook paths carry secrets, and reachability is all we're proving.
  const h = await timed(() => io.httpGet(`https://${urlHost(t.host)}${t.port === 443 ? "" : `:${t.port}`}/`, PROBE_TIMEOUT_MS));
  if (h.error) {
    stages.push({ stage: "http", ok: false, ms: h.ms, detail: h.error.message });
    return finish(false, "http");
  }
  date = h.value!.date;
  // Any HTTP answer — even 404 or 405 — proves the path is open end to end.
  stages.push({ stage: "http", ok: true, ms: h.ms, detail: `HTTP ${h.value!.status}` });
  return finish(true);
}

export async function runEgressChecks(io: NetIO = realIO): Promise<EgressReport> {
  const targets = egressTargets();
  const p = io.proxy();
  const proxy = p.active ? (p.https ?? p.http ?? null) : null;
  const probed = await Promise.all(
    targets.map((t) => probe(t, io, proxy && !bypassesProxy(t.host, t.port, p.noProxy) ? proxy : null)),
  );
  const promptowl = probed.find((p) => p.result.id === "promptowl");
  let clockSkewSeconds: number | null = null;
  if (promptowl?.date) {
    const theirs = Date.parse(promptowl.date);
    if (Number.isFinite(theirs)) clockSkewSeconds = Math.round((Date.now() - theirs) / 1000);
  }
  return {
    ranAt: new Date().toISOString(),
    proxy,
    proxyProblem: p.problem ?? null,
    results: probed.map((r) => r.result),
    clockSkewSeconds,
  };
}

export interface InboundReport {
  ranAt: string;
  url: string | null;
  ok: boolean;
  stages: Stage[];
  privateAddresses: boolean;
  note: string;
  hint?: string;
}

const INBOUND_NOTE =
  "Checked from this server, not from the internet. A pass means the name resolves and serves a valid certificate here; outside reachability also depends on your firewall and DNS as seen from outside.";

export async function runInboundCheck(io: NetIO = realIO): Promise<InboundReport> {
  const base = config.PUBLIC_BASE_URL;
  const ranAt = new Date().toISOString();
  if (!base) {
    return {
      ranAt,
      url: null,
      ok: false,
      stages: [],
      privateAddresses: false,
      note: INBOUND_NOTE,
      hint: "Set the public base URL in Settings → Basic first; this check tests that saved address.",
    };
  }
  const u = new URL(base);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const stages: Stage[] = [];
  const d = await timed(() => (net.isIP(host) ? Promise.resolve([{ address: host, family: net.isIP(host) }]) : io.lookup(host)));
  if (d.error || !d.value?.length) {
    stages.push({ stage: "dns", ok: false, ms: d.ms, detail: d.error?.message ?? "no addresses" });
    return { ranAt, url: redactUrl(base), ok: false, stages, privateAddresses: false, note: INBOUND_NOTE, hint: "The public name doesn't resolve from here. Create the DNS record, or check split-horizon DNS." };
  }
  const addrs = d.value.map((a) => a.address);
  const privateAddresses = addrs.every((a) => isPrivateAddress(a));
  stages.push({ stage: "dns", ok: true, ms: d.ms, detail: `${addrs.slice(0, 3).join(", ")}${privateAddresses ? " (private network)" : ""}` });
  if (u.protocol !== "https:") {
    return {
      ranAt,
      url: redactUrl(base),
      ok: false,
      stages,
      privateAddresses,
      note: INBOUND_NOTE,
      hint: "The public base URL is plain HTTP. Put HTTPS in front (reverse proxy or tunnel) — hosted connectors and Agent OAuth require it.",
    };
  }
  const h = await timed(() => getLikeServer(io, `${base}/health`));
  if (h.error) {
    stages.push({ stage: "http", ok: false, ms: h.ms, detail: h.error.message });
    const tlsFail = /certificate|self[- ]signed|CERT_|unable to verify/i.test(h.error.message);
    return {
      ranAt,
      url: redactUrl(base),
      ok: false,
      stages,
      privateAddresses,
      note: INBOUND_NOTE,
      hint: tlsFail
        ? "The certificate isn't publicly trusted. Hosted connectors reject it — use a public CA (e.g. Let's Encrypt via your proxy or tunnel)."
        : "This server couldn't fetch its own public address. Common causes: NAT hairpinning not supported by the router, a firewall blocking the port, or the proxy not forwarding to this server.",
    };
  }
  let ours = false;
  try {
    const j = JSON.parse(h.value!.body) as { service?: string; version?: string };
    ours = j.service === "contextnest-community" && j.version === SERVICE_VERSION;
  } catch {
    // not JSON — not us
  }
  stages.push({
    stage: "http",
    ok: ours,
    ms: h.ms,
    detail: ours ? `HTTP ${h.value!.status} from this server (version ${SERVICE_VERSION})` : `HTTP ${h.value!.status}, but the answer didn't come from this server`,
  });
  return {
    ranAt,
    url: redactUrl(base),
    ok: ours,
    stages,
    privateAddresses,
    note: INBOUND_NOTE,
    ...(!ours && { hint: "Something else answers at the public address — the proxy or DNS points at a different service or an older deployment." }),
    ...(ours &&
      privateAddresses && {
        hint: "Reachable here, but the name resolves to private addresses — people on your network can use it; hosted connectors can't.",
      }),
  };
}

export interface DiscoveryReport {
  ranAt: string;
  issuer: string | null;
  ok: boolean;
  ms: number;
  detail: string;
  /** Hosts the IdP will make this server and browsers talk to. */
  endpointHosts: string[];
  hint?: string;
}

export async function runOidcDiscoveryCheck(io: NetIO = realIO): Promise<DiscoveryReport> {
  const issuer = config.OIDC_ISSUER;
  const ranAt = new Date().toISOString();
  if (!issuer) {
    return { ranAt, issuer: null, ok: false, ms: 0, detail: "No issuer set", endpointHosts: [], hint: "Enter the issuer URL in Settings → Single sign-on first." };
  }
  const r = await timed(() => getLikeServer(io, `${issuer}/.well-known/openid-configuration`));
  if (r.error) {
    return {
      ranAt,
      issuer: redactUrl(issuer),
      ok: false,
      ms: r.ms,
      detail: r.error.message,
      endpointHosts: [],
      hint: "This server can't reach the identity provider. Allow outbound HTTPS to its host (for Entra: login.microsoftonline.com), or route it through your egress proxy.",
    };
  }
  if (r.value!.status !== 200) {
    return {
      ranAt,
      issuer: redactUrl(issuer),
      ok: false,
      ms: r.ms,
      detail: `HTTP ${r.value!.status}`,
      endpointHosts: [],
      hint: "The issuer URL is reachable but has no discovery document there. For Entra it must be https://login.microsoftonline.com/<tenant-id>/v2.0 — the tenant GUID, not 'common'.",
    };
  }
  try {
    const doc = JSON.parse(r.value!.body) as Record<string, unknown>;
    const missing = ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"].filter((k) => typeof doc[k] !== "string");
    if (missing.length) throw new Error(`discovery document is missing ${missing.join(", ")}`);
    if (String(doc.issuer).replace(/\/$/, "") !== issuer.replace(/\/$/, "")) {
      throw new Error(`the document names a different issuer (${String(doc.issuer)})`);
    }
    const endpointHosts = [...new Set(["authorization_endpoint", "token_endpoint", "jwks_uri"].map((k) => new URL(String(doc[k])).host))];
    return { ranAt, issuer: redactUrl(issuer), ok: true, ms: r.ms, detail: "Discovery document found and matches the issuer", endpointHosts };
  } catch (err) {
    return {
      ranAt,
      issuer: redactUrl(issuer),
      ok: false,
      ms: r.ms,
      detail: (err as Error).message,
      endpointHosts: [],
      hint: "Copy the issuer exactly as your identity provider shows it, including the trailing /v2.0 for Entra.",
    };
  }
}
