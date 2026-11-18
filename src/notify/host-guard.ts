// SSRF fence helpers, dependency-free so low-level modules (metacognition/net.ts)
// can import them without pulling in dispatch.ts and its import cycle.
import { isIP } from "node:net";

/**
 * SSRF fence for outbound connector targets. The server POSTs these URLs
 * from its own network position, so an editor-supplied URL must not reach
 * loopback, RFC1918/link-local ranges, or the cloud metadata endpoint.
 *
 * Names and addresses are judged separately: a NAME is refused only for the
 * local suffixes below (so `fd-feeds.com` is a name, not an IPv6 prefix); an
 * ADDRESS literal is parsed and judged by range, including IPv4 hidden
 * inside IPv6 (mapped, compatible, NAT64, 6to4). A public DNS name that
 * RESOLVES to a private address is caught where the socket opens
 * (metacognition/net.ts guardedLookup), not here.
 */
export function isForbiddenConnectorHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal"))
    return true;
  const kind = isIP(h);
  if (kind === 4) return isPrivateIPv4(h);
  if (kind === 6) return isPrivateIPv6(h);
  return false;
}

/** Ranges no connector or agent may reach (IPv4, dotted quad). */
export function isPrivateIPv4(addr: string): boolean {
  const q = addr.split(".").map(Number);
  if (q.length !== 4 || q.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = q;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && q[2] === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking, often internal
  if (a >= 224) return true; // multicast (224/4), reserved (240/4), broadcast
  return false;
}

/** The eight 16-bit groups of an IPv6 literal, or null if it isn't one. */
export function ipv6Groups(addr: string): number[] | null {
  let a = addr.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isIP(a) !== 6) return null;
  const quad = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (quad) {
    const [b0, b1, b2, b3] = quad.slice(2).map(Number);
    a = `${quad[1]}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const parse = (part: string) => (part ? part.split(":").map((x) => parseInt(x, 16)) : []);
  let groups: number[];
  if (a.includes("::")) {
    const [head, tail] = a.split("::");
    const h = parse(head);
    const t = parse(tail);
    groups = [...h, ...Array(8 - h.length - t.length).fill(0), ...t];
  } else {
    groups = parse(a);
  }
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/** The IPv4 address carried inside an IPv6 one (mapped, compatible, NAT64,
 *  6to4), or null. Exported for the agent fence's extra ranges. */
export function embeddedIPv4(addr: string): string | null {
  const g = ipv6Groups(addr);
  if (!g) return null;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6], g[7]); // ::ffff:a.b.c.d
  if (zero(0, 6) && (g[6] !== 0 || g[7] > 1)) return v4(g[6], g[7]); // ::a.b.c.d (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6], g[7]); // NAT64 64:ff9b::/96
  if (g[0] === 0x2002) return v4(g[1], g[2]); // 6to4 2002::/16
  return null;
}

/** Ranges no connector or agent may reach (IPv6 literal). */
export function isPrivateIPv6(addr: string): boolean {
  const g = ipv6Groups(addr);
  if (!g) return true;
  const inner = embeddedIPv4(addr);
  if (inner) return isPrivateIPv4(inner);
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // local-use NAT64 64:ff9b:1::/48
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo: tunnels to an address we can't vet
  return false;
}

/** True for an https URL whose host passes the SSRF fence. */
export function isSafeConnectorUrl(raw: string): boolean {
  if (!/^https:\/\//i.test(raw)) return false;
  try {
    return !isForbiddenConnectorHost(new URL(raw).hostname);
  } catch {
    return false;
  }
}
