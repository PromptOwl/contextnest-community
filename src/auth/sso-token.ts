import { createHmac, timingSafeEqual } from "crypto";

/**
 * Minimal HS256 JWT verification for PromptOwl SSO tickets.
 *
 * We deliberately avoid pulling a JWT library into this repo — the only token
 * we ever verify is a short-lived HS256 ticket minted by PromptOwl and signed
 * with the shared OFFICIAL_COMMUNITY_SSO_SECRET. Node's crypto is enough.
 *
 * Verifies: structure (3 parts), alg === HS256, signature (constant-time),
 * and `exp`. Audience / jti / one-time-use are enforced by the caller, which
 * owns the DB and the server's canonical URL.
 */

export interface SsoTicketClaims {
  /** subject — the PromptOwl user's email */
  sub: string;
  /** display name (optional) */
  name?: string;
  /** intended audience — this server's canonical base URL */
  aud?: string;
  /** ticket purpose. "mcp" = server-to-server MCP bearer (no jti, not
   *  redeemable for a login session); absent/other = one-click SSO login
   *  ticket. Load-bearing for auth: the MCP middleware requires "mcp" and
   *  GET /auth/sso rejects it, so the two ticket kinds can't cross over. */
  scope?: string;
  /** unique ticket id, for one-time-use enforcement */
  jti?: string;
  /** issued-at (seconds) */
  iat?: number;
  /** expiry (seconds) */
  exp?: number;
}

/**
 * True if a ticket `sub` is a usable email. The SAME shape check GET /auth/sso
 * and the MCP ticket middleware (flexAuthWithPromptowlTicket) both apply, so a
 * whitespace/garbage sub can't create a degenerate empty-email user row on one
 * path while the other rejects it. Caller trims first.
 */
export function isValidTicketSub(sub: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sub) && sub.length <= 254;
}

function b64urlToBuffer(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function bufferToB64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export class SsoTokenError extends Error {}

/** TTL bounds for a minted MCP ticket — short-lived by design. */
const MCP_TICKET_MIN_TTL = 30;
const MCP_TICKET_MAX_TTL = 3600;

/**
 * Mint a short-lived HS256 "mcp" service ticket — the inverse of
 * verifySsoTicket, kept in this file so the scope:"mcp" / no-jti invariant that
 * the MCP acceptor depends on lives in exactly one place.
 *
 * Used by the token-exchange endpoint to issue an MCP bearer AFTER an external
 * IdP (Entra/Google) identity has been verified. It NEVER sets a `jti` (an mcp
 * ticket is not a one-time login ticket) and always forces `scope:"mcp"`, so a
 * caller cannot accidentally mint a login-capable or replayable ticket.
 *
 * @param input.sub        verified user email (must pass isValidTicketSub)
 * @param input.aud        this server's canonical base URL (PUBLIC_BASE_URL)
 * @param input.ttlSeconds requested lifetime, clamped to [30, 3600]
 * @param secret           the deployment's MCP signing secret (non-empty)
 */
export function signMcpTicket(
  input: { sub: string; aud?: string; name?: string; ttlSeconds: number },
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): string {
  if (!secret) throw new SsoTokenError("MCP signing secret not configured");
  const sub = (input.sub ?? "").trim();
  if (!isValidTicketSub(sub)) throw new SsoTokenError("Invalid ticket subject");

  const ttl = Math.max(
    MCP_TICKET_MIN_TTL,
    Math.min(MCP_TICKET_MAX_TTL, Math.floor(input.ttlSeconds)),
  );

  const headerB64 = bufferToB64url(
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  // No jti — ever. scope is forced to "mcp".
  const claims: SsoTicketClaims = {
    sub,
    scope: "mcp",
    iat: nowSec,
    exp: nowSec + ttl,
  };
  if (input.aud) claims.aud = input.aud;
  if (input.name) claims.name = input.name;

  const payloadB64 = bufferToB64url(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = bufferToB64url(
    createHmac("sha256", secret).update(signingInput).digest(),
  );
  return `${signingInput}.${sig}`;
}

/**
 * Verify a PromptOwl SSO ticket and return its claims. Throws SsoTokenError on
 * any structural, signature, or expiry failure. Does NOT check aud/jti — those
 * are the caller's responsibility.
 *
 * @param token  the compact JWT string
 * @param secret the shared OFFICIAL_COMMUNITY_SSO_SECRET (must be non-empty)
 * @param nowSec current time in seconds (injectable for tests)
 */
export function verifySsoTicket(
  token: string,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): SsoTicketClaims {
  if (!secret) throw new SsoTokenError("SSO secret not configured");
  if (!token || typeof token !== "string") {
    throw new SsoTokenError("Missing ticket");
  }

  const parts = token.split(".");
  if (parts.length !== 3) throw new SsoTokenError("Malformed ticket");
  const [headerB64, payloadB64, sigB64] = parts;

  // Header — enforce HS256 so a token can't downgrade the algorithm.
  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(b64urlToBuffer(headerB64).toString("utf8"));
  } catch {
    throw new SsoTokenError("Invalid ticket header");
  }
  if (header.alg !== "HS256") {
    throw new SsoTokenError(`Unsupported alg: ${header.alg}`);
  }

  // Signature — constant-time compare over the canonical signing input.
  const signingInput = `${headerB64}.${payloadB64}`;
  const expected = createHmac("sha256", secret).update(signingInput).digest();
  const provided = b64urlToBuffer(sigB64);
  if (
    expected.length !== provided.length ||
    !timingSafeEqual(expected, provided)
  ) {
    throw new SsoTokenError("Bad signature");
  }

  // Payload.
  let claims: SsoTicketClaims;
  try {
    claims = JSON.parse(b64urlToBuffer(payloadB64).toString("utf8"));
  } catch {
    throw new SsoTokenError("Invalid ticket payload");
  }

  // Expiry — small leeway for clock skew.
  const LEEWAY = 30;
  if (typeof claims.exp !== "number") {
    throw new SsoTokenError("Ticket missing exp");
  }
  if (nowSec > claims.exp + LEEWAY) {
    throw new SsoTokenError("Ticket expired");
  }
  if (!claims.sub) throw new SsoTokenError("Ticket missing sub");

  return claims;
}
