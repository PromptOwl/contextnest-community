/**
 * The share slice on the public /p surface (PO-1365):
 *
 *   - link previews: Open Graph + Twitter card tags on /p/:slug, escaped, with
 *     an excerpt taken from the APPROVED version only, and nothing about the
 *     document on a gated link;
 *   - the "Make your own nest" strip: on our own page chrome, pointing at this
 *     deployment's sign-up, hidden on a white-label nest, and never part of
 *     /p/:slug/view (the sandboxed document);
 *   - /p/:slug/og-image: the nest's logo, or the default card.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import { ARTIFACT_SANDBOX_CSP } from "../src/shared/artifact-sandbox.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Uint8Array.from(atob(PNG_B64), (ch) => ch.charCodeAt(0));

const ART_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Deck</title></head>' +
  "<body><h1>Quarterly deck</h1><p>Slide one says hello.</p>" +
  "<script>window.x = 1;</script></body></html>";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let admin: { apiKey: string; userId: string; email: string };
let reviewer: { apiKey: string; userId: string; email: string };
let nestId: string;
let whiteNest: string;

async function publish(nest: string, nodeId: string, extra: Record<string, unknown> = {}) {
  const created = await jsonRequest(
    app,
    "POST",
    `/nests/${nest}/publications`,
    { node_id: nodeId, access_mode: "public", ...extra },
    owner.apiKey,
  );
  expect(created.status).toBe(201);
  return created.data.publish.slug as string;
}

async function page(path: string) {
  const res = await app.request(path);
  return { res, html: await res.text() };
}

/** The `content` of one meta tag, as written (still HTML-escaped). */
function meta(html: string, key: string): string | null {
  const m = html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`));
  return m ? m[1] : null;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["admin@acme.com"] });
  admin = await registerUser(app, "admin@acme.com", "Admin");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  reviewer = await registerUser(app, "reviewer@acme.com", "Reviewer");

  const nest = await jsonRequest(app, "POST", "/nests", { name: "Showcase" }, owner.apiKey);
  nestId = nest.data.nest.id;
  const docs: Array<Record<string, unknown>> = [
    {
      title: "Handbook",
      content:
        "# Handbook\n\nHow we work: write it down, get it **approved**, then share it.\n\n- one\n- two",
    },
    {
      title: `Q3 "Plan" <b>&</b> more`,
      content: `Intro with "quotes", an <img src=x onerror=alert(1)> tag & an ampersand.`,
    },
    { title: "Deck", content: ART_HTML, type: "artifact" },
    { title: "Secret Roadmap", content: "# Secret Roadmap\n\nThe launch is on the ninth." },
  ];
  for (const d of docs) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, d, owner.apiKey);
    expect(r.status).toBe(201);
  }

  const white = await jsonRequest(app, "POST", "/nests", { name: "White Label" }, owner.apiKey);
  whiteNest = white.data.nest.id;
  for (const d of [
    { title: "Handbook", content: "# Handbook\n\nWhite label body." },
    { title: "Deck", content: ART_HTML, type: "artifact" },
  ]) {
    await jsonRequest(app, "POST", `/nests/${whiteNest}/nodes`, d, owner.apiKey);
  }
  const saved = await jsonRequest(
    app,
    "PATCH",
    `/nests/${whiteNest}/branding`,
    { site_title: "Acme Docs", hide_powered_by: true },
    admin.apiKey,
  );
  expect(saved.status).toBe(200);
});

afterAll(() => env.cleanup());

describe("link previews on an open link", () => {
  it("carries Open Graph and Twitter card tags with an excerpt", async () => {
    const slug = await publish(nestId, "nodes/handbook");
    const { res, html } = await page(`/p/${slug}`);
    expect(res.status).toBe(200);
    expect(meta(html, "og:title")).toBe("Handbook");
    // The excerpt is the body's text: no markdown marks, no repeated title.
    expect(meta(html, "og:description")).toBe(
      "How we work: write it down, get it approved, then share it. one two",
    );
    expect(meta(html, "description")).toBe(meta(html, "og:description"));
    expect(meta(html, "og:url")).toBe(`http://localhost/p/${slug}`);
    expect(meta(html, "og:site_name")).toBe("ContextNest");
    expect(meta(html, "og:type")).toBe("article");
    expect(meta(html, "og:image")).toBe(`http://localhost/p/${slug}/og-image`);
    expect(meta(html, "twitter:card")).toBe("summary_large_image");
    expect(meta(html, "twitter:title")).toBe("Handbook");
  });

  it("asks search engines not to index or follow it, in the page and the header", async () => {
    const slug = await publish(nestId, "nodes/handbook");
    const { res, html } = await page(`/p/${slug}`);
    expect(meta(html, "robots")).toBe("noindex, nofollow");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    // Every response under /p says the same: the sandboxed view, the preview
    // image (unfurlers still fetch it; X-Robots-Tag only stops indexing), and
    // a dead link.
    for (const path of [`/p/${slug}/view`, `/p/${slug}/og-image`, "/p/no-such-link"]) {
      expect((await app.request(path)).headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
    }
  });

  it("escapes the title and the excerpt", async () => {
    const slug = await publish(nestId, "nodes/q3-plan-b-b-more");
    const { html } = await page(`/p/${slug}`);
    const head = html.slice(0, html.indexOf("</head>"));
    expect(head).not.toContain("<b>");
    expect(head).not.toContain("<img");
    expect(meta(html, "og:title")).toBe("Q3 &quot;Plan&quot; &lt;b&gt;&amp;&lt;/b&gt; more");
    const desc = meta(html, "og:description")!;
    expect(desc).toContain("&quot;quotes&quot;");
    expect(desc).toContain("&amp; an ampersand");
    expect(desc).not.toContain("onerror=alert(1)>");
  });

  it("caps a long excerpt on a word boundary", async () => {
    const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Long", content: long }, owner.apiKey);
    const slug = await publish(nestId, "nodes/long");
    const desc = meta((await page(`/p/${slug}`)).html, "og:description")!;
    expect(desc.length).toBeLessThanOrEqual(201);
    expect(desc.endsWith("…")).toBe(true);
    expect(desc).toMatch(/word\d+…$/);
  });

  it("reads only the opening of a very large document", async () => {
    const big = `Opening line. ${"<script>".repeat(4000)} ${"filler ".repeat(20000)}`;
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Big", content: `<!doctype html><html><head></head><body>${big}</body></html>`, type: "artifact" }, owner.apiKey);
    const slug = await publish(nestId, "nodes/big");
    const started = Date.now();
    const { res, html } = await page(`/p/${slug}`);
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(meta(html, "og:description")).toBe("Opening line.");
  });

  it("leaves the excerpt out when the link discourages copying", async () => {
    const slug = await publish(nestId, "nodes/handbook", { no_download: true });
    const { html } = await page(`/p/${slug}`);
    expect(meta(html, "og:title")).toBe("Handbook");
    expect(meta(html, "og:description")).toBeNull();
  });

  it("uses PUBLIC_BASE_URL for the links when the admin set one", async () => {
    process.env.PUBLIC_BASE_URL = "https://nest.acme.example/";
    try {
      const slug = await publish(nestId, "nodes/handbook");
      const { html } = await page(`/p/${slug}`);
      expect(meta(html, "og:url")).toBe(`https://nest.acme.example/p/${slug}`);
      expect(html).toContain(`href="https://nest.acme.example/?ref=share"`);
      expect(html).not.toContain("nest.promptowl.ai");
    } finally {
      delete process.env.PUBLIC_BASE_URL;
    }
  });
});

