/**
 * Outbound HTTP for a metacognition agent's feeds and MCP servers.
 *
 * `urlAllowed` checks a URL's text: https, and no literal private host. That
 * alone leaves two holes, both closed here:
 *
 *  - DNS. A public-looking name can resolve to 127.0.0.1 or the metadata
 *    address, or re-resolve there between a check and the request (DNS
 *    rebinding). So the address is checked where the socket is opened: the
 *    request's own `lookup` resolves the name, refuses if ANY answer is
 *    private, and connects to the address it just checked — there is no
 *    second resolution to rebind.
 *  - Size. A hostile server can send an endless body. The body is streamed
 *    and the request is torn down past `maxBytes`, before it is buffered.
 *
 * Redirects are never followed (a 3xx comes back as a 3xx), so a public URL
 * can't bounce the request onto a private one.
 *
 * Never proxied. With NODE_USE_ENV_PROXY=1 (set in the Docker image) Node
 * sends requests on the GLOBAL agents through HTTPS_PROXY, and the proxy —
 * not `lookup` — resolves the name, so a host pointing at 169.254.169.254
 * would sail past the check. These requests use their own agents, which
 * carry no proxy, so the pinned `lookup` always runs. Agent feeds and MCP
 * servers therefore need direct egress (documented in CONFIGURATION.md).
 *
 * Returns a WHATWG Response so it can stand in for `fetch` — the MCP SDK's
 * transport takes it as its `fetch`.
 */
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { Readable, Transform } from "node:stream";
import { isIP, type LookupFunction } from "node:net";
import { isForbiddenConnectorHost, embeddedIPv4 } from "../notify/dispatch.js";
import { config } from "../config.js";

export class OutboundBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundBlockedError";
  }
}

/** True for an address this server must never connect to for an agent: the
 *  connector fence (which also unwraps IPv4 carried in IPv6 — mapped,
 *  compatible, NAT64, 6to4) plus carrier-grade NAT, which is not public and
 *  often internal in clouds. */
export function isPrivateAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (isForbiddenConnectorHost(a)) return true;
  const v4 = isIP(a) === 4 ? a : embeddedIPv4(a);
  const m = v4?.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  return !!m && Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127;
}

type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
const systemResolver: Resolver = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/** A socket `lookup` that refuses private answers and pins the checked one.
 *  `allowPrivate` defaults to the metacognition dev switch. */
export function guardedLookup(
  resolve: Resolver = systemResolver,
  allowPrivate: () => boolean = () => config.METACOGNITION_ALLOW_PRIVATE_URLS,
): LookupFunction {
  return ((hostname: string, options: any, callback: any) => {
    resolve(hostname).then(
      (answers) => {
        if (!answers.length) return callback(new OutboundBlockedError(`${hostname} did not resolve`));
        if (!allowPrivate()) {
          const bad = answers.find((x) => isPrivateAddress(x.address));
          if (bad) {
            return callback(new OutboundBlockedError(`${hostname} resolves to a private address; refusing to connect`));
          }
        }
        // Prefer IPv4: a host whose first answer is an unreachable IPv6
        // address would otherwise fail though a good IPv4 one exists.
        const pick = answers.find((x) => x.family === 4) ?? answers[0];
        if (options?.all) return callback(null, [pick]);
        callback(null, pick.address, pick.family);
      },
      (err) => callback(err),
    );
  }) as LookupFunction;
}

/** Proxy-free agents: see "Never proxied" above. Not the global agents. */
const directAgents = { "https:": new https.Agent(), "http:": new http.Agent() } as const;

export class OutboundTooLargeError extends Error {
  constructor(max: number) {
    super(`response is larger than ${max} bytes`);
    this.name = "OutboundTooLargeError";
  }
}

/**
 * fetch(), with the address checked at connect time and the body capped.
 * `resolver` is for tests. `allowPrivate` overrides the metacognition dev
 * switch; file uploads by URL pass false, so their fence is always up.
 */
export function guardedFetch(opts: {
  maxBytes: number;
  timeoutMs: number;
  resolver?: Resolver;
  allowPrivate?: boolean;
}) {
  const allowPrivate = () => opts.allowPrivate ?? config.METACOGNITION_ALLOW_PRIVATE_URLS;
  const lookup = guardedLookup(opts.resolver, allowPrivate);
  return (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.protocol !== "https:" && !(allowPrivate() && url.protocol === "http:")) {
      return Promise.reject(new OutboundBlockedError(`${url.protocol} is not allowed`));
    }
    // An IP-literal host never goes through `lookup`, so check it here.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !allowPrivate() && isPrivateAddress(host)) {
      return Promise.reject(new OutboundBlockedError(`${host} is a private address; refusing to connect`));
    }
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => {
      headers[k] = v;
    });
    const body = init.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      return Promise.reject(new Error("guardedFetch only sends string bodies"));
    }
    const mod = url.protocol === "https:" ? https : http;
    return new Promise<Response>((resolve, reject) => {
      const req = mod.request(
        url,
        {
          method: init.method ?? "GET",
          headers,
          lookup,
          agent: directAgents[url.protocol as "https:" | "http:"],
          timeout: opts.timeoutMs,
        },
        (res) => {
          let seen = 0;
          const cap = new Transform({
            transform(chunk: Buffer, _enc, done) {
              seen += chunk.length;
              if (seen > opts.maxBytes) {
                done(new OutboundTooLargeError(opts.maxBytes));
                req.destroy();
                return;
              }
              done(null, chunk);
            },
          });
          res.pipe(cap);
          res.on("error", (e) => cap.destroy(e));
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            for (const one of Array.isArray(v) ? v : [v]) out.append(k, one);
          }
          const status = res.statusCode ?? 502;
          const nullBody = status === 204 || status === 304 || (init.method ?? "GET") === "HEAD";
          resolve(
            new Response(nullBody ? null : (Readable.toWeb(cap) as unknown as ReadableStream), {
              status,
              statusText: res.statusMessage,
              headers: out,
            }),
          );
        },
      );
      req.on("timeout", () => req.destroy(new Error(`request timed out after ${opts.timeoutMs}ms`)));
      req.on("error", reject);
      // One run's signal is shared by all its requests: drop the listener
      // when this one is done, or they pile up for the rest of the run.
      const signal = init.signal;
      if (signal) {
        const onAbort = () => req.destroy(new Error("aborted"));
        if (signal.aborted) onAbort();
        else {
          signal.addEventListener("abort", onAbort, { once: true });
          req.on("close", () => signal.removeEventListener("abort", onAbort));
        }
      }
      if (typeof body === "string") req.write(body);
      req.end();
    });
  };
}

/** Read a Response body as text, stopping (with an error) past maxBytes. */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new OutboundTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
