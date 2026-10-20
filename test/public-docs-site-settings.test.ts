/**
 * CU-wdqcq05jhm — public docs site, part 2: what the owner configures (custom
 * domain, custom page URLs, redirects, SEO and AI-crawler settings), the
 * semantic links between pages, and the review-round hardening (malformed
 * URLs, bounded redirect caching, hostile Markdown, CSP without
 * 'unsafe-inline', a site that stops being public).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

const HTML = { Accept: "text/html" };

describe("docs site: settings, domains, URLs and semantic links", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let writer: { apiKey: string; email: string };
  let nestId: string;
  let otherId: string;
  let txt: Record<string, string[][]> = {};

  const get = (path: string, headers: Record<string, string> = HTML) => app.request(`http://localhost${path}`, { headers });
  const text = async (path: string, headers: Record<string, string> = HTML) => (await get(path, headers)).text();
  const site = (method: string, path: string, body: unknown, key = owner.apiKey) =>
    jsonRequest(app, method, `/nests/${nestId}/site${path}`, body, key);

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@test.com", "Owner");
    await resetAuthRateLimit();
    writer = await registerUser(app, "writer@test.com", "Writer");

    const created = await jsonRequest(app, "POST", "/nests", { name: "Acme Docs" }, owner.apiKey);
    nestId = created.data.nest.id;
    const add = (title: string, content: string, folder: string, tags: string[] = []) =>
      jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content, folder, tags }, owner.apiKey);
    await add("Welcome", "# Welcome\n\nStart with [[docs/guides/setup]]. Our Vault keeps context.", "docs");
    await add("Setup", "# Setup\n\nSee [the API](contextnest://nodes/docs/reference/api) and [[docs/reference/cli]].", "docs/guides", ["install", "cli"]);
    await add("API", "# API\n\nThe REST API.", "docs/reference", ["api"]);
    await add("CLI", "# CLI\n\nThe command line. A Vault is a folder.", "docs/reference", ["cli"]);
    await add("Commands", "# Commands\n\nEvery command.", "docs/reference", ["cli"]);
    await add(
      "Hostile",
      "# Hostile\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1))\n\n<script>alert(2)</script>",
      "docs/guides",
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/definitions`, { term: "Vault", definition: "A folder of governed Markdown documents.", linked_tag: "cli" }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: writer.email, permission: "write" }, owner.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${nestId}/reader-mode`, { enabled: true }, owner.apiKey);

    // A second owner's nest with the same name → same slug.
    await resetAuthRateLimit();
    const other = await registerUser(app, "other@test.com", "Other");
    const o = await jsonRequest(app, "POST", "/nests", { name: "Acme Docs" }, other.apiKey);
    otherId = o.data.nest.id;
    await jsonRequest(app, "POST", `/nests/${otherId}/nodes`, { title: "Welcome", content: "# Welcome\n\nother site" }, other.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${otherId}/visibility`, { visibility: "public", acknowledge_public: true }, other.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${otherId}/reader-mode`, { enabled: true }, other.apiKey);

    const settings = await import("../src/site/settings.js");
    settings.setTxtResolverForTests(async (name: string) => {
      if (!txt[name]) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return txt[name];
    });
  }, 120000);

  afterAll(() => env.cleanup());

  // ── Semantic links ──

  it("links every way a body can name a page, and lists backlinks", async () => {
    const setup = await text("/d/acme-docs/guides/setup");
    expect(setup).toContain('href="/d/acme-docs/reference/api">the API</a>');
    expect(setup).toContain('href="/d/acme-docs/reference/cli"');
    const cli = await text("/d/acme-docs/reference/cli");
    expect(cli).toMatch(/Referenced by[\s\S]*href="\/d\/acme-docs\/guides\/setup"/);
  });

  it("ranks related pages by shared tags and links", async () => {
    const cli = await text("/d/acme-docs/reference/cli");
    expect(cli).toMatch(/Related pages[\s\S]*href="\/d\/acme-docs\/reference\/commands"/);
    // The pages a body links to are named in its structured data too.
    expect(await text("/d/acme-docs/guides/setup")).toMatch(/"mentions":\[[^\]]*"url":"http:\/\/localhost\/d\/acme-docs\/reference\/cli"/);
  });

  it("builds a topic hub for a tag two pages share, and none for a one-page tag", async () => {
    const hub = await get("/d/acme-docs/tags/cli");
    expect(hub.status).toBe(200);
    const html = await hub.text();
    expect(html).toContain("CollectionPage");
    expect(html).toContain("A folder of governed Markdown documents.");
    expect(html).toContain('href="/d/acme-docs/reference/commands"');
    expect((await get("/d/acme-docs/tags/api")).status).toBe(404);
    expect(await text("/d/acme-docs/sitemap.xml", {})).toContain("/d/acme-docs/tags/cli</loc>");
  });

  it("publishes the glossary and links a term's first mention on each page", async () => {
    const g = await text("/d/acme-docs/glossary");
    expect(g).toContain("DefinedTermSet");
    expect(g).toContain('<dt id="vault">Vault</dt>');
    const cli = await text("/d/acme-docs/reference/cli");
    expect(cli.match(/class="term"/g)?.length).toBe(1);
    expect(cli).toContain('<a href="/d/acme-docs/glossary#vault" class="term">Vault</a>');
  });

  // ── Hardening from review ──

  it("escapes hostile Markdown and pins inline code by CSP hash", async () => {
    const res = await get("/d/acme-docs/guides/hostile");
    const html = await res.text();
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("<script>alert(2)</script>");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toMatch(/script-src 'sha256-[^']+'/);
    expect(csp).toMatch(/style-src 'sha256-[^']+'/);
  });

  it("answers malformed percent-encoding with a 404, not a 500", async () => {
    expect((await get("/d/%E0%A4%A/")).status).toBe(404);
    expect((await get("/d/acme-docs/%E0%A4%A")).status).toBe(404);
  });

  it("gives the second nest with a taken slug its id as the key", async () => {
    const res = await get(`/d/${otherId}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("other site");
    expect(await text("/d/acme-docs/")).not.toContain("other site");
  });

  it("bounds redirect caching and varies the app redirect on the session", async () => {
    const r = await get(`/nest/${nestId}`);
    expect(r.status).toBe(301);
    expect(r.headers.get("cache-control")).toMatch(/max-age=\d+/);
    expect(r.headers.get("vary")).toMatch(/Cookie/);
    // A doc that isn't on the site lands on the home page, deliberately.
    const d = await get(`/?nest=${nestId}&doc=nodes/docs/not-published`);
    expect(d.headers.get("location")).toBe("http://localhost/d/acme-docs/");
  });

  // ── SEO and AI crawler signals ──

  it("serves per-site robots.txt naming AI search crawlers, with a Content-Signal", async () => {
    const r = await text("/d/acme-docs/robots.txt", {});
    expect(r).toContain("User-agent: OAI-SearchBot");
    expect(r).toContain("User-agent: Claude-SearchBot");
    expect(r).toContain("Content-Signal: search=yes, ai-input=yes, ai-train=yes");
    expect(r).toContain("Sitemap: http://localhost/d/acme-docs/sitemap.xml");
  });

  it("marks the Markdown twin noindex with a canonical Link to the HTML page", async () => {
    const md = await get("/d/acme-docs/guides/setup.md", {});
    expect(md.headers.get("x-robots-tag")).toBe("noindex");
    expect(md.headers.get("link")).toBe('<http://localhost/d/acme-docs/guides/setup>; rel="canonical"');
    const page = await get("/d/acme-docs/guides/setup");
    expect(page.headers.get("link")).toContain('</d/acme-docs/guides/setup.md>; rel="alternate"; type="text/markdown"');
    expect(page.headers.get("last-modified")).toBeTruthy();
  });

  it("offers copy-as-Markdown and open-in-assistant actions", async () => {
    const html = await text("/d/acme-docs/guides/setup");
    expect(html).toContain('data-copy="/d/acme-docs/guides/setup.md"');
    expect(html).toContain("https://claude.ai/new?q=");
    expect(html).toContain("https://chatgpt.com/?hints=search&amp;q=");
  });

  it("serves the IndexNow key file", async () => {
    const { data } = await site("GET", "", undefined);
    const { getSiteRow } = await import("../src/site/settings.js");
    const row = await getSiteRow(nestId);
    expect(data.live).toBe(true);
    const res = await get(`/d/acme-docs/${row.indexnowKey}.txt`, {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(row.indexnowKey);
  });

  // ── Settings API ──

  it("is owner/admin only", async () => {
    expect((await site("GET", "", undefined, writer.apiKey)).status).toBe(403);
    expect((await app.request(`/nests/${nestId}/site`)).status).toBeGreaterThanOrEqual(401);
  });

  it("applies SEO settings to every page", async () => {
    const res = await site("PATCH", "", {
      settings: {
        title: "Acme Developer Docs",
        description: "How to build on Acme.",
        og_image_url: "https://cdn.example.com/og.png",
        organization_name: "Acme Inc",
        same_as: ["https://github.com/acme"],
        google_site_verification: "abc123def456ghi789",
        language: "en-US",
        ai_training: false,
      },
    });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const html = await text("/d/acme-docs/guides/setup");
    expect(html).toMatch(/<title>Setup — Acme Developer Docs<\/title>/);
    expect(html).toContain('<meta property="og:image" content="https://cdn.example.com/og.png">');
    expect(html).toContain('<meta name="google-site-verification" content="abc123def456ghi789">');
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain('"sameAs":["https://github.com/acme"]');
    const robots = await text("/d/acme-docs/robots.txt", {});
    expect(robots).toMatch(/User-agent: GPTBot[\s\S]*?Disallow: \//);
    expect(robots).toContain("ai-train=no");
    expect(robots).toMatch(/User-agent: OAI-SearchBot[\s\S]*?Allow: \//);
  });

  it("rejects invalid settings", async () => {
    expect((await site("PATCH", "", { settings: { og_image_url: "not a url" } })).status).toBe(400);
    expect((await site("PATCH", "", { settings: { bogus: true } })).status).toBe(400);
    expect((await site("PATCH", "", { settings: { redirects: [{ from: "old", to: "/x" }] } })).status).toBe(400);
  });

  it("gives a page a custom URL and 301s its old one", async () => {
    const r = await site("PUT", "/pages", { node_id: "nodes/docs/guides/setup", path: "/Getting-Started" });
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(r.data.pages.find((p: any) => p.node_id === "nodes/docs/guides/setup")).toMatchObject({ path: "getting-started", custom: true });
    expect(await text("/d/acme-docs/getting-started")).toContain("<h1>Setup</h1>");
    const old = await get("/d/acme-docs/guides/setup");
    expect(old.status).toBe(301);
    expect(old.headers.get("location")).toBe("/d/acme-docs/getting-started");
    // Links across the site follow the page to its new URL.
    expect(await text("/d/acme-docs/")).toContain('href="/d/acme-docs/getting-started"');
    expect((await site("PUT", "/pages", { node_id: "nodes/docs/reference/cli", path: "getting-started" })).status).toBe(409);
    expect((await site("PUT", "/pages", { node_id: "nodes/docs/reference/cli", path: "sitemap.xml" })).status).toBe(400);
  });

  it("follows manual redirects and answers 410 for a removed page", async () => {
    await site("PATCH", "", { settings: { redirects: [{ from: "/old-guide", to: "/getting-started" }] } });
    const r = await get("/d/acme-docs/old-guide");
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/d/acme-docs/getting-started");
    expect(await text("/d/acme-docs/reference/commands")).toContain("Every command");
    await jsonRequest(app, "DELETE", `/nests/${nestId}/nodes/nodes/docs/reference/commands`, undefined, owner.apiKey);
    const gone = await get("/d/acme-docs/reference/commands");
    expect(gone.status).toBe(410);
    expect(gone.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("301s a moved page's old URL to its new one", async () => {
    expect((await get("/d/acme-docs/reference/api")).status).toBe(200);
    const mv = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/nodes/docs/reference/api/move`, { folder: "docs/guides" }, owner.apiKey);
    expect(mv.status, JSON.stringify(mv.data)).toBeLessThan(300);
    expect(await text("/d/acme-docs/guides/api")).toContain("The REST API.");
    const old = await get("/d/acme-docs/reference/api");
    expect(old.status).toBe(301);
    expect(old.headers.get("location")).toBe("/d/acme-docs/guides/api");
  });

  it("claims a custom domain, verifies it by DNS TXT and serves the site there", async () => {
    const claim = await site("PATCH", "", { domain: "https://Docs.Acme.dev/" });
    expect(claim.status, JSON.stringify(claim.data)).toBe(200);
    expect(claim.data).toMatchObject({ domain: "docs.acme.dev", domain_verified: false });
    const record = claim.data.dns.txt;
    expect(record.name).toBe("_contextnest.docs.acme.dev");
    // Not live before verification.
    // An unverified domain is just another Host: it never gets the docs site.
    const early = await app.request("https://docs.acme.dev/", { headers: HTML });
    expect(early.status === 200 ? await early.text() : "").not.toContain("Start with");
    expect((await app.request("http://localhost/site-domain-check?domain=docs.acme.dev")).status).toBe(404);
    expect((await site("POST", "/verify-domain", {})).status).toBe(400);

    txt[record.name] = [[record.value]];
    const ok = await site("POST", "/verify-domain", {});
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.domain_verified).toBe(true);
    expect(ok.data.url).toBe("https://docs.acme.dev/");

    const page = await app.request("https://docs.acme.dev/getting-started", { headers: { ...HTML, Host: "Docs.Acme.dev:443" } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<link rel="canonical" href="https://docs.acme.dev/getting-started">');
    expect((await app.request("http://localhost/site-domain-check?domain=docs.acme.dev")).status).toBe(200);
    const moved = await get("/d/acme-docs/getting-started");
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe("https://docs.acme.dev/getting-started");
    // The docs host is read-only and never reaches the API.
    expect((await app.request("https://docs.acme.dev/nests", { method: "POST", headers: { Host: "docs.acme.dev" } })).status).toBe(405);
  });

  it("won't let another owner touch this nest's site", async () => {
    const res = await jsonRequest(app, "PATCH", `/nests/${otherId}/site`, { domain: "docs.acme.dev" }, owner.apiKey);
    // Not this owner's nest at all.
    expect(res.status).toBe(403);
  });

  it("stops serving when the nest goes private, without stale redirects", async () => {
    await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "private" }, owner.apiKey);
    // The URL stays this nest's: the other "Acme Docs" doesn't inherit it.
    expect((await get("/d/acme-docs/")).status).toBe(404);
    expect((await get(`/d/${otherId}/`)).status).toBe(200);
    expect((await get(`/nest/${nestId}`)).status).not.toBe(301);
    expect((await app.request("https://docs.acme.dev/", { headers: { ...HTML, Host: "docs.acme.dev" } })).status).toBe(404);
    expect((await app.request("http://localhost/site-domain-check?domain=docs.acme.dev")).status).toBe(404);
  });
});

describe("docs site behind the owner's reverse proxy", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    const owner = await registerUser(app, "owner@test.com", "Owner");
    nestId = (await jsonRequest(app, "POST", "/nests", { name: "Proxied" }, owner.apiKey)).data.nest.id;
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Setup", content: "# Setup\n\nsteps", folder: "guides" }, owner.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${nestId}/reader-mode`, { enabled: true }, owner.apiKey);
    const r = await jsonRequest(app, "PATCH", `/nests/${nestId}/site`, { settings: { public_url: "https://example.com/docs" } }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
  }, 90000);

  afterAll(() => env.cleanup());

  it("serves proxied requests with the public URL's paths and canonicals", async () => {
    // Every page sits under one top folder ("guides/"), so URLs start inside it.
    const res = await app.request("http://localhost/d/proxied/setup", { headers: { ...HTML, "X-Forwarded-Host": "example.com" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<link rel="canonical" href="https://example.com/docs/setup">');
    expect(html).toContain('href="/docs/"');
  });

  it("301s direct hits to the public URL", async () => {
    const res = await app.request("http://localhost/d/proxied/setup", { headers: HTML });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://example.com/docs/setup");
  });
});
