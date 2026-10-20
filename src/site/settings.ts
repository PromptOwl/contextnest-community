/**
 * Public docs site settings (CU-wdqcq05jhm) — what a nest owner configures for
 * the static site their public Reader Mode nest publishes: a custom domain,
 * the site's public URL, SEO metadata, AI-crawler policy, custom page URLs and
 * redirects. One `nest_sites` row per nest, created on first read.
 *
 * Custom domains are claimed, then proven: the owner adds a DNS TXT record
 * carrying the nest's token and the server checks it. Only a verified domain
 * is ever served or answered by the TLS `ask` endpoint, so pointing DNS at us
 * — or typing someone else's domain into the form — can't hijack anything.
 */
import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { z } from "zod";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { ValidationError, ConflictError } from "../shared/errors.js";

export const SiteSettingsSchema = z.strictObject({
  /** The site's name in titles and the header. Default: branding site_title, then the nest name. */
  title: z.string().trim().max(120).optional(),
  /** Home page / site description (meta description, llms.txt summary). */
  description: z.string().trim().max(300).optional(),
  /**
   * Where the site really lives when it is served through your own reverse
   * proxy, e.g. "https://example.com/docs". Canonicals, the sitemap and
   * llms.txt use it, and /d/<key> 301s there. A verified custom domain wins.
   */
  public_url: z.string().trim().url().max(300).optional(),
  /** Share image (1200×630 recommended) for every page. Default: branding banner, then logo. */
  og_image_url: z.string().trim().url().max(500).optional(),
  /** Publisher shown in structured data. */
  organization_name: z.string().trim().max(120).optional(),
  organization_url: z.string().trim().url().max(300).optional(),
  organization_logo_url: z.string().trim().url().max(500).optional(),
  /** Profiles that identify the organization (GitHub, LinkedIn, X…) — schema.org sameAs. */
  same_as: z.array(z.string().trim().url().max(300)).max(10).optional(),
  twitter_site: z.string().trim().regex(/^@?\w{1,15}$/).optional(),
  google_site_verification: z.string().trim().regex(/^[\w-]{10,100}$/).optional(),
  bing_site_verification: z.string().trim().regex(/^[\w-]{10,100}$/).optional(),
  /** BCP 47 language of the content. Default "en". */
  language: z.string().trim().regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/).optional(),
  /** Keep the whole site out of search engines (staging, private betas). */
  noindex: z.boolean().optional(),
  /** Allow AI model training on the content (robots.txt + Content-Signal). Default true. */
  ai_training: z.boolean().optional(),
  /** Show "Copy page" / "Open in ChatGPT / Claude" on each page. Default true. */
  ai_actions: z.boolean().optional(),
  /** Notify Bing, Yandex & co. via IndexNow when pages change. Default true. */
  indexnow: z.boolean().optional(),
  /** Manual 301s: an old path on this site → a site path or an absolute URL. */
  redirects: z
    .array(z.strictObject({ from: z.string().trim().min(1).max(300), to: z.string().trim().min(1).max(500) }))
    .max(500)
    .optional(),
});
export type SiteSettings = z.infer<typeof SiteSettingsSchema>;

export interface SiteRow {
  nestId: string;
  /** The /d/<key> segment, fixed the first time the site is built. */
  siteKey: string | null;
  domain: string | null;
  domainToken: string;
  domainVerifiedAt: string | null;
  settings: SiteSettings;
  indexnowKey: string;
}

interface DbRow {
  nest_id: string;
  site_key: string | null;
  domain: string | null;
  domain_token: string;
  domain_verified_at: string | null;
  settings: string;
  indexnow_key: string;
}

