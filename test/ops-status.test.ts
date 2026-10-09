/**
 * Settings → Network & status: /admin/status and its probes.
 *
 * Security-sensitive: the report must be admin-only and must never carry a
 * secret (DB password, SMTP credentials, webhook paths, license gateway key),
 * and the probes must only dial targets derived from config — a request can
 * never point them at a host of its choosing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

const OWNER = "owner@example.com";
const SECRETS = {
  SMTP_URL: "smtps://mailer:hunter2-smtp@smtp.example.com:465",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T000/B000/s3cr3tPathToken",
};
const GATEWAY = { baseUrl: "https://gw.promptowl.example", key: "sk-gateway-SECRET-KEY" };

let env: ReturnType<typeof setupTestEnv>;
beforeEach(() => {
  env = setupTestEnv();
});
afterEach(async () => {
  for (const k of [...Object.keys(SECRETS), "PUBLIC_BASE_URL", "NOTIFY_EMAIL_FROM", "OIDC_ISSUER", "OIDC_ENABLED"]) delete process.env[k];
  vi.restoreAllMocks();
  await env.cleanup();
});

describe("/admin/status — access", () => {
  it("refuses anonymous callers and non-admins on every route", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER });
    const stranger = await registerUser(app, "stranger@example.com");
    const anon = await app.request("/admin/status");
    expect(anon.status).toBe(401);
    expect((await jsonRequest(app, "GET", "/admin/status", undefined, stranger.apiKey)).status).toBe(403);
    for (const p of ["egress", "inbound", "oidc-discovery"]) {
      expect((await jsonRequest(app, "POST", `/admin/status/${p}`, {}, stranger.apiKey)).status).toBe(403);
    }
  });
});

describe("/admin/status — probe rate limit", () => {
  it("429s after ten probes a minute", async () => {
    // No PUBLIC_BASE_URL, so the inbound probe answers without touching the network.
    const app = await createTestApp("key", { ownerEmail: OWNER });
    const admin = await registerUser(app, OWNER);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await jsonRequest(app, "POST", "/admin/status/inbound", {}, admin.apiKey)).status);
    }
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

describe("/admin/status — report", () => {
  it("reports every check with a fix on anything not green, and leaks no secret", async () => {
    Object.assign(process.env, SECRETS, { NOTIFY_EMAIL_FROM: "nest@example.com" });
    const app = await createTestApp("key", { ownerEmail: OWNER, gateway: GATEWAY });
    const admin = await registerUser(app, OWNER);
    const { status, data } = await jsonRequest(app, "GET", "/admin/status", undefined, admin.apiKey);
    expect(status).toBe(200);

    const ids = data.checks.map((c: any) => c.id);
    for (const id of ["db", "migrations", "db-size", "disk", "storage", "license", "base-url", "email", "oidc", "scheduler", "version"]) {
      expect(ids).toContain(id);
    }
    for (const c of data.checks) {
      expect(["green", "amber", "red", "off"]).toContain(c.state);
      if (c.state === "amber" || c.state === "red") expect(c.fix, c.id).toBeTruthy();
    }
    expect(data.checks.find((c: any) => c.id === "db").state).toBe("green");
    expect(data.checks.find((c: any) => c.id === "migrations").state).toBe("green");
    // Unpinned public address is amber with a fix.
    expect(data.checks.find((c: any) => c.id === "base-url").state).toBe("amber");

    const raw = JSON.stringify(data);
    for (const secret of ["hunter2-smtp", "mailer", "s3cr3tPathToken", "sk-gateway-SECRET-KEY", "/services/T000"]) {
      expect(raw, `report leaks ${secret}`).not.toContain(secret);
    }
    // …but it does name the hosts a firewall needs.
    const egress = data.egress.map((t: any) => `${t.id}:${t.host}:${t.port}`);
    expect(egress).toContain("smtp:smtp.example.com:465");
    expect(egress).toContain("slack:hooks.slack.com:443");
    expect(egress).toContain("model-gateway:gw.promptowl.example:443");
    expect(egress.some((e: string) => e.startsWith("promptowl:"))).toBe(true);
  });

  it("flags a private public address as amber (connectors can't reach it)", async () => {
    process.env.PUBLIC_BASE_URL = "https://nest.corp";
    const app = await createTestApp("key", { ownerEmail: OWNER });
    const admin = await registerUser(app, OWNER);
    const { data } = await jsonRequest(app, "GET", "/admin/status", undefined, admin.apiKey);
    expect(data.address.privateHost).toBe(true);
    const base = data.checks.find((c: any) => c.id === "base-url");
    expect(base.state).toBe("amber");
    expect(base.fix).toMatch(/connectors/i);
  });
});

describe("redactUrl", () => {
  it("drops userinfo, query and fragment", async () => {
    const { redactUrl } = await import("../src/ops/status.js");
    expect(redactUrl("postgres://u:p%40ss@db.internal:5432/nest?sslmode=require#x")).toBe("postgres://db.internal:5432/nest");
    expect(redactUrl("not a url")).toBe("(unparseable URL)");
  });
});

/** A NetIO that records every host it was asked to touch. */
function fakeIO(over: Partial<import("../src/ops/egress.js").NetIO> = {}) {
  const touched: string[] = [];
  const io: import("../src/ops/egress.js").NetIO = {
    lookup: async (h) => (touched.push(h), [{ address: "93.184.216.34", family: 4 }]),
    tcp: async (h) => void touched.push(h),
    tls: async (h) => (touched.push(h), { authorized: true, validTo: "Jan 1 00:00:00 2030 GMT" }),
    httpGet: async (u) => (touched.push(new URL(u).host), { status: 404, date: new Date(Date.now() - 30_000).toUTCString(), body: "" }),
    smtpVerify: async () => ({ ok: true }),
    proxiedGet: async (u) => (touched.push(`proxy:${new URL(u).host}`), { status: 404, date: null }),
    proxy: () => null,
    ...over,
  };
  return { io, touched };
}