describe("the excerpt comes from the approved version", () => {
  it("never shows a draft edit", async () => {
    const gv = await jsonRequest(app, "POST", "/nests", { name: "Governed" }, owner.apiKey);
    const g = gv.data.nest.id;
    const nestPath = join(env.dataDir, "nests", g);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `version: 1\nnest:\n  - email: reviewer@acme.com, role: reviewer, can_approve: true\n`,
    );
    await jsonRequest(app, "POST", `/nests/${g}/collaborators`, { email: "reviewer@acme.com", permission: "write" }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${g}/stewards/sync`, {}, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${g}/nodes`, { title: "Policy", content: "The approved policy text." }, owner.apiKey);
    await jsonRequest(app, "POST", `/nests/${g}/nodes/nodes/policy/submit-review`, { note: "r" }, owner.apiKey);
    const ok = await jsonRequest(app, "POST", `/nests/${g}/nodes/nodes/policy/approve`, { note: "ok" }, reviewer.apiKey);
    expect(ok.status).toBe(200);
    const slug = await publish(g, "nodes/policy");
    const edit = await jsonRequest(
      app,
      "PATCH",
      `/nests/${g}/nodes/nodes/policy`,
      { content: "UNAPPROVED draft secret." },
      owner.apiKey,
    );
    expect(edit.status).toBe(200);
    const { html } = await page(`/p/${slug}`);
    expect(meta(html, "og:description")).toBe("The approved policy text.");
    expect(html).not.toContain("UNAPPROVED");
  });
});