function toRow(r: DbRow): SiteRow {
  let settings: SiteSettings = {};
  try {
    const parsed = SiteSettingsSchema.safeParse(JSON.parse(r.settings || "{}"));
    if (parsed.success) settings = parsed.data;
  } catch {
    /* unreadable settings read as defaults */
  }
  return {
    nestId: r.nest_id,
    siteKey: r.site_key,
    domain: r.domain,
    domainToken: r.domain_token,
    domainVerifiedAt: r.domain_verified_at,
    settings,
    indexnowKey: r.indexnow_key,
  };
}

/** The nest's site row, created with fresh tokens the first time it is asked for. */
export async function getSiteRow(nestId: string): Promise<SiteRow> {
  const db = getDb();
  const found = (await db.get("SELECT * FROM nest_sites WHERE nest_id = ?", [nestId])) as DbRow | undefined;
  if (found) return toRow(found);
  await db.run(
    "INSERT INTO nest_sites (nest_id, domain_token, indexnow_key) VALUES (?, ?, ?) ON CONFLICT (nest_id) DO NOTHING",
    [nestId, randomBytes(16).toString("hex"), randomBytes(16).toString("hex")],
  );
  return toRow((await db.get("SELECT * FROM nest_sites WHERE nest_id = ?", [nestId])) as DbRow);
}

/**
 * The nest's permanent /d/<key>: its slug when no other site holds it, else
 * its id. Assigned once and kept, so a site's URLs never move — not when the
 * nest is renamed, and not to another nest when this one goes private.
 */
export async function ensureSiteKey(nestId: string, slug: string): Promise<string> {
  const row = await getSiteRow(nestId);
  if (row.siteKey) return row.siteKey;
  const db = getDb();
  const taken = await db.get("SELECT 1 FROM nest_sites WHERE site_key = ? AND nest_id != ?", [slug, nestId]);
  const key = taken ? nestId : slug;
  try {
    await db.run("UPDATE nest_sites SET site_key = ? WHERE nest_id = ? AND site_key IS NULL", [key, nestId]);
  } catch {
    // Lost a race for the slug: fall back to the id, which nobody else can hold.
    await db.run("UPDATE nest_sites SET site_key = ? WHERE nest_id = ? AND site_key IS NULL", [nestId, nestId]);
  }
  return (await getSiteRow(nestId)).siteKey!;
}

/** The nest that holds a /d/<key>, whatever its state now. */
export async function nestIdForSiteKey(key: string): Promise<string | null> {
  const row = (await getDb().get("SELECT nest_id FROM nest_sites WHERE site_key = ? OR nest_id = ?", [key, key])) as
    | { nest_id: string }
    | undefined;
  return row?.nest_id ?? null;
}

/** Site rows for several nests, without creating any. */
export async function siteRowsFor(nestIds: string[]): Promise<Map<string, SiteRow>> {
  if (nestIds.length === 0) return new Map();
  const rows = (await getDb().all(
    `SELECT * FROM nest_sites WHERE nest_id IN (${nestIds.map(() => "?").join(",")})`,
    nestIds,
  )) as DbRow[];
  return new Map(rows.map((r) => [r.nest_id, toRow(r)]));
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** "https://Docs.Example.com/x" → "docs.example.com"; rejects IPs, ports and our own host. */
export function normalizeDomain(input: string): string {
  let host = input.trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, "").split("/")[0].replace(/\.$/, "");
  if (!HOSTNAME.test(host)) throw new ValidationError("Enter a domain name like docs.example.com");
  const own = [config.PUBLIC_BASE_URL]
    .filter(Boolean)
    .map((u) => {
      try {
        return new URL(u).hostname.toLowerCase();
      } catch {
        return "";
      }
    });
  if (own.includes(host)) throw new ValidationError("That is this server's own address");
  return host;
}

