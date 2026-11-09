/**
 * Return-after-sign-in for a nest link (PO-1189).
 *
 * A signed-out visitor who opens a link into a private nest (a channel
 * thread from a notification, a document) gets the login page, and the
 * address bar is cleared because the nest did not resolve for them. The link
 * is parked here so that, once they are signed in, the app opens what they
 * came for instead of the dashboard. sessionStorage, because some sign-in
 * methods leave the page and come back to `/`.
 *
 * Only this app's own `/nest/<id>…` paths are followed, so nothing stored or
 * crafted can turn this into an open redirect. Same shape as oauth-return.ts.
 */
const KEY = "cnst_nest_return";
/** A parked link older than this is a visit the person walked away from. */
const MAX_AGE_MS = 10 * 60_000;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** `value` if it is a path into a nest on this origin, else null. */
export function safeNestReturn(value: string | null | undefined): string | null {
  if (!value) return null;
  // The fixed prefix rules out `//host` and `/\host`; no scheme can precede it.
  return /^\/nest\/[^/?#\\]+(?:[/?#][^\\]*)?$/.test(value) ? value : null;
}

/** Park the link a signed-out visitor landed on (path + query). */
export function parkNestReturn(link: string, store: Store = sessionStorage, now = Date.now()): void {
  try {
    const value = safeNestReturn(link);
    if (value) store.setItem(KEY, JSON.stringify({ value, at: now }));
  } catch {
    // Storage unavailable: the visitor lands on the dashboard, as before.
  }
}

/** Take (and clear) the parked link, if one is still fresh. */
export function takeNestReturn(store: Store = sessionStorage, now = Date.now()): string | null {
  try {
    const raw = store.getItem(KEY);
    if (!raw) return null;
    store.removeItem(KEY);
    const { value, at } = JSON.parse(raw) as { value?: string; at?: number };
    if (!at || now - at > MAX_AGE_MS) return null;
    return safeNestReturn(value);
  } catch {
    return null;
  }
}
