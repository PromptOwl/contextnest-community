/**
 * CU-wdqcq05jhm — public docs site. A nest that is PUBLIC with Reader Mode on
 * is also served as a static, crawlable docs site: complete HTML per page at a
 * clean path URL, a real sitemap/robots/llms.txt, Markdown twins, and a 301
 * from the SPA URLs for anonymous visitors. Before this, every one of those
 * URLs returned the same 606-byte SPA shell, which is why the docs vanished
 * from search.
 *
 * Only APPROVED snapshots are ever rendered — the same rule as the public
 * reader — so a draft or an unapproved edit never reaches the open web.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
} from "./helpers.js";

const HTML = { Accept: "text/html" };

describe("public docs site", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let nestId: string;
  let privateId: string;
  let noReaderId: string;
  /** CU-wdqcq05ran: one nest per home_node form, each with a root convention page. */
  const homeNests: Record<string, string> = {};

  const get = (path: string, headers: Record<string, string> = HTML) =>
    app.request(`http://localhost${path}`, { headers });

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@test.com", "Owner");

    const created = await jsonRequest(app, "POST", "/nests", { name: "Acme Docs", description: "Everything about Acme." }, owner.apiKey);
    nestId = created.data.nest.id;
    const add = (title: string, content: string, folder: string) =>
      jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title, content, folder }, owner.apiKey);

    // Ungoverned while seeding: every write auto-publishes (approved).
    await add("Welcome", "# Welcome\n\nAcme helps you ship. Start with [[docs/guides/setup]].", "docs");
    await add(
      "Setup",
      "# Setup\n\nInstall the CLI, then read [[docs/guides/advanced|the advanced guide]].\n\n## Configure\n\nSet `ACME_KEY`. See also [[docs/guides/secret-plans]] and [[No Such Page]].\n\n<script>alert(1)</script>\n\n`[[docs/guides/advanced]]` stays code.",
      "docs/guides",
    );
    await add("Advanced", "# Advanced\n\nApproved advanced text.", "docs/guides");

    // Governed from here on: new docs and edits wait for review.
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true }, owner.apiKey);
    await add("Secret Plans", "# Secret Plans\n\nunreleased roadmap", "docs/guides");
    await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/docs/guides/advanced`, { content: "# Advanced\n\nUNAPPROVED EDIT" }, owner.apiKey);

    const vis = await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey);
    expect(vis.status, JSON.stringify(vis.data)).toBe(200);
    const rm = await jsonRequest(app, "PATCH", `/nests/${nestId}/reader-mode`, { enabled: true, home_node: "nodes/docs/welcome" }, owner.apiKey);
    expect(rm.status, JSON.stringify(rm.data)).toBe(200);

    // CU-wdqcq05ran: each nest has a root `overview` (what the naming convention
    // picks) and a `welcome` one folder down (what home_node designates).
    for (const [name, home] of [
      ["Home Slug", "welcome"],
      ["Home Mixed Case", "Nodes/Docs/Guides/WELCOME"],
      ["Home Missing", "no-such-page"],
    ] as const) {
      const n = await jsonRequest(app, "POST", "/nests", { name }, owner.apiKey);
      const id = n.data.nest.id;
      homeNests[name] = id;
      // Both under "docs", so the site strips it and overview sits at the root.
      await jsonRequest(app, "POST", `/nests/${id}/nodes`, { title: "Overview", content: "# Overview\n\nconvention page", folder: "docs" }, owner.apiKey);
      await jsonRequest(app, "POST", `/nests/${id}/nodes`, { title: "Welcome", content: "# Welcome\n\ndesignated home", folder: "docs/guides" }, owner.apiKey);
      await jsonRequest(app, "PATCH", `/nests/${id}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey);
      const hrm = await jsonRequest(app, "PATCH", `/nests/${id}/reader-mode`, { enabled: true, home_node: home }, owner.apiKey);
      expect(hrm.status, JSON.stringify(hrm.data)).toBe(200);
    }

    const priv = await jsonRequest(app, "POST", "/nests", { name: "Private Docs" }, owner.apiKey);
    privateId = priv.data.nest.id;
    await jsonRequest(app, "POST", `/nests/${privateId}/nodes`, { title: "Hidden", content: "# Hidden\n\nnope" }, owner.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${privateId}/reader-mode`, { enabled: true }, owner.apiKey);

    const plain = await jsonRequest(app, "POST", "/nests", { name: "Plain Public" }, owner.apiKey);
    noReaderId = plain.data.nest.id;
    await jsonRequest(app, "POST", `/nests/${noReaderId}/nodes`, { title: "Open", content: "# Open\n\nopen" }, owner.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${noReaderId}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey);
  }, 90000);

  afterAll(() => {
    delete process.env.DOCS_SITES;
    env.cleanup();
  });

  it("serves the home page as complete HTML with the SEO head", async () => {
    const res = await get("/d/acme-docs/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("Acme helps you ship.");
    expect(html).toMatch(/<title>Welcome[^<]*Acme Docs<\/title>/);
    expect(html).toContain('<link rel="canonical" href="http://localhost/d/acme-docs/">');
    expect(html).toMatch(/<meta name="description" content="Acme helps you ship\./);
    expect(html).toContain('property="og:title"');
    expect(html).toContain("application/ld+json");
    expect(html.match(/<h1[\s>]/g)?.length).toBe(1);
    // No app bundle: the content is in the HTML, not behind JavaScript.
    expect(html).not.toContain('id="root"');
  });

  // CU-wdqcq05ran: home_node resolves on the site the way the reader resolves
  // it — full id or bare slug, case-insensitively — not by exact id only.
  const siteHome = async (name: string) => {
    const { buildSiteFiles } = await import("../src/site/build.js");
    const files = await buildSiteFiles(homeNests[name], "https://site.example.com");
    return String(files["index.html"]);
  };

  it("makes a bare-slug home_node the home page, as the reader does", async () => {
    const html = await siteHome("Home Slug");
    expect(html).toMatch(/<title>Welcome[^<]*Home Slug<\/title>/);
    expect(html).toContain("designated home");
    // And through the live /d/<key>/ route, not just the static export.
    const res = await get("/d/home-slug/");
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/<title>Welcome[^<]*Home Slug<\/title>/);
  });

  it("matches a home_node full id case-insensitively", async () => {
    const html = await siteHome("Home Mixed Case");
    expect(html).toMatch(/<title>Welcome[^<]*Home Mixed Case<\/title>/);
  });

  it("falls back to the naming convention when home_node matches no page", async () => {
    const html = await siteHome("Home Missing");
    expect(html).toMatch(/<title>Overview[^<]*Home Missing<\/title>/);
    expect(html).toContain("convention page");
  });

  it("serves a page at its clean path, wikilinks as plain anchors", async () => {
    const res = await get("/d/acme-docs/guides/setup");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Install the CLI");
    expect(html).toContain('href="/d/acme-docs/guides/advanced">the advanced guide</a>');
    expect(html).toContain('id="configure"');
    expect(html).toContain("BreadcrumbList");
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/d/acme-docs/guides/setup.md">');
  });

  it("never renders drafts or unapproved edits", async () => {
    expect((await get("/d/acme-docs/guides/secret-plans")).status).toBe(404);
    const setup = await (await get("/d/acme-docs/guides/setup")).text();
    // The link to the draft renders as text, not as a link to it.
    expect(setup).not.toContain('href="/d/acme-docs/guides/secret-plans"');
    expect(setup).not.toContain("unreleased roadmap");
    const adv = await (await get("/d/acme-docs/guides/advanced")).text();
    expect(adv).toContain("Approved advanced text.");
    expect(adv).not.toContain("UNAPPROVED EDIT");
    const map = await (await get("/d/acme-docs/sitemap.xml")).text();
    expect(map).not.toContain("secret-plans");
  });

  it("keeps draft paths out of the Markdown twins and llms-full.txt, as in the HTML", async () => {
    const twin = await (await get("/d/acme-docs/guides/setup.md", {})).text();
    const full = await (await get("/d/acme-docs/llms-full.txt", {})).text();
    for (const out of [twin, full]) {
      expect(out).not.toContain("docs/guides/secret-plans");
      expect(out).toContain("See also secret-plans and No Such Page.");
      expect(out).toContain("[the advanced guide](http://localhost/d/acme-docs/guides/advanced)");
      // Code stays as written.
      expect(out).toContain("`[[docs/guides/advanced]]` stays code.");
    }
  });

  it("escapes raw HTML and leaves code alone", async () => {
    const html = await (await get("/d/acme-docs/guides/setup")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("<code>[[docs/guides/advanced]]</code>");
  });

  it("404s nests that are private or not in reader mode, without leaking which", async () => {
    const priv = await get(`/d/${privateId}/`);
    const plain = await get(`/d/${noReaderId}/`);
    const none = await get("/d/no-such-nest/");
    expect(priv.status).toBe(404);
    expect(plain.status).toBe(404);
    expect(none.status).toBe(404);
    expect(await priv.text()).toBe(await none.text());
  });

  it("answers unknown pages with a real 404 marked noindex", async () => {
    const res = await get("/d/acme-docs/guides/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('<meta name="robots" content="noindex">');
  });

  it("serves a sitemap, robots.txt and llms.txt that are not the SPA shell", async () => {
    const map = await get("/d/acme-docs/sitemap.xml", {});
    expect(map.status).toBe(200);
    expect(map.headers.get("content-type")).toMatch(/xml/);
    const xml = await map.text();
    expect(xml).toContain("<loc>http://localhost/d/acme-docs/guides/setup</loc>");
    expect(xml).toContain("<lastmod>");

    const robots = await get("/robots.txt", {});
    expect(robots.status).toBe(200);
    expect(robots.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await robots.text()).toContain("Sitemap: http://localhost/sitemap.xml");

    const index = await (await get("/sitemap.xml", {})).text();
    expect(index).toContain("<sitemapindex");
    expect(index).toContain("http://localhost/d/acme-docs/sitemap.xml");
    expect(index).not.toContain(privateId);

    const llms = await get("/d/acme-docs/llms.txt", {});
    expect(llms.status).toBe(200);
    expect(await llms.text()).toContain("[Setup](http://localhost/d/acme-docs/guides/setup.md)");
  });

  it("serves the Markdown twin by extension and by Accept header", async () => {
    const ext = await get("/d/acme-docs/guides/setup.md", {});
    expect(ext.status).toBe(200);
    expect(ext.headers.get("content-type")).toMatch(/text\/markdown/);
    expect(await ext.text()).toContain("Install the CLI");
    const neg = await get("/d/acme-docs/guides/setup", { Accept: "text/markdown" });
    expect(neg.headers.get("content-type")).toMatch(/text\/markdown/);
  });

  it("supports conditional requests", async () => {
    const first = await get("/d/acme-docs/guides/setup");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(first.headers.get("cache-control")).toMatch(/public/);
    const again = await get("/d/acme-docs/guides/setup", { ...HTML, "If-None-Match": etag! });
    expect(again.status).toBe(304);
  });

  it("301s anonymous visitors from the SPA URLs to the clean URL", async () => {
    const a = await get(`/nest/${nestId}`);
    expect(a.status).toBe(301);
    expect(a.headers.get("location")).toBe("http://localhost/d/acme-docs/");
    const b = await get(`/?nest=${nestId}&doc=nodes/docs/guides/setup`);
    expect(b.status).toBe(301);
    expect(b.headers.get("location")).toBe("http://localhost/d/acme-docs/guides/setup");
  });

  it("picks up a newly approved version without a restart", async () => {
    const before = await get("/d/acme-docs/guides/advanced");
    const etag = before.headers.get("etag")!;
    const id = "nodes/docs/guides/advanced";
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { allow_self_approve: true }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${id}/submit-review`, { note: "ready" }, owner.apiKey);
    const ok = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${id}/approve`, { note: "ok" }, owner.apiKey);
    expect(ok.status, JSON.stringify(ok.data)).toBeLessThan(300);
    const after = await get("/d/acme-docs/guides/advanced", { ...HTML, "If-None-Match": etag });
    expect(after.status).toBe(200);
    expect(await after.text()).toContain("UNAPPROVED EDIT");
  });

  it("regression: signed-in users and other nests still get the app", async () => {
    const signedIn = await get(`/nest/${nestId}`, { ...HTML, ...authed(owner.apiKey) });
    expect(signedIn.status).not.toBe(301);
    const optOut = await get(`/nest/${nestId}?app=1`);
    expect(optOut.status).not.toBe(301);
    const other = await get(`/nest/${noReaderId}`);
    expect(other.status).not.toBe(301);
    // Non-navigation misses keep their JSON 404, and /llms.txt is untouched.
    const miss = await get("/definitely-not-a-route", {});
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ error: "Not found" });
    expect((await get("/llms.txt", {})).status).toBe(200);
  });
});

describe("public docs site on its own domain", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    const owner = await registerUser(app, "owner@test.com", "Owner");
    const created = await jsonRequest(app, "POST", "/nests", { name: "Acme Docs" }, owner.apiKey);
    nestId = created.data.nest.id;
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Welcome", content: "# Welcome\n\nhello", folder: "docs" }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Setup", content: "# Setup\n\nsteps", folder: "docs/guides" }, owner.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${nestId}/visibility`, { visibility: "public", acknowledge_public: true }, owner.apiKey);
    await jsonRequest(app, "PATCH", `/nests/${nestId}/reader-mode`, { enabled: true }, owner.apiKey);
    process.env.DOCS_SITES = `docs.example.com=${nestId}`;
  }, 90000);

  afterAll(() => {
    delete process.env.DOCS_SITES;
    env.cleanup();
  });

  it("serves the site at the domain root with domain canonicals", async () => {
    const res = await app.request("https://docs.example.com/guides/setup", { headers: HTML });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("steps");
    expect(html).toContain('<link rel="canonical" href="https://docs.example.com/guides/setup">');
    const home = await app.request("https://docs.example.com/", { headers: HTML });
    expect(await home.text()).toContain("hello");
    const robots = await (await app.request("https://docs.example.com/robots.txt")).text();
    expect(robots).toContain("Sitemap: https://docs.example.com/sitemap.xml");
    const map = await (await app.request("https://docs.example.com/sitemap.xml")).text();
    expect(map).toContain("<loc>https://docs.example.com/guides/setup</loc>");
  });

  it("301s the /d/ URL on the main host to the domain", async () => {
    const res = await app.request("http://localhost/d/acme-docs/guides/setup", { headers: HTML });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://docs.example.com/guides/setup");
  });

  it("builds the whole site as static files for any static host", async () => {
    const { buildSiteFiles } = await import("../src/site/build.js");
    const files = await buildSiteFiles(nestId, "https://docs.example.com");
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(["index.html", "guides/setup.html", "guides/setup.md", "sitemap.xml", "robots.txt", "llms.txt", "404.html", "_redirects"]),
    );
    // <path>.html serves the slashless canonical URL on Pages/Netlify/Vercel/GitHub Pages.
    expect(String(files["guides/setup.html"])).toContain("steps");
  });
});