export async function updateSite(
  nestId: string,
  patch: { domain?: string | null; settings?: unknown },
): Promise<SiteRow> {
  const row = await getSiteRow(nestId);
  const db = getDb();
  if (patch.settings !== undefined) {
    const parsed = SiteSettingsSchema.safeParse(patch.settings ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ValidationError(`settings.${issue.path.join(".")}: ${issue.message}`);
    }
    for (const r of parsed.data.redirects ?? []) {
      if (!r.from.startsWith("/")) throw new ValidationError(`Redirect "from" must be a path starting with "/": ${r.from}`);
      if (!r.to.startsWith("/") && !/^https:\/\//.test(r.to)) {
        throw new ValidationError(`Redirect "to" must be a path or an https:// URL: ${r.to}`);
      }
    }
    await db.run("UPDATE nest_sites SET settings = ?, updated_at = ? WHERE nest_id = ?", [
      JSON.stringify(parsed.data),
      new Date().toISOString(),
      nestId,
    ]);
  }
  if (patch.domain !== undefined) {
    const domain = patch.domain ? normalizeDomain(patch.domain) : null;
    if (domain !== row.domain) {
      // A new domain starts unverified; the TXT token stays the nest's own.
      await db.run("UPDATE nest_sites SET domain = ?, domain_verified_at = NULL, updated_at = ? WHERE nest_id = ?", [
        domain,
        new Date().toISOString(),
        nestId,
      ]);
      clearDomainCache();
    }
  }
  return getSiteRow(nestId);
}

/** The TXT record a domain owner adds to prove control. */
export function verificationRecord(row: SiteRow): { name: string; value: string } | null {
  if (!row.domain) return null;
  return { name: `_contextnest.${row.domain}`, value: `contextnest-site=${row.domainToken}` };
}

export type TxtResolver = (name: string) => Promise<string[][]>;
let txtResolver: TxtResolver = resolveTxt;
/** Tests swap DNS out. */
export function setTxtResolverForTests(r: TxtResolver | null): void {
  txtResolver = r ?? resolveTxt;
}

export async function verifyDomain(nestId: string): Promise<SiteRow> {
  const row = await getSiteRow(nestId);
  const record = verificationRecord(row);
  if (!record) throw new ValidationError("Set a domain first");
  let found: string[] = [];
  try {
    found = (await txtResolver(record.name)).map((parts) => parts.join(""));
  } catch {
    found = [];
  }
  if (!found.includes(record.value)) {
    throw new ValidationError(
      `TXT record not found yet. Add ${record.name} with the value ${record.value} (DNS changes can take a few minutes).`,
    );
  }
  const taken = (await getDb().get(
    "SELECT nest_id FROM nest_sites WHERE domain = ? AND domain_verified_at IS NOT NULL AND nest_id != ?",
    [row.domain, nestId],
  )) as { nest_id: string } | undefined;
  if (taken) throw new ConflictError("That domain is already serving another nest's site");
  await getDb().run("UPDATE nest_sites SET domain_verified_at = ?, updated_at = ? WHERE nest_id = ?", [
    new Date().toISOString(),
    new Date().toISOString(),
    nestId,
  ]);
  clearDomainCache();
  return getSiteRow(nestId);
}

// Every request asks "is this Host a docs domain?", so the answer is cached
// per host for a short while. A settings change on this instance clears it at
// once; other instances pick it up within the TTL.
const DOMAIN_TTL_MS = 30_000;
const domainCache = new Map<string, { nestId: string | null; at: number }>();
export function clearDomainCache(): void {
  domainCache.clear();
}

/** The nest whose site a verified domain serves (DOCS_SITES env first). */
export async function nestIdForDomain(host: string | undefined): Promise<string | null> {
  if (!host) return null;
  const h = host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  const fromEnv = config.DOCS_SITES.get(h);
  if (fromEnv) return fromEnv;
  if (!HOSTNAME.test(h)) return null;
  const cached = domainCache.get(h);
  if (cached && Date.now() - cached.at < DOMAIN_TTL_MS) return cached.nestId;
  const row = (await getDb().get(
    "SELECT nest_id FROM nest_sites WHERE domain = ? AND domain_verified_at IS NOT NULL",
    [h],
  )) as { nest_id: string } | undefined;
  if (domainCache.size > 1000) domainCache.clear();
  domainCache.set(h, { nestId: row?.nest_id ?? null, at: Date.now() });
  return row?.nest_id ?? null;
}

