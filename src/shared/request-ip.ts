import type { Context } from "hono";
import { clientFromChain, forwardedTrust, peerAddress, trustedProxies } from "./trusted-proxies.js";

/**
 * Best-effort client IP for rate-limit keying — shared by the auth entry
 * points (password/register/device in auth/routes.ts, OIDC in auth/oidc.ts)
 * so every endpoint resolves the caller identically.
 *
 * Forwarded headers are believed per TRUSTED_PROXIES (shared/trusted-proxies.ts):
 *   - unset (legacy): the first X-Forwarded-For entry, then X-Real-IP — trusts
 *     any peer, so deploy behind a proxy you control;
 *   - peer is a trusted proxy: the nearest untrusted hop in the XFF chain;
 *   - peer is not trusted: the TCP peer address, headers ignored.
 * Returns "unknown" only when no address is resolvable at all; callers should
 * expect that value to collapse all such requests into one rate-limit bucket.
 */
export function clientIp(c: Context): string {
  const trust = forwardedTrust(c);
  const xff = c.req.header("x-forwarded-for");
  const realIp = c.req.header("x-real-ip");
  const peer = peerAddress(c);

  if (trust === "legacy") {
    if (xff) return xff.split(",")[0].trim();
    if (realIp) return realIp.trim();
  } else if (trust === "trusted") {
    if (xff) return clientFromChain(trustedProxies()!, xff, peer) ?? "unknown";
    if (realIp) return realIp.trim();
  }
  return peer ?? "unknown";
}
