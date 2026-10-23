import { config } from "../config.js";
import { getDb } from "../db/client.js";
import {
  verifySsoTicket,
  isValidTicketSub,
  SsoTokenError,
  type SsoTicketClaims,
} from "./sso-token.js";

/**
 * Verify a PromptOwl MCP service ticket and resolve it to an EXISTING user.
 *
 * The single definition of "a valid MCP ticket", shared by the per-nest
 * ticket middleware (app.ts flexAuthWithPromptowlTicket) and the
 * ticket-to-key exchange (POST /auth/keys/exchange) so the two can't drift:
 *
 *   - HS256, signed with ANY of the candidate secrets (PromptOwl's shared
 *     OFFICIAL_COMMUNITY_SSO_SECRET, or this server's own MCP_SIGNING_SECRET —
 *     see mcpTicketSecrets), unexpired;
 *   - `scope: "mcp"` and NO jti (a one-time SSO login ticket can't double as
 *     an MCP bearer — GET /auth/sso enforces the reverse);
 *   - `aud` matches PUBLIC_BASE_URL when that is set;
 *   - `sub` is a well-formed email of a PERSON that already exists here
 *     (never auto-provisions; service identities never resolve).
 *
 * Caller must have checked that at least one secret is configured.
 */
export type McpTicketResult =
  | { ok: true; userId: string; claims: SsoTicketClaims; sub: string }
  | { ok: false; status: 401 | 404; error: string; code?: string };

/** Every secret an MCP ticket may be signed with on this server. */
export function mcpTicketSecrets(): string[] {
  return [config.OFFICIAL_COMMUNITY_SSO_SECRET, config.MCP_SIGNING_SECRET].filter(
    (s): s is string => !!s,
  );
}

export async function resolveMcpTicketUser(
  token: string,
  secrets: string[],
): Promise<McpTicketResult> {
  const invalid = { ok: false, status: 401, error: "Invalid service ticket" } as const;

  // Accept a ticket that verifies under EITHER secret — each attempt is an
  // independent constant-time HMAC check, and a ticket matching neither is
  // rejected. Order is irrelevant: a forged token fails both; a genuine one
  // matches exactly the secret that signed it.
  let claims: SsoTicketClaims | null = null;
  // A signature check can only find "expired" once it's already matched the
  // signing secret, so seeing that reason from ANY candidate means this was a
  // genuine ticket that aged out — not a forged/malformed one.
  let expired = false;
  for (const secret of secrets) {
    try {
      claims = verifySsoTicket(token, secret);
      break;
    } catch (err) {
      if (err instanceof SsoTokenError && err.message === "Ticket expired") {
        expired = true;
      }
      // Wrong secret (or malformed) — try the next candidate.
    }
  }
  if (!claims) {
    if (expired) {
      return {
        ok: false,
        status: 401,
        error: "Service ticket expired — reconnect to refresh.",
        code: "ticket_expired",
      };
    }
    return invalid;
  }
  // Require the MCP scope AND reject a present jti. A one-time-use jti is the
  // mark of an SSO *login* ticket (redeemable at GET /auth/sso for a browser
  // session); an MCP bearer must carry neither, so we don't rely on the
  // issuer keeping scope and jti mutually exclusive — this side enforces it,
  // and /auth/sso rejects scope "mcp" for the symmetric guarantee.
  if (claims.scope !== "mcp" || claims.jti) return invalid;

  // Audience binding — same policy as GET /auth/sso: enforced when
  // PUBLIC_BASE_URL is set (official deployments), so a ticket minted for
  // another server can't be replayed against this one.
  const expectedAud = config.PUBLIC_BASE_URL;
  if (expectedAud && (claims.aud || "").replace(/\/$/, "") !== expectedAud) {
    return invalid;
  }

  // Same sub-shape guard as GET /auth/sso: a whitespace/garbage sub must never
  // resolve a user here either.
  const sub = claims.sub.trim();
  if (!isValidTicketSub(sub)) return invalid;

  // People only: service identities (CU-wdqcq0314u access keys, personas) are
  // never a ticket's user.
  const user = (await getDb().get(
    "SELECT id FROM users WHERE LOWER(email) = LOWER(?) AND COALESCE(is_service, 0) = 0",
    [sub],
  )) as { id: string } | undefined;
  if (!user) {
    return {
      ok: false,
      status: 404,
      error: "No ContextNest account exists for this PromptOwl user",
    };
  }
  return { ok: true, userId: user.id, claims, sub };
}

/** True when a bearer token is shaped like a JWT rather than a cnst_ key. */
export function looksLikeTicket(token: string): boolean {
  return !!token && !token.startsWith("cnst_") && token.split(".").length === 3;
}