/** The domain a nest's site is served on, if any (DOCS_SITES env first). */
export function domainForNest(nestId: string, row: SiteRow | undefined): string | null {
  for (const [host, id] of config.DOCS_SITES) if (id === nestId) return host;
  return row?.domain && row.domainVerifiedAt ? row.domain : null;
}

// ─── Page paths: custom URLs and redirect history ───────────────────────────

/** "/Guides/Setup/" → "guides/setup". Lowercase, safe characters, no leading/trailing slash. */
export function normalizePath(input: string): string {
  const p = input
    .trim()
    .replace(/^https?:\/\/[^/]+/i, "")
    .replace(/[?#].*$/, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  if (p && !/^[a-z0-9][a-z0-9._~-]*(\/[a-z0-9][a-z0-9._~-]*)*$/.test(p)) {
    throw new ValidationError("A page URL may use a–z, 0–9, '-', '_', '.', '~' and '/' between segments");
  }
  if (/\.(md|txt|xml)$/.test(p) || /^(sitemap|robots|llms|llms-full)(\.|$)/.test(p) || p.startsWith("tags/") || p === "tags" || p === "glossary") {
    throw new ValidationError("That URL is reserved by the site");
  }
  return p;
}

export async function sitePaths(nestId: string): Promise<Array<{ path: string; nodeId: string; kind: "custom" | "history" }>> {
  const rows = (await getDb().all("SELECT path, node_id, kind FROM site_paths WHERE nest_id = ?", [nestId])) as Array<{
    path: string;
    node_id: string;
    kind: "custom" | "history";
  }>;
  return rows.map((r) => ({ path: r.path, nodeId: r.node_id, kind: r.kind }));
}

/** Give a page its own URL (null clears it). The old URL keeps working as a 301. */
export async function setCustomPath(nestId: string, nodeId: string, path: string | null): Promise<void> {
  const db = getDb();
  if (path === null) {
    await db.run("UPDATE site_paths SET kind = 'history' WHERE nest_id = ? AND node_id = ? AND kind = 'custom'", [nestId, nodeId]);
    return;
  }
  const p = normalizePath(path);
  if (!p) throw new ValidationError("Use the Home document setting to put a page at the site root");
  const holder = (await db.get("SELECT node_id, kind FROM site_paths WHERE nest_id = ? AND path = ?", [nestId, p])) as
    | { node_id: string; kind: string }
    | undefined;
  if (holder && holder.node_id !== nodeId && holder.kind === "custom") {
    throw new ConflictError(`/${p} is already another page's URL`);
  }
  await db.run("UPDATE site_paths SET kind = 'history' WHERE nest_id = ? AND node_id = ? AND kind = 'custom'", [nestId, nodeId]);
  if (holder) {
    await db.run("UPDATE site_paths SET node_id = ?, kind = 'custom' WHERE nest_id = ? AND path = ?", [nodeId, nestId, p]);
  } else {
    await db.run("INSERT INTO site_paths (nest_id, path, node_id, kind) VALUES (?, ?, ?, 'custom')", [nestId, p, nodeId]);
  }
}

/** Remember where pages are served, so a later move 301s from here. Idempotent. */
export async function recordPaths(nestId: string, pages: Array<{ path: string; nodeId: string }>, known: Set<string>): Promise<void> {
  const db = getDb();
  for (const p of pages) {
    if (!p.path || known.has(p.path)) continue;
    await db.run(
      "INSERT INTO site_paths (nest_id, path, node_id, kind) VALUES (?, ?, ?, 'history') ON CONFLICT (nest_id, path) DO UPDATE SET node_id = excluded.node_id WHERE site_paths.kind = 'history'",
      [nestId, p.path, p.nodeId],
    );
  }
}