describe("a gated link reveals nothing about the document", () => {
  it("gives the gate's own title, no excerpt, and no document text", async () => {
    const slug = await publish(nestId, "nodes/secret-roadmap", { access_mode: "code", code: "swordfish" });
    const { res, html } = await page(`/p/${slug}`);
    expect(res.status).toBe(200);
    expect(meta(html, "og:title")).toBe("Protected document");
    expect(meta(html, "og:description")).toBeNull();
    expect(meta(html, "description")).toBeNull();
    expect(meta(html, "og:url")).toBe(`http://localhost/p/${slug}`);
    expect(meta(html, "og:image")).toBe(`http://localhost/p/${slug}/og-image`);
    // A gate page is not indexed either, like every /p page.
    expect(meta(html, "robots")).toBe("noindex, nofollow");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(html).not.toContain("Secret Roadmap");
    expect(html).not.toContain("ninth");
  });

  it("shows the strip on the gate without leaking the document", async () => {
    const slug = await publish(nestId, "nodes/secret-roadmap", { access_mode: "code", code: "swordfish" });
    const { html } = await page(`/p/${slug}`);
    expect(html).toContain(`href="http://localhost/?ref=share"`);
    expect(html).toContain("Make your own nest");
    expect(html).not.toContain("Secret Roadmap");
  });

  it("keeps the preview closed on a wrong code", async () => {
    const slug = await publish(nestId, "nodes/secret-roadmap", { access_mode: "code", code: "swordfish" });
    const res = await app.request(`/p/${slug}/gate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "code=nope",
    });
    const html = await res.text();
    expect(res.status).toBe(401);
    expect(meta(html, "og:description")).toBeNull();
    expect(html).not.toContain("Secret Roadmap");
  });
});

describe("the Make your own nest strip", () => {
  it("is on a markdown page, pointing at this deployment's sign-up", async () => {
    const slug = await publish(nestId, "nodes/handbook");
    const { res, html } = await page(`/p/${slug}`);
    expect(html).toContain("data-cn-cta");
    expect(html).toContain(`href="http://localhost/?ref=share"`);
    expect(html).toContain("Make your own nest");
    // The page itself is unchanged in kind: the document, under the sandbox.
    expect((res.headers.get("content-security-policy") ?? "").startsWith(ARTIFACT_SANDBOX_CSP)).toBe(true);
    expect(html).toContain("How we work");
  });

  it("is never part of the sandboxed document view", async () => {
    for (const node of ["nodes/handbook", "nodes/deck"]) {
      const slug = await publish(nestId, node);
      const { res, html } = await page(`/p/${slug}/view`);
      expect(res.status).toBe(200);
      expect(html).not.toContain("data-cn-cta");
      expect(html).not.toContain("ref=share");
      expect(html).not.toContain("og:title");
    }
  });

  it("frames an author's HTML page instead of editing it", async () => {
    const slug = await publish(nestId, "nodes/deck");
    const { res, html } = await page(`/p/${slug}`);
    expect(res.status).toBe(200);
    // Our shell: not sandboxed itself, frames the sandboxed document.
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-src 'self'");
    expect(html).toContain(`<iframe id="cn-frame" src="/p/${slug}/view"`);
    expect(html).toContain("data-cn-cta");
    expect(html).toContain(`href="http://localhost/?ref=share"`);
    expect(meta(html, "og:title")).toBe("Deck");
    expect(meta(html, "og:description")).toBe("Quarterly deck Slide one says hello.");
    // No comment controls: this link did not turn comments on.
    expect(html).not.toContain("Leave a comment");
    // The document itself is served exactly as the author wrote it.
    const view = await page(`/p/${slug}/view`);
    expect(view.html.trim()).toBe(ART_HTML);
    expect((view.res.headers.get("content-security-policy") ?? "").startsWith(ARTIFACT_SANDBOX_CSP)).toBe(true);
  });

  it("logs one view for a framed page, not two", async () => {
    const slug = await publish(nestId, "nodes/deck");
    await page(`/p/${slug}`);
    await page(`/p/${slug}/view`);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/publications`, undefined, owner.apiKey);
    const id = list.data.publishes.find((p: any) => p.slug === slug).id;
    const views = await jsonRequest(app, "GET", `/nests/${nestId}/publications/${id}/views`, undefined, owner.apiKey);
    expect(views.data.count).toBe(1);
  });

  it("sits beside the comment controls when comments are on", async () => {
    const slug = await publish(nestId, "nodes/handbook", { comments_enabled: true });
    const { html } = await page(`/p/${slug}`);
    expect(html).toContain("Leave a comment");
    expect(html).toContain("data-cn-cta");
    expect(meta(html, "og:title")).toBe("Handbook");
  });
});

