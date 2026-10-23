/**
 * Return-after-sign-in for the MCP OAuth flow.
 *
 * A signed-out GET /oauth/authorize?... is answered with this app's shell, so
 * the user signs in on the normal login page with the authorize URL still in
 * the address bar. Once signed in, the app reloads that URL and the server
 * shows the consent page. The URL is parked in sessionStorage because some
 * sign-in methods (OIDC, PromptOwl) leave the page and come back to `/`.
 *
 * Only same-origin /oauth/authorize paths are followed, so nothing stored or
 * crafted can turn this into an open redirect.
 */
const KEY = "cnst_oauth_return";
const BOUNCED = "cnst_oauth_bounced";
/** A parked return older than this is a flow the user walked away from. */
const MAX_AGE_MS = 10 * 60_000;
/** Back on the authorize page this soon after a bounce means the server still
 *  sees no session — stay on the login page rather than loop. */
const BOUNCE_GUARD_MS = 10_000;

export function isOAuthPath(pathname: string): boolean {
  return pathname.startsWith("/oauth/");
}

export function safeOAuthReturn(value: string | null | undefined): string | null {
  if (!value) return null;
  // The fixed prefix also rules out `//host` and `/\host` protocol-relative URLs.
  return value.startsWith("/oauth/authorize?") ? value : null;
}

/** On the authorize page: park its URL for after sign-in. */
export function captureOAuthReturn(): void {
  try {
    const { pathname, search } = window.location;
    if (pathname !== "/oauth/authorize") return;
    const bounced = Number(sessionStorage.getItem(BOUNCED) || 0);
    sessionStorage.removeItem(BOUNCED);
    if (Date.now() - bounced < BOUNCE_GUARD_MS) return;
    const value = safeOAuthReturn(pathname + search);
    if (value) sessionStorage.setItem(KEY, JSON.stringify({ value, at: Date.now() }));
  } catch {
    // Storage disabled: the user lands on the app after sign-in; reconnecting
    // from the client starts the flow again.
  }
}

/** Take (and clear) the parked return, if one is still fresh. */
export function takeOAuthReturn(): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    const { value, at } = JSON.parse(raw) as { value?: string; at?: number };
    if (!at || Date.now() - at > MAX_AGE_MS) return null;
    const safe = safeOAuthReturn(value);
    if (safe) sessionStorage.setItem(BOUNCED, String(Date.now()));
    return safe;
  } catch {
    return null;
  }
}
