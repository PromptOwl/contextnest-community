import { config } from "../config.js";

/**
 * Public base URL for building user-facing links (e.g. the "Open document"
 * button in a notification email). Prefers the explicit PUBLIC_BASE_URL when
 * an admin has set one — that's the only value that's correct behind a reverse
 * proxy that rewrites Host — and otherwise derives the origin from the incoming
 * request URL so links work out of the box without any configuration. Empty
 * only when neither is available (e.g. a non-HTTP-triggered code path).
 */
export function requestBaseUrl(reqUrl: string): string {
  if (config.PUBLIC_BASE_URL) return config.PUBLIC_BASE_URL;
  try {
    return new URL(reqUrl).origin;
  } catch {
    return "";
  }
}