describe("a white-label nest shows no strip", () => {
  it("on a markdown page", async () => {
    const slug = await publish(whiteNest, "nodes/handbook");
    const { html } = await page(`/p/${slug}`);
    expect(html).not.toContain("data-cn-cta");
    expect(html).not.toContain("ref=share");
    expect(html).not.toContain("Make your own nest");
    // Previews still work, under the nest's own name.
    expect(meta(html, "og:title")).toBe("Handbook");
    expect(meta(html, "og:site_name")).toBe("Acme Docs");
  });

  it("on an author's HTML page, which is served directly as before", async () => {
    const slug = await publish(whiteNest, "nodes/deck");
    const { res, html } = await page(`/p/${slug}`);
    expect((res.headers.get("content-security-policy") ?? "").startsWith(ARTIFACT_SANDBOX_CSP)).toBe(true);
    expect(html).not.toContain("data-cn-cta");
    expect(html).not.toContain("cn-frame");
    expect(html).toContain("<h1>Quarterly deck</h1>");
    expect(meta(html, "og:title")).toBe("Deck");
  });

  it("keeps the Open Graph tags an author's HTML page already has", async () => {
    const own =
      '<!doctype html><html><head><meta property="og:title" content="Author title"><title>T</title></head><body><p>Hi</p></body></html>';
    await jsonRequest(app, "POST", `/nests/${whiteNest}/nodes`, { title: "Own Tags", content: own, type: "artifact" }, owner.apiKey);
    const slug = await publish(whiteNest, "nodes/own-tags");
    const { res, html } = await page(`/p/${slug}`);
    expect(html.trim()).toBe(own);
    // We add no tags to it, robots included; the header still says noindex.
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("leaves an HTML page with no <head> exactly as written", async () => {
    const bare = "<html><body><p>No head here</p></body></html>";
    await jsonRequest(app, "POST", `/nests/${whiteNest}/nodes`, { title: "Bare", content: bare, type: "artifact" }, owner.apiKey);
    const slug = await publish(whiteNest, "nodes/bare");
    expect((await page(`/p/${slug}`)).html.trim()).toBe(bare);
  });

  it("on the gate", async () => {
    const slug = await publish(whiteNest, "nodes/handbook", { access_mode: "code", code: "swordfish" });
    const { html } = await page(`/p/${slug}`);
    expect(html).not.toContain("ref=share");
    expect(html).not.toContain("Make your own nest");
    expect(html).not.toContain("Secured by PromptOwl");
  });
});

describe("a link with the invitation switched off (show_invite: false)", () => {
  it("is on by default, and reported on the link", async () => {
    const made = await jsonRequest(app, "POST", `/nests/${nestId}/publications`, { node_id: "nodes/handbook" }, owner.apiKey);
    expect(made.data.publish.show_invite).toBe(true);
    const off = await jsonRequest(app, "POST", `/nests/${nestId}/publications`, { node_id: "nodes/handbook", show_invite: false }, owner.apiKey);
    expect(off.data.publish.show_invite).toBe(false);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/publications`, undefined, owner.apiKey);
    expect(list.data.publishes.find((p: any) => p.id === off.data.publish.id).show_invite).toBe(false);
  });

  it("shows no strip on a markdown page, the gate, or the comment shell", async () => {
    for (const extra of [{}, { access_mode: "code", code: "swordfish" }, { comments_enabled: true }]) {
      const slug = await publish(nestId, "nodes/handbook", { show_invite: false, ...extra });
      const { html } = await page(`/p/${slug}`);
      expect(html, JSON.stringify(extra)).not.toContain("data-cn-cta");
      expect(html).not.toContain("ref=share");
      expect(html).not.toContain("Make your own nest");
    }
  });

  it("serves an author's HTML page directly, not framed", async () => {
    const slug = await publish(nestId, "nodes/deck", { show_invite: false });
    const { res, html } = await page(`/p/${slug}`);
    expect((res.headers.get("content-security-policy") ?? "").startsWith(ARTIFACT_SANDBOX_CSP)).toBe(true);
    expect(html).not.toContain("cn-frame");
    expect(html).not.toContain("data-cn-cta");
    expect(html).toContain("<h1>Quarterly deck</h1>");
    // Same bytes as the document view, apart from the preview tags in <head>.
    const view = (await page(`/p/${slug}/view`)).html;
    expect(html.replace(/<meta (?:property|name)="(?:og:|twitter:|robots|description)[^>]*>/g, "")).toBe(view);
  });

  it("can be switched on and off on a live link, by the people who may publish", async () => {
    const made = await jsonRequest(app, "POST", `/nests/${nestId}/publications`, { node_id: "nodes/deck" }, owner.apiKey);
    const { id, slug } = made.data.publish;
    expect((await page(`/p/${slug}`)).html).toContain("data-cn-cta");

    const off = await jsonRequest(app, "PATCH", `/nests/${nestId}/publications/${id}`, { show_invite: false }, owner.apiKey);
    expect(off.status).toBe(200);
    expect(off.data.publish.show_invite).toBe(false);
    expect(off.data.publish.slug).toBe(slug);
    const now = await page(`/p/${slug}`);
    expect(now.html).not.toContain("data-cn-cta");
    expect(now.html).not.toContain("cn-frame");

    const on = await jsonRequest(app, "PATCH", `/nests/${nestId}/publications/${id}`, { show_invite: true }, owner.apiKey);
    expect(on.data.publish.show_invite).toBe(true);
    expect((await page(`/p/${slug}`)).html).toContain("data-cn-cta");

    const bad = await jsonRequest(app, "PATCH", `/nests/${nestId}/publications/${id}`, { show_invite: "no" }, owner.apiKey);
    expect(bad.status).toBe(400);
    // A JSON body of literal null is a bad request too, not a server error.
    const nul = await app.request(`/nests/${nestId}/publications/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${owner.apiKey}`, "Content-Type": "application/json" },
      body: "null",
    });
    expect(nul.status).toBe(400);
    const stranger = await jsonRequest(app, "PATCH", `/nests/${nestId}/publications/${id}`, { show_invite: false }, reviewer.apiKey);
    expect([403, 404]).toContain(stranger.status);
    const missing = await jsonRequest(app, "PATCH", `/nests/${nestId}/publications/nope`, { show_invite: false }, owner.apiKey);
    expect(missing.status).toBe(404);
    expect((await page(`/p/${slug}`)).html).toContain("data-cn-cta");
  });

  it("refuses a null body or a non-boolean show_invite on create with a 400", async () => {
    const nul = await app.request(`/nests/${nestId}/publications`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.apiKey}`, "Content-Type": "application/json" },
      body: "null",
    });
    expect(nul.status).toBe(400);
    const bad = await jsonRequest(app, "POST", `/nests/${nestId}/publications`, { node_id: "nodes/deck", show_invite: "false" }, owner.apiKey);
    expect(bad.status).toBe(400);
  });

  it("cannot switch the strip on for a white-label nest", async () => {
    const slug = await publish(whiteNest, "nodes/handbook", { show_invite: true });
    expect((await page(`/p/${slug}`)).html).not.toContain("data-cn-cta");
  });
});

