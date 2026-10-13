import { BlockList, isIP } from "node:net";
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config } from "../config.js";

/**
 * Who may vouch for the client via X-Forwarded-* headers.
 *
 * TRUSTED_PROXIES unset → "legacy": every peer is believed, exactly as before
 * this setting existed. That stays the default because hosted deployments sit
 * behind Cloud Run / load balancers whose peer addresses aren't stable.
 * Set it on a directly exposed server, or anyone can spoof their IP (and dodge
 * per-IP rate limits) or their scheme with a header.
 */

const KEYWORDS: Record<string, [string, number, "ipv4" | "ipv6"][]> = {
  loopback: [
    ["127.0.0.0", 8, "ipv4"],
    ["::1", 128, "ipv6"],
  ],
  private: [
    ["10.0.0.0", 8, "ipv4"],
    ["172.16.0.0", 12, "ipv4"],
    ["192.168.0.0", 16, "ipv4"],
    ["100.64.0.0", 10, "ipv4"], // CGNAT — Tailscale and carrier NAT
    ["169.254.0.0", 16, "ipv4"], // link-local
    ["fc00::", 7, "ipv6"],
    ["fe80::", 10, "ipv6"],
  ],
};

export class TrustedProxiesError extends Error {
  override name = "TrustedProxiesError";
}

/** `::ffff:10.0.0.1` → `10.0.0.1`, so IPv4 rules match dual-stack sockets. */
export function normalizeIp(raw: string): string {
  const ip = raw.trim().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? mapped[1] : ip;
}

/** Parse TRUSTED_PROXIES. Empty → null (legacy trust-all). Bad entries throw. */
export function parseTrustedProxies(raw: string): BlockList | null {
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const kw = KEYWORDS[entry.toLowerCase()];
    if (kw) {
      for (const [net, prefix, type] of kw) list.addSubnet(net, prefix, type);
      continue;
    }
    const [addr, prefixRaw] = entry.split("/");
    const ip = normalizeIp(addr);
    const version = isIP(ip);
    if (!version) throw new TrustedProxiesError(`TRUSTED_PROXIES: "${entry}" is not an IP, CIDR, "loopback" or "private".`);
    const type = version === 4 ? "ipv4" : "ipv6";
    if (prefixRaw === undefined) {
      list.addAddress(ip, type);
      continue;
    }
    const prefix = Number(prefixRaw);
    const max = version === 4 ? 32 : 128;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
      throw new TrustedProxiesError(`TRUSTED_PROXIES: bad prefix length in "${entry}".`);
    }
    list.addSubnet(ip, prefix, type);
  }
  return list;
}

export function isTrusted(list: BlockList, rawIp: string | undefined): boolean {
  if (!rawIp) return false;
  const ip = normalizeIp(rawIp);
  const version = isIP(ip);
  if (!version) return false;
  return list.check(ip, version === 4 ? "ipv4" : "ipv6");
}

let cached: { raw: string; list: BlockList | null } | undefined;

/**
 * The parsed setting, re-parsed only when the env value changes. A malformed
 * value fails closed (trust no proxy) — startup already refused to boot on
 * it, so this only guards a value changed underneath a running process.
 */
export function trustedProxies(): BlockList | null {
  const raw = config.TRUSTED_PROXIES;
  if (cached?.raw !== raw) {
    let list: BlockList | null;
    try {
      list = parseTrustedProxies(raw);
    } catch {
      list = new BlockList();
    }
    cached = { raw, list };
  }
  return cached.list;
}

/** The TCP peer address, or undefined where the runtime can't say (e.g. app.request in tests). */
export function peerAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether this request's forwarded headers may be believed:
 *   "legacy"    TRUSTED_PROXIES unset — believe them (pre-setting behaviour)
 *   "trusted"   the immediate peer is a listed proxy
 *   "untrusted" the immediate peer is not — ignore every X-Forwarded-* header
 */
export function forwardedTrust(c: Context): "legacy" | "trusted" | "untrusted" {
  const list = trustedProxies();
  if (!list) return "legacy";
  return isTrusted(list, peerAddress(c)) ? "trusted" : "untrusted";
}

/**
 * The client address from an X-Forwarded-For chain appended to by trusted
 * proxies: walk from the right (nearest hop), skipping proxies we trust; the
 * first address we don't trust is the client. The leftmost entry is
 * client-supplied and only used when every hop is a trusted proxy.
 */
export function clientFromChain(list: BlockList, xff: string, peer: string | undefined): string | undefined {
  const chain = xff
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (peer) chain.push(peer);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isTrusted(list, chain[i])) return normalizeIp(chain[i]);
  }
  return chain[0] ? normalizeIp(chain[0]) : undefined;
}
