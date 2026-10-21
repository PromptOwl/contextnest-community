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
import { ValidationError, ConflictError, NotFoundError } from "../shared/errors.js";

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
  /** The public_url host proven by DNS TXT; public_url counts only while it matches. */
  publicUrlHost: string | null;
}

interface DbRow {
  nest_id: string;
  site_key: string | null;
  domain: string | null;
  domain_token: string;
  domain_verified_at: string | null;
  settings: string;
  indexnow_key: string;
  public_url_host: string | null;
}

/**
 * Settings that can't be read must not loosen the site's crawler policy: keep
 * an owner's noindex and AI-training opt-out even when the rest is dropped.
 */
function readSettings(nestId: string, raw: string): SiteSettings {
  let json: unknown;
  try {
    json = JSON.parse(raw || "{}");
  } catch (err) {
    console.warn(`[site] nest ${nestId}: settings are not valid JSON; using defaults`, err);
    return {};
  }
  const parsed = SiteSettingsSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  console.warn(`[site] nest ${nestId}: stored settings no longer match the schema; keeping only the crawler policy`, parsed.error.issues[0]);
  const j = (json ?? {}) as Record<string, unknown>;
  return {
    ...(j.noindex === true ? { noindex: true } : {}),
    ...(j.ai_training === false ? { ai_training: false } : {}),
  };
}