describe("/p/:slug/og-image", () => {
  it("serves the default card for a nest with no logo", async () => {
    const slug = await publish(nestId, "nodes/handbook");
    const res = await app.request(`/p/${slug}/og-image`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'; sandbox");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(1000);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("serves the nest's logo when it has one, and the page asks for a small card", async () => {
    const b = await jsonRequest(app, "POST", "/nests", { name: "Branded" }, owner.apiKey);
    const brandNest = b.data.nest.id;
    await jsonRequest(app, "POST", `/nests/${brandNest}/nodes`, { title: "Handbook", content: "Body." }, owner.apiKey);
    const form = new FormData();
    form.append("file", new File([PNG_BYTES], "logo.png", { type: "image/png" }));
    const up = await app.request(`/nests/${brandNest}/assets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.apiKey}` },
      body: form,
    });
    const logoUrl = (await up.json()).url;
    const saved = await jsonRequest(app, "PATCH", `/nests/${brandNest}/branding`, { logo_url: logoUrl, site_title: "Acme" }, owner.apiKey);
    expect(saved.status).toBe(200);
    const slug = await publish(brandNest, "nodes/handbook");
    const { html } = await page(`/p/${slug}`);
    expect(meta(html, "og:image")).toBe(`http://localhost/p/${slug}/og-image`);
    expect(meta(html, "twitter:card")).toBe("summary");
    expect(meta(html, "og:site_name")).toBe("Acme");
    const res = await app.request(`/p/${slug}/og-image`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("answers an unknown slug 404 every time: a made-up slug takes no rate-limit bucket", async () => {
    for (let i = 0; i < 130; i++) {
      expect((await app.request("/p/made-up-slug/og-image")).status).toBe(404);
    }
  });

  it("404s for a link that is not live", async () => {
    expect((await app.request("/p/does-not-exist/og-image")).status).toBe(404);
    const slug = await publish(nestId, "nodes/handbook");
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/publications`, undefined, owner.apiKey);
    const id = list.data.publishes.find((p: any) => p.slug === slug).id;
    await jsonRequest(app, "DELETE", `/nests/${nestId}/publications/${id}`, undefined, owner.apiKey);
    expect((await app.request(`/p/${slug}/og-image`)).status).toBe(404);
  });
});
