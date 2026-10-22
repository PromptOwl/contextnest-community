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
  const fakeDns = async (name: string) => {
    if (!txt[name]) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return txt[name];
  };

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
    settings.setTxtResolverForTests(fakeDns);
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
    // CU-wdqcq05raw: a readable title (acronyms kept) and a description that
    // names the topic and counts its pages.
    expect(html).toContain("<title>CLI — Acme Docs</title>");
    expect(html).toContain("<h1>CLI</h1>");
    expect(html).toMatch(/<meta name="description" content="[^"]*3 pages[^"]*CLI[^"]*"/);
    expect((await get("/d/acme-docs/tags/api")).status).toBe(404);
    expect(await text("/d/acme-docs/sitemap.xml", {})).toContain("/d/acme-docs/tags/cli</loc>");
  });

  it("uses a description set through PATCH as the page's meta description (CU-wdqcq05raw)", async () => {
    const r = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/docs/reference/api`, { description: "Every REST endpoint, with examples." }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
    expect(await text("/d/acme-docs/reference/api")).toContain('<meta name="description" content="Every REST endpoint, with examples.">');
  });

  it("publishes the glossary and links a term's first mention on each page", async () => {
    const g = await text("/d/acme-docs/glossary");
    expect(g).toContain("DefinedTermSet");
    expect(g).toContain('<dt id="vault">Vault</dt>');
    const cli = await text("/d/acme-docs/reference/cli");
    expect(cli.match(/class="term"/g)?.length).toBe(1);
    expect(cli).toContain('<a href="/d/acme-docs/glossary#vault" class="term">Vault</a>');
  });

  it("publishes an editor's definition without review, like the reader's glossary (documented, by design)", async () => {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/definitions`, { term: "Steward", definition: "Approves changes." }, writer.apiKey);
    expect(r.status).toBeLessThan(300);
    expect(await text("/d/acme-docs/glossary")).toContain('<dt id="steward">Steward</dt>');
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
    await site("PATCH", "", { settings: { redirects: [{ from: "/old-guide", to: "/getting-started" }, { from: "/old-anchor", to: "/getting-started#install" }] } });
    const r = await get("/d/acme-docs/old-guide");
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/d/acme-docs/getting-started");
    // A .md request follows to the target's twin, before its fragment.
    expect((await get("/d/acme-docs/old-anchor.md")).headers.get("location")).toBe("/d/acme-docs/getting-started.md#install");
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
    // A fully-qualified Host (trailing dot) is the same domain.
    expect((await app.request("https://docs.acme.dev/getting-started", { headers: { ...HTML, Host: "docs.acme.dev." } })).status).toBe(200);
    expect((await app.request("http://localhost/site-domain-check?domain=docs.acme.dev")).status).toBe(200);
    // An edge may pass the SNI name with a port, a trailing dot or in capitals.
    for (const d of ["docs.acme.dev:443", "docs.acme.dev.", "DOCS.Acme.dev"]) {
      expect((await app.request(`http://localhost/site-domain-check?domain=${encodeURIComponent(d)}`)).status, d).toBe(200);
    }
    expect((await app.request("http://localhost/site-domain-check?domain=other.acme.dev")).status).toBe(404);
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

  it("refuses redirects that would leave the site through a protocol-relative path", async () => {
    for (const to of ["//evil.example", "/\\evil.example", "/ok\u0007x", "javascript:alert(1)", "http://plain.example"]) {
      const r = await site("PATCH", "", { settings: { redirects: [{ from: "/x", to }] } });
      expect(r.status, to).toBe(400);
    }
  });

  it("allows an https:// redirect only to a host the nest proved", async () => {
    const evil = await site("PATCH", "", { settings: { redirects: [{ from: "/x", to: "https://evil.example/phish" }] } });
    expect(evil.status).toBe(400);
    const own = await site("PATCH", "", { settings: { redirects: [{ from: "/x", to: "https://docs.acme.dev/getting-started" }] } });
    expect(own.status, JSON.stringify(own.data)).toBe(200);
  });

  it("refuses redirects that loop", async () => {
    const pair = [{ from: "/a", to: "/b" }, { from: "/b", to: "/a/" }];
    expect((await site("PATCH", "", { settings: { redirects: pair } })).status).toBe(400);
    expect((await site("PATCH", "", { settings: { redirects: [{ from: "/self", to: "/Self" }] } })).status).toBe(400);
  });

  it("gives a URL only to a published page of the nest", async () => {
    expect((await site("PUT", "/pages", { node_id: "nodes/no/such/page", path: "somewhere" })).status).toBe(404);
  });

  it("reports a DNS failure as a failure, not as a missing record", async () => {
    const settings = await import("../src/site/settings.js");
    const id = (await jsonRequest(app, "POST", "/nests", { name: "Dns Fail" }, owner.apiKey)).data.nest.id;
    await jsonRequest(app, "PATCH", `/nests/${id}/site`, { domain: "fail.acme.dev" }, owner.apiKey);
    settings.setTxtResolverForTests(async () => {
      throw Object.assign(new Error("queryTxt ESERVFAIL"), { code: "ESERVFAIL" });
    });
    try {
      const r = await jsonRequest(app, "POST", `/nests/${id}/site/verify-domain`, {}, owner.apiKey);
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.data)).toMatch(/lookup .* failed/);
    } finally {
      settings.setTxtResolverForTests(fakeDns);
    }
  });

  it("gives up on a DNS lookup that never answers instead of hanging the request", async () => {
    const settings = await import("../src/site/settings.js");
    const id = (await jsonRequest(app, "POST", "/nests", { name: "Dns Hang" }, owner.apiKey)).data.nest.id;
    await jsonRequest(app, "PATCH", `/nests/${id}/site`, { domain: "hang.acme.dev" }, owner.apiKey);
    settings.setTxtResolverForTests(() => new Promise(() => {}), 50);
    try {
      const started = Date.now();
      const r = await jsonRequest(app, "POST", `/nests/${id}/site/verify-domain`, {}, owner.apiKey);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.data)).toMatch(/lookup .* failed \(ETIMEOUT\)/);
      const after = await jsonRequest(app, "GET", `/nests/${id}/site`, undefined, owner.apiKey);
      expect(after.data.domain_verified).toBe(false);
    } finally {
      settings.setTxtResolverForTests(fakeDns);
    }
  });

  it("shares one build between requests that miss the cache together", async () => {
    const { buildCount } = await import("../src/site/build.js");
    const { getDb } = await import("../src/db/client.js");
    await getDb().run("UPDATE nest_sites SET settings = ? WHERE nest_id = ?", [JSON.stringify({ title: "Burst" }), nestId]);
    const before = buildCount();
    await Promise.all(Array.from({ length: 6 }, () => get("/d/acme-docs/")));
    expect(buildCount()).toBe(before + 1);
  });

  it("gives two nests publishing the same slug at once one key each, with no error", async () => {
    const make = async (key: string) => {
      const id = (await jsonRequest(app, "POST", "/nests", { name: "Race Docs" }, key)).data.nest.id;
      await jsonRequest(app, "POST", `/nests/${id}/nodes`, { title: "Home", content: "# Home\n\nrace" }, key);
      await jsonRequest(app, "PATCH", `/nests/${id}/visibility`, { visibility: "public", acknowledge_public: true }, key);
      return { id: id as string, key };
    };
    const nests = [await make(owner.apiKey), await make(writer.apiKey)];
    const res = await Promise.all(nests.map((n) => jsonRequest(app, "PATCH", `/nests/${n.id}/reader-mode`, { enabled: true }, n.key)));
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    const urls = await Promise.all(nests.map(async (n) => (await jsonRequest(app, "GET", `/nests/${n.id}/site`, undefined, n.key)).data.url));
    expect(new Set(urls).size).toBe(2);
    expect(urls.filter((u: string) => u.endsWith("/d/race-docs/"))).toHaveLength(1);
  });

  it("won't let a nest named after another nest's id take that nest's URL", async () => {
    // Acme's key is its slug, so its id is free for a squatter's slug to take.
    const squatter = (await jsonRequest(app, "POST", "/nests", { name: nestId }, writer.apiKey)).data.nest.id;
    await jsonRequest(app, "POST", `/nests/${squatter}/nodes`, { title: "Home", content: "# Home\n\nsquatter site" }, writer.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${squatter}/visibility`, { visibility: "public", acknowledge_public: true }, writer.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${squatter}/reader-mode`, { enabled: true }, writer.apiKey);
    const url = (await jsonRequest(app, "GET", `/nests/${squatter}/site`, undefined, writer.apiKey)).data.url;
    expect(url).not.toContain(`/d/${nestId}/`);
    const page = await get(`/d/${nestId}/`);
    expect(page.status).toBe(301);
    expect(page.headers.get("location")).toBe("https://docs.acme.dev/");
  });

  it("renders the page list once per page, so page size grows linearly", async () => {
    const res = await app.request("https://docs.acme.dev/reference/cli", { headers: { ...HTML, Host: "docs.acme.dev" } });
    expect(res.status).toBe(200);
    expect((await res.text()).match(/<nav class="side"/g)).toHaveLength(1);
  });

  it("evicts the least recently used site once the cache is over its size cap", async () => {
    const { buildCount, setCacheBytesForTests } = await import("../src/site/build.js");
    const acme = () => app.request("https://docs.acme.dev/", { headers: { ...HTML, Host: "docs.acme.dev" } });
    const other = () => get(`/d/${otherId}/`);
    expect((await acme()).status).toBe(200);
    expect((await other()).status).toBe(200);
    setCacheBytesForTests(1);
    try {
      // A rebuild over the cap keeps only the site just built.
      const { getDb } = await import("../src/db/client.js");
      const row = (await getDb().get("SELECT settings FROM nest_sites WHERE nest_id = ?", [nestId])) as { settings: string };
      await getDb().run("UPDATE nest_sites SET settings = ? WHERE nest_id = ?", [JSON.stringify({ ...JSON.parse(row.settings), title: "Evict" }), nestId]);
      const before = buildCount();
      await acme();
      expect(buildCount()).toBe(before + 1);
      await acme();
      expect(buildCount()).toBe(before + 1);
      await other();
      expect(buildCount()).toBe(before + 2);
      await acme();
      expect(buildCount()).toBe(before + 3);
    } finally {
      setCacheBytesForTests(null);
    }
  });

  it("keeps noindex and the AI-training opt-out when stored settings can't be read", async () => {
    const { getDb } = await import("../src/db/client.js");
    const host = { ...HTML, Host: "docs.acme.dev" };
    // A setting a later version retired fails the strict schema.
    const store = (v: object) => getDb().run("UPDATE nest_sites SET settings = ? WHERE nest_id = ?", [JSON.stringify(v), nestId]);
    try {
      await store({ noindex: true, retired_setting: 1 });
      const page = await app.request("https://docs.acme.dev/getting-started", { headers: host });
      expect(page.status).toBe(200);
      expect(page.headers.get("x-robots-tag")).toBe("noindex");
      await store({ ai_training: false, retired_setting: 1 });
      expect(await (await app.request("https://docs.acme.dev/robots.txt", { headers: host })).text()).toContain("ai-train=no");
    } finally {
      await store({});
    }
  });

  it("301s a crawler on an old app URL even with Accept: */* or no Accept", async () => {
    // This nest's site now lives on its verified domain; any live site will do.
    const live = `/nest/${otherId}`;
    for (const headers of [
      { "User-Agent": "Mozilla/5.0; compatible; GPTBot/1.2", Accept: "*/*" },
      { "User-Agent": "ClaudeBot/1.0" },
      { "User-Agent": "Mozilla/5.0 (compatible; bingbot/2.0)", Accept: "*/*" },
      { "User-Agent": "PerplexityBot/1.0", Accept: "application/json" },
    ]) {
      const res = await get(live, headers);
      expect(res.status, headers["User-Agent"]).toBe(301);
      expect(res.headers.get("location")).toMatch(new RegExp(`/d/${otherId}/$|/d/acme-docs/$`));
    }
    // A non-crawler client without a page Accept keeps the JSON 404.
    const api = await get(live, { "User-Agent": "curl/8.0", Accept: "*/*" });
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "Not found" });
    // A crawler on an unrelated unknown path still gets JSON 404, not the shell.
    expect((await get("/no-such-path", { "User-Agent": "GPTBot/1.2" })).status).toBe(404);
  });

  it("gives only a valid session the app instead of the page", async () => {
    const { createSession } = await import("../src/auth/sessions.js");
    const { getDb } = await import("../src/db/client.js");
    const userId = ((await getDb().get("SELECT id FROM users WHERE email = ?", ["owner@test.com"])) as { id: string }).id;
    const valid = await createSession(userId);
    const stale = "0".repeat(64);
    expect((await get(`/nest/${nestId}`, { ...HTML, Cookie: `cnst_session=${valid}` })).status).not.toBe(301);
    // A cookie for a session that no longer exists is an anonymous visitor.
    expect((await get(`/nest/${nestId}`, { ...HTML, Cookie: `cnst_session=${stale}` })).status).toBe(301);
  });

  it("leaves app URLs that merely start with /d to the app", async () => {
    for (const p of ["/dashboard", "/docs", "/definitions", "/d", "/d/"]) {
      const res = await get(p);
      // Never the docs site's own (noindex) 404 page.
      expect(res.headers.get("x-robots-tag"), p).toBeNull();
    }
  });

  it("serves any number of Host headers from one build", async () => {
    const { buildCount } = await import("../src/site/build.js");
    await get("/d/acme-docs/getting-started").catch(() => {});
    const before = buildCount();
    for (let i = 0; i < 5; i++) {
      const res = await app.request(`http://attacker-${i}.example/d/acme-docs/`, { headers: HTML });
      expect([200, 301]).toContain(res.status);
    }
    expect(buildCount()).toBe(before);
  });

  it("lets only one of two nests verify the same domain, even at once", async () => {
    const a = (await jsonRequest(app, "POST", "/nests", { name: "Race A" }, owner.apiKey)).data.nest.id;
    const b = (await jsonRequest(app, "POST", "/nests", { name: "Race B" }, owner.apiKey)).data.nest.id;
    const ca = await jsonRequest(app, "PATCH", `/nests/${a}/site`, { domain: "race.acme.dev" }, owner.apiKey);
    const cb = await jsonRequest(app, "PATCH", `/nests/${b}/site`, { domain: "race.acme.dev" }, owner.apiKey);
    txt[ca.data.dns.txt.name] = [[ca.data.dns.txt.value], [cb.data.dns.txt.value]];
    const results = await Promise.all([
      jsonRequest(app, "POST", `/nests/${a}/site/verify-domain`, {}, owner.apiKey),
      jsonRequest(app, "POST", `/nests/${b}/site/verify-domain`, {}, owner.apiKey),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it("stops serving a verified domain once its TXT record is gone", async () => {
    const settings = await import("../src/site/settings.js");
    const { getDb } = await import("../src/db/client.js");
    const record = (await site("GET", "", undefined)).data.dns.txt;
    expect((await site("GET", "", undefined)).data.domain_verified).toBe(true);
    delete txt[record.name];
    await getDb().run("UPDATE nest_sites SET domain_verified_at = ? WHERE nest_id = ?", ["2020-01-01T00:00:00.000Z", nestId]);
    await settings.recheckDomain(nestId);
    expect((await site("GET", "", undefined)).data.domain_verified).toBe(false);
    expect((await app.request("http://localhost/site-domain-check?domain=docs.acme.dev")).status).toBe(404);
    // Put it back for the tests that follow.
    txt[record.name] = [[record.value]];
    expect((await site("POST", "/verify-domain", {})).status).toBe(200);
  });

  it("stops serving on the domain at once when Reader Mode goes off, with the domain cache warm", async () => {
    const onDomain = () => app.request("https://docs.acme.dev/", { headers: { ...HTML, Host: "docs.acme.dev" } });
    expect((await onDomain()).status).toBe(200); // host → nest is now cached for 30s
    await jsonRequest(app, "PATCH", `/nests/${nestId}/reader-mode`, { enabled: false }, owner.apiKey);
    expect((await onDomain()).status).toBe(404);
    expect((await app.request("http://localhost/site-domain-check?domain=docs.acme.dev")).status).toBe(404);
    await jsonRequest(app, "PATCH", `/nests/${nestId}/reader-mode`, { enabled: true }, owner.apiKey);
    expect((await onDomain()).status).toBe(200);
  });

  it("answers /site-domain-check only with the token when one is set", async () => {
    const check = (q: string) => app.request(`http://localhost/site-domain-check?domain=docs.acme.dev${q}`);
    process.env.SITE_DOMAIN_CHECK_TOKEN = "edge-secret-1";
    try {
      expect((await check("")).status).toBe(403);
      expect((await check("&token=wrong")).status).toBe(403);
      expect((await check("&token=edge-secret-1")).status).toBe(200);
    } finally {
      delete process.env.SITE_DOMAIN_CHECK_TOKEN;
    }
    expect((await check("")).status).toBe(200);
  });

  it("stops serving when the nest goes private, without stale redirects", async () => {
    const warm = await app.request("https://docs.acme.dev/", { headers: { ...HTML, Host: "docs.acme.dev" } });
    expect(warm.status).toBe(200);
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
  let owner: { apiKey: string };
  const txt: Record<string, string[][]> = {};

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@test.com", "Owner");
    const settings = await import("../src/site/settings.js");
    settings.setTxtResolverForTests(async (name: string) => {
      if (!txt[name]) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
      return txt[name];
    });
    nestId = (await jsonRequest(app, "POST", "/nests", { name: "Proxied" }, owner.apiKey)).data.nest.id;
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Setup", content: "# Setup\n\nsteps", folder: "guides" }, owner.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${nestId}/reader-mode`, { enabled: true }, owner.apiKey);
    const r = await jsonRequest(app, "PATCH", `/nests/${nestId}/site`, { settings: { public_url: "https://example.com/docs" } }, owner.apiKey);
    expect(r.status, JSON.stringify(r.data)).toBe(200);
  }, 90000);

  afterAll(() => env.cleanup());

  it("stays at /d/<key> until the public URL's host is verified", async () => {
    // Unproven, the public URL would make this server an open redirect.
    const early = await app.request("http://localhost/d/proxied/setup", { headers: HTML });
    expect(early.status).toBe(200);
    expect(await early.text()).toContain('<link rel="canonical" href="http://localhost/d/proxied/setup">');
    expect((await app.request(`http://localhost/nest/${nestId}`, { headers: HTML })).headers.get("location")).toBe("http://localhost/d/proxied/");

    const info = await jsonRequest(app, "GET", `/nests/${nestId}/site`, undefined, owner.apiKey);
    expect(info.data.public_url_verified).toBe(false);
    expect((await jsonRequest(app, "POST", `/nests/${nestId}/site/verify-public-url`, {}, owner.apiKey)).status).toBe(400);
    txt[info.data.public_url_dns.name] = [[info.data.public_url_dns.value]];
    expect(info.data.public_url_dns.name).toBe("_contextnest.example.com");
    const ok = await jsonRequest(app, "POST", `/nests/${nestId}/site/verify-public-url`, {}, owner.apiKey);
    expect(ok.status, JSON.stringify(ok.data)).toBe(200);
    expect(ok.data.public_url_verified).toBe(true);
    expect(ok.data.url).toBe("https://example.com/docs/");
    const { placementFor, siteNests } = await import("../src/site/build.js");
    const { getSiteRow } = await import("../src/site/settings.js");
    const nest = (await siteNests()).find((n) => n.id === nestId)!;
    expect((await placementFor(nest, await getSiteRow(nestId), "http://localhost")).verified).toBe(true);
  });

  it("serves proxied requests with the public URL's paths and canonicals", async () => {
    // Every page sits under one top folder ("guides/"), so URLs start inside it.
    const res = await app.request("http://localhost/d/proxied/setup", { headers: { ...HTML, "X-Forwarded-Host": "example.com" } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<link rel="canonical" href="https://example.com/docs/setup">');
    expect(html).toContain('href="/docs/"');
  });

  it("varies on X-Forwarded-Host where it picks the response, so a shared cache can't mix them", async () => {
    const via = await app.request("http://localhost/d/proxied/setup", { headers: { ...HTML, "X-Forwarded-Host": "example.com" } });
    const direct = await app.request("http://localhost/d/proxied/setup", { headers: HTML });
    expect([via.status, direct.status]).toEqual([200, 301]);
    for (const res of [via, direct]) expect(res.headers.get("vary")).toMatch(/X-Forwarded-Host/i);
    expect(via.headers.get("vary")).toMatch(/Accept/);
    // The header never changes the body's URLs: they name the public URL either way.
    const spoofed = await app.request("http://localhost/d/proxied/setup", { headers: { ...HTML, "X-Forwarded-Host": "example.com", Host: "attacker.example" } });
    expect(await spoofed.text()).toContain('<link rel="canonical" href="https://example.com/docs/setup">');
  });

  it("points a spoofed X-Forwarded-Host copy back at the public URL", async () => {
    // Anyone can send the header and get the page on this origin. The page is
    // public anyway, and its canonical names the public URL, so search
    // engines index that one, not this copy.
    const res = await app.request("http://localhost/d/proxied/setup", { headers: { ...HTML, "X-Forwarded-Host": "example.com" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<link rel="canonical" href="https://example.com/docs/setup">');
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });

  it("exports static files with the public URL even before it is verified", async () => {
    const { getDb } = await import("../src/db/client.js");
    const { buildSiteFiles } = await import("../src/site/build.js");
    await getDb().run("UPDATE nest_sites SET public_url_host = NULL WHERE nest_id = ?", [nestId]);
    try {
      const files = await buildSiteFiles(nestId, "http://localhost/");
      expect(Object.keys(files)).toEqual(
        expect.arrayContaining(["setup.html", "setup.md", "sitemap.xml", "robots.txt", "llms.txt", "404.html", "_redirects"]),
      );
      expect(files["setup.html"]).toContain('<link rel="canonical" href="https://example.com/docs/setup">');
      expect(files["sitemap.xml"]).toContain("<loc>https://example.com/docs/setup</loc>");
      // The server itself still keeps the unverified site at /d/<key>.
      const live = await app.request("http://localhost/d/proxied/setup", { headers: HTML });
      expect(live.status).toBe(200);
      // Only a placement the server can vouch for pings IndexNow.
      const { placementFor, siteNests } = await import("../src/site/build.js");
      const { getSiteRow } = await import("../src/site/settings.js");
      const nest = (await siteNests()).find((n) => n.id === nestId)!;
      const row = await getSiteRow(nestId);
      expect((await placementFor(nest, row, "http://localhost", { unverifiedPublicUrl: true })).verified).toBe(false);
      // No PUBLIC_BASE_URL in tests: /d/<key> on a Host-derived origin is not vouched for either.
      expect((await placementFor(nest, row, "http://localhost")).verified).toBe(false);
    } finally {
      await getDb().run("UPDATE nest_sites SET public_url_host = ? WHERE nest_id = ?", ["example.com", nestId]);
    }
  });

  it("301s direct hits to the public URL", async () => {
    const res = await app.request("http://localhost/d/proxied/setup", { headers: HTML });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://example.com/docs/setup");
  });
});