function toRow(r: DbRow): SiteRow {
  const settings = readSettings(r.nest_id, r.settings);
  return {
    nestId: r.nest_id,
    siteKey: r.site_key,
    domain: r.domain,
    domainToken: r.domain_token,
    domainVerifiedAt: r.domain_verified_at,
    settings,
    indexnowKey: r.indexnow_key,
    publicUrlHost: r.public_url_host ?? null,
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
  // Claim the slug only if no other row holds it, in one statement — no
  // failing write to recover from (which would abort a Postgres transaction).
  // If another nest won the slug in a race, this nest takes its own id,
  // which nobody else can hold.
  await db.run(
    `UPDATE nest_sites SET site_key = ?
      WHERE nest_id = ? AND site_key IS NULL
        AND NOT EXISTS (SELECT 1 FROM nest_sites other WHERE other.site_key = ? AND other.nest_id != ?)`,
    [slug, nestId, slug, nestId],
  );
  await db.run("UPDATE nest_sites SET site_key = ? WHERE nest_id = ? AND site_key IS NULL", [nestId, nestId]);
  return (await getSiteRow(nestId)).siteKey!;
}

/**
 * Claim the nest's /d/<key> the moment it becomes a live site (public with
 * Reader Mode on), so when two nests share a slug the one published first
 * keeps it — decided by order of publishing, not by who is visited first.
 */
export async function claimSiteKeyIfLive(nestId: string): Promise<void> {
  const nest = (await getDb().get("SELECT slug, visibility, reader_mode FROM nests WHERE id = ?", [nestId])) as
    | { slug: string; visibility: string; reader_mode: number }
    | undefined;
  if (nest && nest.visibility === "public" && nest.reader_mode === 1) await ensureSiteKey(nestId, nest.slug);
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

/** "/a/b" — one leading slash, no backslash, no control characters or whitespace. */
export function isSitePath(v: string): boolean {
  return /^\/(?![/\\])[^\\\s\x00-\x1f\x7f]*$/.test(v);
}

function isHttpsUrl(v: string): boolean {
  if (/[\s\x00-\x1f\x7f\\]/.test(v)) return false;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !!u.hostname;
  } catch {
    return false;
  }
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
      if (!isSitePath(r.from)) throw new ValidationError(`Redirect "from" must be a path starting with "/": ${r.from}`);
      // "//evil.example" and "/\evil.example" read as other hosts in a browser:
      // a site path must be a plain path, and anything else an absolute https URL.
      if (!isSitePath(r.to) && !isHttpsUrl(r.to)) {
        throw new ValidationError(`Redirect "to" must be a path on this site or an https:// URL: ${r.to}`);
      }
      // An absolute target must stay on a host this nest proved it controls,
      // or the site becomes an open redirect on this server's origin.
      if (!isSitePath(r.to) && !trustedHosts(nestId, row, parsed.data).has(new URL(r.to).host.toLowerCase())) {
        throw new ValidationError(
          `Redirect "to" may only leave the site for its verified domain or verified public URL: ${r.to}`,
        );
      }
    }
    const loop = redirectLoops(parsed.data.redirects ?? []);
    if (loop.size) throw new ValidationError(`These redirects form a loop: /${[...loop].join(", /")}`);
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

/**
 * Hosts this nest proved it controls: its serving domain, and its public_url
 * host once that host passed the TXT check (verifyPublicUrl).
 */
export function trustedHosts(nestId: string, row: SiteRow, settings: SiteSettings = row.settings): Set<string> {
  const hosts = new Set<string>();
  const domain = domainForNest(nestId, row);
  if (domain) hosts.add(domain);
  const pub = publicUrlHost(settings);
  if (pub && (pub === row.publicUrlHost || pub === domain)) hosts.add(pub);
  return hosts;
}

function publicUrlHost(settings: SiteSettings): string | null {
  if (!settings.public_url) return null;
  try {
    return new URL(settings.public_url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** The public_url to use, or null while its host is not proven. */
export function verifiedPublicUrl(nestId: string, row: SiteRow): string | null {
  const host = publicUrlHost(row.settings);
  return host && trustedHosts(nestId, row).has(host) ? row.settings.public_url! : null;
}

/** "/Old/Path/" → "old/path": the key a redirect's from (or site-path to) is looked up by. */
export function redirectKey(path: string): string {
  return path.replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "").toLowerCase();
}

/** The `from` keys of manual redirects that never reach a page (a → b → a). */
export function redirectLoops(redirects: Array<{ from: string; to: string }>): Set<string> {
  const next = new Map<string, string>();
  for (const r of redirects) if (isSitePath(r.to)) next.set(redirectKey(r.from), redirectKey(r.to));
  const looping = new Set<string>();
  for (const start of next.keys()) {
    const seen = new Set<string>();
    let at: string | undefined = start;
    while (at !== undefined && next.has(at)) {
      if (seen.has(at)) {
        for (const k of seen) looping.add(k);
        break;
      }
      seen.add(at);
      at = next.get(at);
    }
  }
  return looping;
}

export type TxtResolver = (name: string) => Promise<string[][]>;
let txtResolver: TxtResolver = resolveTxt;
/** Tests swap DNS out. */
export function setTxtResolverForTests(r: TxtResolver | null): void {
  txtResolver = r ?? resolveTxt;
}

/**
 * Throw unless `name` carries the TXT `value`. "No such record" reads as not
 * added yet; any other DNS failure is logged and reported as one, so the owner
 * isn't told to add a record that may already be there.
 */
async function requireTxt(name: string, value: string): Promise<void> {
  let found: string[];
  try {
    found = (await txtResolver(name)).map((parts) => parts.join(""));
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== "ENOTFOUND" && code !== "ENODATA") {
      console.warn(`[site] TXT lookup for ${name} failed`, err);
      throw new ValidationError(`The DNS lookup for ${name} failed (${code ?? "error"}). Try again in a minute.`);
    }
    found = [];
  }
  if (!found.includes(value)) {
    throw new ValidationError(
      `TXT record not found yet. Add ${name} with the value ${value} (DNS changes can take a few minutes).`,
    );
  }
}

/** Prove control of the public_url's host with the nest's TXT token. */
export async function verifyPublicUrl(nestId: string): Promise<SiteRow> {
  const row = await getSiteRow(nestId);
  const host = publicUrlHost(row.settings);
  if (!host) throw new ValidationError("Set a public URL first");
  const hostname = host.replace(/:\d+$/, "");
  await requireTxt(`_contextnest.${hostname}`, `contextnest-site=${row.domainToken}`);
  await getDb().run("UPDATE nest_sites SET public_url_host = ?, updated_at = ? WHERE nest_id = ?", [
    host,
    new Date().toISOString(),
    nestId,
  ]);
  return getSiteRow(nestId);
}

export async function verifyDomain(nestId: string): Promise<SiteRow> {
  const row = await getSiteRow(nestId);
  const record = verificationRecord(row);
  if (!record) throw new ValidationError("Set a domain first");
  await requireTxt(record.name, record.value);
  const taken = (await getDb().get(
    "SELECT nest_id FROM nest_sites WHERE domain = ? AND domain_verified_at IS NOT NULL AND nest_id != ?",
    [row.domain, nestId],
  )) as { nest_id: string } | undefined;
  if (taken) throw new ConflictError("That domain is already serving another nest's site");
  try {
    await getDb().run("UPDATE nest_sites SET domain_verified_at = ?, updated_at = ? WHERE nest_id = ?", [
      new Date().toISOString(),
      new Date().toISOString(),
      nestId,
    ]);
  } catch (err) {
    // Two nests verifying the same domain at once: the partial unique index
    // lets exactly one through.
    if (/unique|constraint/i.test(String((err as Error)?.message ?? err))) {
      throw new ConflictError("That domain is already serving another nest's site");
    }
    throw err;
  }
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

const REVERIFY_AFTER_MS = 24 * 60 * 60 * 1000;
const rechecking = new Set<string>();

/**
 * Re-run the TXT check for a verified domain. Found → the verification is
 * renewed; definitively gone (no record / wrong value) → the domain is
 * un-verified and stops serving. A DNS error (timeout, SERVFAIL) changes
 * nothing, so a resolver hiccup can't take a site down.
 */
export async function recheckDomain(nestId: string): Promise<void> {
  if (rechecking.has(nestId)) return;
  rechecking.add(nestId);
  try {
    const row = await getSiteRow(nestId);
    const record = verificationRecord(row);
    if (!record || !row.domainVerifiedAt) return;
    let found: string[];
    try {
      found = (await txtResolver(record.name)).map((parts) => parts.join(""));
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code !== "ENOTFOUND" && code !== "ENODATA") return;
      found = [];
    }
    const now = new Date().toISOString();
    if (found.includes(record.value)) {
      await getDb().run("UPDATE nest_sites SET domain_verified_at = ? WHERE nest_id = ?", [now, nestId]);
    } else {
      console.warn(`[site] ${row.domain}: verification TXT record is gone; the domain no longer serves nest ${nestId}`);
      await getDb().run("UPDATE nest_sites SET domain_verified_at = NULL, updated_at = ? WHERE nest_id = ?", [now, nestId]);
    }
    clearDomainCache();
  } finally {
    rechecking.delete(nestId);
  }
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
    "SELECT nest_id, domain_verified_at FROM nest_sites WHERE domain = ? AND domain_verified_at IS NOT NULL",
    [h],
  )) as { nest_id: string; domain_verified_at: string } | undefined;
  // Proof of control goes stale: a domain that lapsed and was re-registered,
  // or whose TXT record was removed, must stop being served (and stop being
  // vouched for to the TLS edge). Re-check in the background once a day.
  if (row && Date.now() - Date.parse(row.domain_verified_at) > REVERIFY_AFTER_MS) {
    void recheckDomain(row.nest_id).catch((err) => console.warn(`[site] re-checking ${h} failed`, err));
  }
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
  // Only a published page can own a URL; a typo'd id would reserve the path for nothing.
  const page = await db.get("SELECT 1 AS ok FROM approved_versions WHERE nest_id = ? AND node_id = ?", [nestId, nodeId]);
  if (!page) throw new NotFoundError(`No published page ${nodeId} in this nest`);
  const holder = (await db.get("SELECT node_id, kind FROM site_paths WHERE nest_id = ? AND path = ?", [nestId, p])) as
    | { node_id: string; kind: string }
    | undefined;
  if (holder && holder.node_id !== nodeId && holder.kind === "custom") {
    throw new ConflictError(`/${p} is already another page's URL`);
  }
  try {
    // One transaction: a save that loses a race keeps the page's current URL.
    await db.transaction(async (tx) => {
      await tx.run("UPDATE site_paths SET kind = 'history' WHERE nest_id = ? AND node_id = ? AND kind = 'custom'", [nestId, nodeId]);
      if (holder) {
        await tx.run("UPDATE site_paths SET node_id = ?, kind = 'custom' WHERE nest_id = ? AND path = ?", [nodeId, nestId, p]);
      } else {
        await tx.run("INSERT INTO site_paths (nest_id, path, node_id, kind) VALUES (?, ?, ?, 'custom')", [nestId, p, nodeId]);
      }
    });
  } catch (err) {
    // Two saves of the same new path at once: the primary key lets one through.
    if (/unique|constraint/i.test(String((err as Error)?.message ?? err))) {
      throw new ConflictError(`/${p} is already another page's URL`);
    }
    throw err;
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
