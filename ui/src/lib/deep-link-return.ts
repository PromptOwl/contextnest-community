/**
 * Return to a nest or document link after a sign-in that leaves the page
 * (PO-1391).
 *
 * A link to a private nest does not resolve for a signed-out visitor, so the
 * sign-in form shows. Signing in on the form keeps the page, and App opens the
 * link again (deepLinkToRetryAfterSignIn in nest-url.ts). PromptOwl, Google
 * and single sign-on leave the page and the server sends the browser back to
 * `/`, so the link is parked in this tab's sessionStorage first and opened on
 * return. Same approach as oauth-return.ts; the server is not involved and no
 * redirect parameter exists to tamper with.
 *
 * Only a path inside this app that names a nest is ever parked or followed
 * (safeDeepLink), so nothing stored or crafted can turn this into an open
 * redirect. The link is only an address: opening it goes through the server's
 * access rules like any other.
 */
import { nestIdFromLocation } from "./nest-url";

const KEY = "cnst_deep_link_return";
/** Long enough for a sign-in with a second factor; after that, they moved on. */
const MAX_AGE_MS = 30 * 60_000;

export type LinkStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function tabStore(): LinkStore | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The link, if it is a path in this app that names a nest; else null.
 * One leading slash, no backslash, no control character or space: that rules
 * out `//host`, `/\host` and scheme URLs before anything is parsed. The parse
 * then confirms the browser would stay on this origin and on the same path.
 */
export function safeDeepLink(value: string | null | undefined): string | null {
  if (!value || value[0] !== "/" || value[1] === "/") return null;
  if (/[\\\u0000- \u007f]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, "https://app.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://app.invalid" || url.pathname + url.search + url.hash !== value) return null;
  return nestIdFromLocation({ pathname: url.pathname, search: url.search }) ? value : null;
}

/** Park a link that did not open while signed out. */
export function parkDeepLink(link: string | null, store: LinkStore | null = tabStore(), now = Date.now()): void {
  const value = safeDeepLink(link);
  if (!value || !store) return;
  try {
    store.setItem(KEY, JSON.stringify({ value, at: now }));
  } catch {
    // Storage disabled: after an outside sign-in the person lands on Home.
  }
}

/** Drop the parked link: it was opened, or no longer applies. */
export function clearParkedDeepLink(store: LinkStore | null = tabStore()): void {
  try {
    store?.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Take (and clear) the parked link, if it is still fresh and still safe. */
export function takeParkedDeepLink(store: LinkStore | null = tabStore(), now = Date.now()): string | null {
  if (!store) return null;
  try {
    const raw = store.getItem(KEY);
    if (!raw) return null;
    store.removeItem(KEY);
    const { value, at } = JSON.parse(raw) as { value?: string; at?: number };
    if (typeof at !== "number" || now - at > MAX_AGE_MS || now < at) return null;
    return safeDeepLink(value);
  } catch {
    return null;
  }
}

/**
 * Whether to open the parked link now: at the moment this page learns the
 * person is signed in (`firstLook`), and only when it is sitting on plain
 * Home. A
 * link or page the person opened themselves is never replaced, and a failed
 * outside sign-in (`?sso_error=`) keeps its message.
 */
export function deepLinkToOpenOnReturn(a: {
  sessionKnown: boolean;
  signedIn: boolean;
  firstLook: boolean;
  probeStatus: string;
  pathname: string;
  search: string;
}): boolean {
  if (!a.sessionKnown || !a.signedIn || !a.firstLook) return false;
  if (a.probeStatus !== "idle") return false;
  if (a.pathname !== "/") return false;
  return !new URLSearchParams(a.search).has("sso_error");
}
