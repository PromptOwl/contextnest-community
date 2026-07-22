import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

/**
 * Best-effort client IP for rate-limit keying — shared by the auth entry
 * points (password/register/device in auth/routes.ts, OIDC in auth/oidc.ts)
 * so every endpoint resolves the caller identically.
 *
 * Respects reverse-proxy headers first; falls back to the raw TCP peer
 * address when none are present (e.g. running locally without a proxy).
 * Intentionally trusts the first forwarded IP — deploy behind a proxy you
 * control. Returns "unknown" only when no address is resolvable at all;
 * callers should expect that value to collapse all such requests into one
 * rate-limit bucket.
 */
export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const realIp = c.req.header("x-real-ip");
  if (realIp) return realIp.trim();
  // No proxy — read the TCP peer address directly.
  try {
    const addr = getConnInfo(c).remote.address;
    if (addr) return addr;
  } catch {
    // Runtime without conninfo support — fall through to "unknown".
  }
  return "unknown";
}