describe("probes", () => {
  it("egress dials only config-derived hosts and reports clock skew", async () => {
    Object.assign(process.env, SECRETS);
    // The routes read no request body at all (see app.ts), so the only way
    // to choose a target is server config; prove the probe stays inside it.
    const egressMod = await import("../src/ops/egress.js");
    const { egressTargets } = await import("../src/ops/status.js");
    const allowed = new Set(egressTargets().map((t) => t.host));
    const { io, touched } = fakeIO();
    const rep = await egressMod.runEgressChecks(io);
    expect(touched.length).toBeGreaterThan(0);
    for (const h of touched) expect(allowed.has(h.replace(/:\d+$/, "")), h).toBe(true);
    // HTTP probes hit the origin only — never a webhook path.
    expect(rep.results.every((r) => r.ok)).toBe(true);
    expect(rep.clockSkewSeconds).toBeGreaterThanOrEqual(29);
    expect(rep.clockSkewSeconds).toBeLessThanOrEqual(31);
  });

  it("names the failing stage with an operator hint", async () => {
    const { runEgressChecks } = await import("../src/ops/egress.js");
    const { io } = fakeIO({ tcp: async () => { throw new Error("connect ETIMEDOUT"); } });
    const rep = await runEgressChecks(io);
    const po = rep.results.find((r) => r.id === "promptowl")!;
    expect(po.ok).toBe(false);
    expect(po.stages.at(-1)).toMatchObject({ stage: "tcp", ok: false });
    expect(po.hint).toMatch(/firewall/i);

    const { io: mitm } = fakeIO({ tls: async () => ({ authorized: false, error: "SELF_SIGNED_CERT_IN_CHAIN" }) });
    const po2 = (await runEgressChecks(mitm)).results.find((r) => r.id === "promptowl")!;
    expect(po2.hint).toMatch(/NODE_EXTRA_CA_CERTS/);
  });

  it("behind an egress proxy, probes HTTPS through it instead of dialling direct", async () => {
    process.env.SMTP_URL = SECRETS.SMTP_URL;
    const { runEgressChecks, configuredProxy } = await import("../src/ops/egress.js");
    expect(configuredProxy({ HTTPS_PROXY: "http://user:pw@proxy.corp:3128", NODE_USE_ENV_PROXY: "1" }, [])).toBe("http://proxy.corp:3128");
    // Without env-proxy support Node's fetch ignores HTTPS_PROXY, so the probe must too.
    expect(configuredProxy({ HTTPS_PROXY: "http://proxy.corp:3128" }, [])).toBeNull();
    expect(configuredProxy({ HTTPS_PROXY: "http://proxy.corp:3128" }, ["--use-env-proxy"])).toBe("http://proxy.corp:3128");
    const { io, touched } = fakeIO({ proxy: () => "http://proxy.corp:3128" });
    const rep = await runEgressChecks(io);
    expect(rep.proxy).toBe("http://proxy.corp:3128");
    const po = rep.results.find((r) => r.id === "promptowl")!;
    expect(po.stages).toHaveLength(1);
    expect(po.stages[0].detail).toMatch(/via http:\/\/proxy\.corp:3128/);
    // SMTP isn't proxied: still resolved and verified directly.
    expect(rep.results.find((r) => r.id === "smtp")!.stages.map((s) => s.stage)).toEqual(["dns", "smtp"]);
    expect(touched.filter((t) => !t.startsWith("proxy:"))).toEqual(["smtp.example.com"]);
  });

  it("inbound flags private answers and requires a pinned address", async () => {
    const { runInboundCheck } = await import("../src/ops/egress.js");
    const none = await runInboundCheck(fakeIO().io);
    expect(none.ok).toBe(false);
    expect(none.hint).toMatch(/public base URL/);
    expect(none.note).toMatch(/not from the internet/);

    process.env.PUBLIC_BASE_URL = "https://nest.example.com";
    const { SERVICE_VERSION } = await import("../src/shared/version.js");
    const { io, touched } = fakeIO({
      lookup: async (h) => (touched.push(h), [{ address: "10.0.4.7", family: 4 }]),
      httpGet: async (u) => (touched.push(u), { status: 200, date: null, body: JSON.stringify({ service: "contextnest-community", version: SERVICE_VERSION }) }),
    });
    const rep = await runInboundCheck(io);
    expect(rep.ok).toBe(true);
    expect(rep.privateAddresses).toBe(true);
    expect(rep.hint).toMatch(/hosted connectors can't/);
    expect(touched).toEqual(["nest.example.com", "https://nest.example.com/health"]);
  });

  it("OIDC discovery fetches only the configured issuer and checks the issuer matches", async () => {
    const { runOidcDiscoveryCheck } = await import("../src/ops/egress.js");
    process.env.OIDC_ISSUER = "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0";
    const doc = {
      issuer: process.env.OIDC_ISSUER,
      authorization_endpoint: "https://login.microsoftonline.com/x/oauth2/v2.0/authorize",
      token_endpoint: "https://login.microsoftonline.com/x/oauth2/v2.0/token",
      jwks_uri: "https://login.microsoftonline.com/x/discovery/v2.0/keys",
    };
    const asked: string[] = [];
    const ok = await runOidcDiscoveryCheck(fakeIO({ httpGet: async (u) => (asked.push(u), { status: 200, date: null, body: JSON.stringify(doc) }) }).io);
    expect(ok.ok).toBe(true);
    expect(ok.endpointHosts).toEqual(["login.microsoftonline.com"]);
    expect(asked).toEqual([`${process.env.OIDC_ISSUER}/.well-known/openid-configuration`]);

    const wrong = await runOidcDiscoveryCheck(
      fakeIO({ httpGet: async () => ({ status: 200, date: null, body: JSON.stringify({ ...doc, issuer: "https://evil.example" }) }) }).io,
    );
    expect(wrong.ok).toBe(false);
    expect(wrong.detail).toMatch(/different issuer/);
  });
});
