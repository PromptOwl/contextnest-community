import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { clientIp } from "../src/shared/request-ip.js";
import { isSecureRequest } from "../src/auth/sessions.js";
import {
  clientFromChain,
  isTrusted,
  normalizeIp,
  parseTrustedProxies,
  TrustedProxiesError,
} from "../src/shared/trusted-proxies.js";
import {
  egressProxyStatus,
  extraCaStatus,
  networkStartupLines,
  nodeSupportsEnvProxy,
  redactProxyUrl,
} from "../src/shared/egress-proxy.js";
import { config } from "../src/config.js";

/** An app that reports what the request helpers decided, with a chosen TCP peer. */
function probe(peer: string | undefined) {
  const app = new Hono();
  app.get("/", (c) => c.json({ ip: clientIp(c), secure: isSecureRequest(c) }));
  return async (headers: Record<string, string> = {}, url = "http://nest.example/") => {
    const env = peer === undefined ? {} : { incoming: { socket: { remoteAddress: peer, remoteFamily: "IPv4" } } };
    const res = await app.request(url, { headers }, env);
    return (await res.json()) as { ip: string; secure: boolean };
  };
}

const saved = process.env.TRUSTED_PROXIES;
afterEach(() => {
  if (saved === undefined) delete process.env.TRUSTED_PROXIES;
  else process.env.TRUSTED_PROXIES = saved;
});

