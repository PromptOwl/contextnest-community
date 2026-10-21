/**
 * IndexNow (CU-wdqcq05jhm): when a docs site is rebuilt, tell Bing, Yandex,
 * Seznam, Naver and Yep which URLs changed, so they re-crawl in minutes rather
 * than weeks. Bing's index also feeds Copilot answers. Google doesn't take
 * part; it reads the sitemap's lastmod instead.
 *
 * The key file is served at `<site base>/<key>.txt`, and IndexNow only accepts
 * URLs under the key file's directory — which every page of the site is.
 * Best-effort and fire-and-forget: a failed ping never affects a request.
 */
import { isIP } from "node:net";
import type { Site } from "./build.js";
import { url } from "./render.js";

const ENDPOINT = "https://api.indexnow.org/indexnow";

/** Loopback, private ranges, IPv6 literals and names that only resolve on a LAN. */
export const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[)|\.(local|localhost|internal|lan|home\.arpa|corp|intranet)$/i;

/**
 * A name a public search engine can fetch. IP literals of any form are out
 * (IPv4-mapped IPv6 included), as are LAN-only names. Backstop only: a site
 * must also be on a verified host to ping at all (see getSite).
 */
export function isPublicHost(u: URL): boolean {
  const host = u.hostname.replace(/^\[|\]$/g, "");
  return host.includes(".") && isIP(host) === 0 && !PRIVATE_HOST.test(host) && !/\.(invalid|test|example)$/i.test(host);
}

/** Sites that may notify: public https hosts only, never tests or localhost. */
function canNotify(site: Site): boolean {
  if (site.settings.indexnow === false || site.settings.noindex) return false;
  if (process.env.NODE_ENV === "test" || process.env.VITEST) return false;
  try {
    const u = new URL(site.base);
    return isPublicHost(u) && u.protocol === "https:";
  } catch {
    return false;
  }
}

/** URLs added, changed or removed between two builds of the same site. */
export function changedUrls(before: Site, after: Site): string[] {
  const stamp = (s: Site) => new Map(s.pages.map((p) => [url(s, p.path), `${p.updated}|${p.title}|${p.description}`]));
  const a = stamp(before);
  const b = stamp(after);
  const out = new Set<string>();
  for (const [u, v] of b) if (a.get(u) !== v) out.add(u);
  for (const u of a.keys()) if (!b.has(u)) out.add(u);
  if (out.size) out.add(url(after, "sitemap.xml"));
  return [...out];
}

export async function pingIndexNow(before: Site, after: Site): Promise<void> {
  if (!canNotify(after) || before.base !== after.base) return;
  const urlList = changedUrls(before, after).slice(0, 10_000);
  if (!urlList.length) return;
  const host = new URL(after.base).host;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host, key: after.indexnowKey, keyLocation: url(after, `${after.indexnowKey}.txt`), urlList }),
    signal: AbortSignal.timeout(5000),
  });
  // 200/202 accepted; 4xx means a bad key, key file or URL list — worth seeing.
  if (!res.ok) throw new Error(`IndexNow answered ${res.status} for ${host}`);
}
