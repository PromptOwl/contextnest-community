/**
 * OAuth discovery documents for the MCP authorization server.
 *
 * These two documents are the entire handshake an MCP client performs before
 * it will start an authorization flow. They are pure functions of the server's
 * canonical base URL so they can be asserted in tests rather than discovered
 * to be wrong in production — every field below is load-bearing for at least
 * one client, and getting one subtly wrong produces a connection that fails
 * with no useful error.
 *
 * Specs: RFC 9728 (protected resource metadata), RFC 8414 (authorization
 * server metadata), RFC 7636 (PKCE), RFC 8707 (resource indicators), and the
 * MCP authorization spec, which selects a subset of OAuth 2.1.
 */

/** Scopes this server issues. */
export const SCOPE_READ = "nests:read";
export const SCOPE_WRITE = "nests:write";
/** Asking for this is how a client signals it wants a refresh token. */
export const SCOPE_OFFLINE = "offline_access";

/**
 * The scopes a client asks for when it connects. Sent in the
 * `WWW-Authenticate` challenge, which MCP clients request verbatim: with read
 * alone a connected agent could never save a note (a refused write is a tool
 * error, so no client steps up), and without offline_access it got no refresh
 * token and was signed out hourly. The consent page lists all three.
 */
export const CHALLENGE_SCOPE = [SCOPE_READ, SCOPE_WRITE, SCOPE_OFFLINE].join(" ");

/** Where the protected resource metadata for the server-level endpoint lives. */
export const PRM_PATH = "/.well-known/oauth-protected-resource/mcp";
/** Where the authorization server metadata lives. */
export const ASM_PATH = "/.well-known/oauth-authorization-server";

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  registration_endpoint: string;
  scopes_supported: string[];
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  client_id_metadata_document_supported: boolean;
}

/** Trailing slashes are legal in config and poison an exact-match comparison. */
function canonical(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * RFC 9728. Describes the MCP endpoint and points at the authorization server.
 *
 * `resource` must equal the MCP server URL **exactly as the user enters it in
 * their client** — Claude compares the two and refuses a mismatch, so a bare
 * origin or a trailing slash here is a silent connection failure.
 *
 * `authorization_servers` may list several, but Claude uses the FIRST entry
 * and does not fall back to later ones. This server is its own AS, so there is
 * only ever one.
 */
export function protectedResourceMetadata(
  baseUrl: string,
): ProtectedResourceMetadata {
  const base = canonical(baseUrl);
  return {
    resource: `${base}/mcp`,
    authorization_servers: [base],
    // The minimal set for basic functionality, per the spec's scope
    // minimization guidance. offline_access is deliberately absent: it is not
    // a permission on this resource, it is a request to the AS for a refresh
    // token, and it is advertised there instead.
    scopes_supported: [SCOPE_READ, SCOPE_WRITE],
    // Never the query string — the MCP spec prohibits access tokens in a URI,
    // and a credential in a URL leaks through logs, proxies and history.
    bearer_methods_supported: ["header"],
  };
}

/**
 * RFC 8414. Tells a client where to send the user and how to exchange a code.
 *
 * Two fields decide how clients register with us, and they work as a pair.
 * We advertise CIMD as unsupported for now (see below), so clients use DCR.
 * Claude selects Client ID Metadata Documents only when the metadata carries
 * BOTH `client_id_metadata_document_supported: true` AND `"none"` in
 * `token_endpoint_auth_methods_supported` (its CIMD client authenticates as a
 * public client). Drop either and it silently falls back to Dynamic Client
 * Registration, which registers a fresh client on every new connection.
 *
 * `code_challenge_methods_supported` is not optional in practice: MCP clients
 * MUST refuse to proceed when it is absent, because it is the only way they
 * can verify PKCE support before starting a flow.
 */
export function authorizationServerMetadata(
  baseUrl: string,
): AuthorizationServerMetadata {
  const base = canonical(baseUrl);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    revocation_endpoint: `${base}/oauth/revoke`,
    registration_endpoint: `${base}/oauth/register`,
    scopes_supported: [SCOPE_READ, SCOPE_WRITE, SCOPE_OFFLINE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    // false until CIMD is implemented: `getClient` only resolves clients that
    // registered through `/oauth/register`, so advertising CIMD would send
    // Claude down a path that ends in "unknown client". false makes it use DCR,
    // which works today.
    client_id_metadata_document_supported: false,
  };
}

/**
 * The `WWW-Authenticate` value for an unauthenticated MCP request.
 *
 * This header on a **401** is the only thing that starts the flow: Claude
 * ignores the header on a 200, and treats a tool-level error as a tool error.
 * The `resource_metadata` pointer saves the client from probing well-known
 * paths, and works even when the metadata is hosted off-origin.
 */
export function mcpChallenge(baseUrl: string, error?: "invalid_token"): string {
  const base = canonical(baseUrl);
  return [
    "Bearer",
    ...(error ? [`error="${error}"`] : []),
    `resource_metadata="${base}${PRM_PATH}"`,
    `scope="${CHALLENGE_SCOPE}"`,
  ].join(" ");
}