describe("TRUSTED_PROXIES parsing", () => {
  it("accepts IPs, CIDRs, and the loopback / private keywords", () => {
    const list = parseTrustedProxies("loopback, private, 203.0.113.7, 198.51.100.0/24, 2001:db8::/32")!;
    for (const ip of ["127.0.0.1", "::1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "100.100.1.1", "203.0.113.7", "198.51.100.9", "2001:db8::5", "::ffff:10.0.0.9"]) {
      expect(isTrusted(list, ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "203.0.113.8", "172.32.0.1", "2001:db9::1", "nonsense"]) {
      expect(isTrusted(list, ip), ip).toBe(false);
    }
    expect(isTrusted(list, undefined)).toBe(false);
  });

  it("is null (legacy) when unset and rejects malformed entries", () => {
    expect(parseTrustedProxies("")).toBeNull();
    expect(parseTrustedProxies(" , ")).toBeNull();
    expect(() => parseTrustedProxies("10.0.0.0/33")).toThrow(TrustedProxiesError);
    expect(() => parseTrustedProxies("proxy.internal")).toThrow(/not an IP/);
  });

  it("normalizes IPv4-mapped and bracketed addresses", () => {
    expect(normalizeIp("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(normalizeIp("[::1]")).toBe("::1");
  });

  it("walks the X-Forwarded-For chain from the nearest hop", () => {
    const list = parseTrustedProxies("10.0.0.0/8")!;
    // client spoofs 1.1.1.1; real client 203.0.113.5 appended by our proxy 10.0.0.2
    expect(clientFromChain(list, "1.1.1.1, 203.0.113.5, 10.0.0.2", "10.0.0.3")).toBe("203.0.113.5");
    expect(clientFromChain(list, "10.0.0.9", "10.0.0.3")).toBe("10.0.0.9");
  });
});

describe("forwarded headers vs TRUSTED_PROXIES", () => {
  it("legacy (unset): headers are believed from any peer — unchanged behaviour", async () => {
    delete process.env.TRUSTED_PROXIES;
    const get = probe("8.8.8.8");
    expect(await get({ "x-forwarded-for": "1.1.1.1, 2.2.2.2", "x-forwarded-proto": "https" })).toEqual({
      ip: "1.1.1.1",
      secure: true,
    });
    expect((await get({ "x-real-ip": "3.3.3.3" })).ip).toBe("3.3.3.3");
    expect(await get()).toEqual({ ip: "8.8.8.8", secure: false });
    // app.request with no socket (the existing test harness): still works
    expect((await probe(undefined)({ "x-forwarded-for": "4.4.4.4" })).ip).toBe("4.4.4.4");
  });

  it("untrusted peer: every forwarded header is ignored", async () => {
    process.env.TRUSTED_PROXIES = "loopback";
    const get = probe("8.8.8.8");
    expect(
      await get({ "x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2", "x-forwarded-proto": "https" }),
    ).toEqual({ ip: "8.8.8.8", secure: false });
    expect(await get({}, "https://nest.example/")).toEqual({ ip: "8.8.8.8", secure: true });
    // no socket to vouch for → untrusted too
    expect((await probe(undefined)({ "x-forwarded-for": "1.1.1.1" })).ip).toBe("unknown");
  });

  it("trusted peer: client is the nearest untrusted hop and proto is believed", async () => {
    process.env.TRUSTED_PROXIES = "loopback, 10.0.0.0/8";
    const get = probe("127.0.0.1");
    expect(await get({ "x-forwarded-for": "1.1.1.1, 203.0.113.5, 10.0.0.2", "x-forwarded-proto": "https" })).toEqual({
      ip: "203.0.113.5",
      secure: true,
    });
    expect((await get({ "x-real-ip": "203.0.113.6" })).ip).toBe("203.0.113.6");
    expect((await probe("::ffff:127.0.0.1")({ "x-forwarded-for": "203.0.113.7" })).ip).toBe("203.0.113.7");
  });

  it("a malformed value changed under a running process fails closed", async () => {
    process.env.TRUSTED_PROXIES = "not-an-ip";
    expect(await probe("127.0.0.1")({ "x-forwarded-for": "1.1.1.1", "x-forwarded-proto": "https" })).toEqual({
      ip: "127.0.0.1",
      secure: false,
    });
  });
});

describe("HOST bind", () => {
  const savedHost = process.env.HOST;
  afterEach(() => {
    if (savedHost === undefined) delete process.env.HOST;
    else process.env.HOST = savedHost;
  });

  it("defaults to every interface and trims an explicit value", () => {
    delete process.env.HOST;
    expect(config.HOST).toBeUndefined();
    process.env.HOST = "  ";
    expect(config.HOST).toBeUndefined();
    process.env.HOST = " 127.0.0.1 ";
    expect(config.HOST).toBe("127.0.0.1");
  });
});

describe("egress proxy status", () => {
  const v = "v22.22.3";

  it("is inactive and silent with no proxy configured", () => {
    const s = egressProxyStatus({ boot: { NODE_USE_ENV_PROXY: "1" }, live: { NODE_USE_ENV_PROXY: "1" }, execArgv: [], version: v });
    expect(s).toEqual({ configured: false, active: false });
    expect(networkStartupLines(s, extraCaStatus({ boot: {}, live: {} }))).toEqual({ info: [], warn: [] });
  });

  it("is active when set at boot with NODE_USE_ENV_PROXY=1 or --use-env-proxy, credentials redacted", () => {
    const env = { HTTPS_PROXY: "http://alice:s3cret@proxy.corp:3128", NO_PROXY: "localhost,.corp", NODE_USE_ENV_PROXY: "1" };
    const s = egressProxyStatus({ boot: env, live: env, execArgv: [], version: v });
    expect(s).toMatchObject({ configured: true, active: true, https: "http://***@proxy.corp:3128", noProxy: "localhost,.corp" });
    expect(JSON.stringify(s)).not.toContain("s3cret");
    const flag = { https_proxy: "http://proxy.corp:3128" };
    expect(egressProxyStatus({ boot: flag, live: flag, execArgv: ["--use-env-proxy"], version: v }).active).toBe(true);
    expect(networkStartupLines(s, extraCaStatus({ boot: {}, live: {} })).info[0]).toMatch(/Egress proxy: https → http:\/\/\*\*\*@proxy\.corp:3128.*SMTP and Postgres connect directly/);
  });

  it("explains each way a configured proxy is NOT in use", () => {
    const p = { HTTPS_PROXY: "http://proxy.corp:3128" };
    expect(egressProxyStatus({ boot: p, live: p, execArgv: [], version: v }).problem).toMatch(/NODE_USE_ENV_PROXY=1/);
    expect(
      egressProxyStatus({ boot: { NODE_USE_ENV_PROXY: "1" }, live: { ...p, NODE_USE_ENV_PROXY: "1" }, execArgv: [], version: v }).problem,
    ).toMatch(/only in \.env/);
    const on = { ...p, NODE_USE_ENV_PROXY: "1" };
    const old = egressProxyStatus({ boot: on, live: on, execArgv: [], version: "v20.20.2" });
    expect(old).toMatchObject({ active: false, problem: expect.stringMatching(/Node ≥ 22\.21/) });
    expect(networkStartupLines(old, extraCaStatus({ boot: {}, live: {} })).warn[0]).toMatch(/NOT in use/);
  });

  it("knows which Node versions support env proxies", () => {
    expect(["v22.21.0", "v22.22.3", "v24.5.0", "v25.0.0"].every(nodeSupportsEnvProxy)).toBe(true);
    expect(["v20.20.2", "v22.20.9", "v23.11.0", "v24.4.1", "garbage"].some(nodeSupportsEnvProxy)).toBe(false);
  });

  it("redacts and tolerates junk", () => {
    expect(redactProxyUrl("http://u:p@h:1")).toBe("http://***@h:1");
    expect(redactProxyUrl("http://h:1/")).toBe("http://h:1");
    expect(redactProxyUrl("::nope")).toBe("(unparseable proxy URL)");
    expect(redactProxyUrl(undefined)).toBeUndefined();
  });
});

describe("NODE_EXTRA_CA_CERTS status", () => {
  it("reports missing files and .env-only values", () => {
    const yes = () => true;
    const path = "/etc/ssl/corp-ca.pem";
    expect(extraCaStatus({ boot: {}, live: {} })).toEqual({ set: false, atBoot: false, exists: false });
    expect(extraCaStatus({ boot: { NODE_EXTRA_CA_CERTS: path }, live: { NODE_EXTRA_CA_CERTS: path }, fileExists: yes })).toEqual({
      set: true,
      path,
      atBoot: true,
      exists: true,
    });
    expect(
      extraCaStatus({ boot: { NODE_EXTRA_CA_CERTS: path }, live: { NODE_EXTRA_CA_CERTS: path }, fileExists: () => false }).problem,
    ).toMatch(/doesn't exist/);
    expect(extraCaStatus({ boot: {}, live: { NODE_EXTRA_CA_CERTS: path }, fileExists: yes }).problem).toMatch(/only in \.env/);
  });
});
