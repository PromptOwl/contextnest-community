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
import { egressTargets, type EgressTarget } from "./status.js";

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
}

const realIO: NetIO = {
  lookup: (host) => dns.promises.lookup(host, { all: true, verbatim: true }),
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
  httpGet: (url, timeoutMs) =>
    new Promise((resolve, reject) => {
      // https.request never follows redirects; certificate checks stay on.
      const req = https.request(url, { method: "GET", timeout: timeoutMs, headers: { Accept: "application/json" } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (body.length < 16_384) body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, date: (res.headers.date as string) ?? null, body }));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error(`no response within ${timeoutMs / 1000}s`)));
      req.on("error", reject);
      req.end();
    }),
  smtpVerify: async () => {
    const s = transportSettings();
    return s ? verifyEmailTransport(s) : { ok: false, error: "email is not configured" };
  },
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

async function probe(t: EgressTarget, io: NetIO): Promise<{ result: ProbeResult; date: string | null }> {
  const stages: Stage[] = [];
  let date: string | null = null;
  const finish = (ok: boolean, failed?: StageName) => ({
    result: { id: t.id, purpose: t.purpose, host: t.host, port: t.port, ok, stages, ...(failed && { hint: HINTS[failed] }) },
    date,
  });

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
  const h = await timed(() => io.httpGet(`https://${t.host}${t.port === 443 ? "" : `:${t.port}`}/`, PROBE_TIMEOUT_MS));
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
  const probed = await Promise.all(targets.map((t) => probe(t, io)));
  const promptowl = probed.find((p) => p.result.id === "promptowl");
  let clockSkewSeconds: number | null = null;
  if (promptowl?.date) {
    const theirs = Date.parse(promptowl.date);
    if (Number.isFinite(theirs)) clockSkewSeconds = Math.round((Date.now() - theirs) / 1000);
  }
  return { ranAt: new Date().toISOString(), results: probed.map((p) => p.result), clockSkewSeconds };
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
    return { ranAt, url: base, ok: false, stages, privateAddresses: false, note: INBOUND_NOTE, hint: "The public name doesn't resolve from here. Create the DNS record, or check split-horizon DNS." };
  }
  const addrs = d.value.map((a) => a.address);
  const privateAddresses = addrs.every((a) => isPrivateAddress(a));
  stages.push({ stage: "dns", ok: true, ms: d.ms, detail: `${addrs.slice(0, 3).join(", ")}${privateAddresses ? " (private network)" : ""}` });
  if (u.protocol !== "https:") {
    return {
      ranAt,
      url: base,
      ok: false,
      stages,
      privateAddresses,
      note: INBOUND_NOTE,
      hint: "The public base URL is plain HTTP. Put HTTPS in front (reverse proxy or tunnel) — hosted connectors and Agent OAuth require it.",
    };
  }
  const h = await timed(() => io.httpGet(`${base}/health`, PROBE_TIMEOUT_MS));
  if (h.error) {
    stages.push({ stage: "http", ok: false, ms: h.ms, detail: h.error.message });
    const tlsFail = /certificate|self[- ]signed|CERT_|unable to verify/i.test(h.error.message);
    return {
      ranAt,
      url: base,
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
    url: base,
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
  const r = await timed(() => io.httpGet(`${issuer}/.well-known/openid-configuration`, PROBE_TIMEOUT_MS));
  if (r.error) {
    return {
      ranAt,
      issuer,
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
      issuer,
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
    return { ranAt, issuer, ok: true, ms: r.ms, detail: "Discovery document found and matches the issuer", endpointHosts };
  } catch (err) {
    return {
      ranAt,
      issuer,
      ok: false,
      ms: r.ms,
      detail: (err as Error).message,
      endpointHosts: [],
      hint: "Copy the issuer exactly as your identity provider shows it, including the trailing /v2.0 for Entra.",
    };
  }
}
