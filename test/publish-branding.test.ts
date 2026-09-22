/**
 * Per-nest branding on the `/p` published surface (CU-wdqcq02ptm).
 *
 * The /p pages are server-rendered HTML under strict CSPs. Branding must:
 *   - leave an UNBRANDED nest's output exactly as before (no brand markup, same
 *     CSP, the "Secured by" line still on the gate);
 *   - render every text field HTML-escaped;
 *   - only ever use validated `#rrggbb` colors;
 *   - never loosen the CSP: a nest-asset logo is inlined as a `data:` image
 *     (already allowed by the artifact sandbox's `img-src data: blob:`), and an
 *     external https image is simply not rendered on /p;
 *   - drop the "Secured by PromptOwl · ContextNest" line only when the server
 *     admin set hide_powered_by.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import { ARTIFACT_SANDBOX_CSP } from "../src/shared/artifact-sandbox.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Uint8Array.from(atob(PNG_B64), (ch) => ch.charCodeAt(0));

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let admin: { apiKey: string; userId: string; email: string };
let plainNest: string;
let brandNest: string;
let logoUrl: string;
// The unbranded document view's CSP, as served (the artifact sandbox plus the
// global frame-ancestors guard). A branded page must serve exactly this.
let baselineCsp: string;

async function publishDoc(nestId: string, extra: Record<string, unknown> = {}) {
  const created = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/publications`,
    { node_id: "nodes/handbook", access_mode: "public", ...extra },
    owner.apiKey,
  );
  expect(created.status).toBe(201);
  return created.data.publish.slug as string;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["admin@acme.com"] });
  admin = await registerUser(app, "admin@acme.com", "Admin");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  for (const name of ["Plain", "Branded"]) {
    const nest = await jsonRequest(app, "POST", "/nests", { name }, owner.apiKey);
    const id = nest.data.nest.id as string;
    await jsonRequest(
      app,
      "POST",
      `/nests/${id}/nodes`,
      { title: "Handbook", content: "# Handbook\n\nSee [the site](https://example.com)." },
      owner.apiKey,
    );
    if (name === "Plain") plainNest = id;
    else brandNest = id;
  }
  const form = new FormData();
  form.append("file", new File([PNG_BYTES], "logo.png", { type: "image/png" }));
  const up = await app.request(`/nests/${brandNest}/assets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${owner.apiKey}` },
    body: form,
  });
  logoUrl = (await up.json()).url;
  const saved = await jsonRequest(
    app,
    "PATCH",
    `/nests/${brandNest}/branding`,
    {
      logo_url: logoUrl,
      banner_url: "https://tracker.example.com/banner.png",
      accent_color: "#ffd700",
      header_bg_color: "#0f172a",
      site_title: `Acme <script>alert("x")</script> Docs`,
      footer_text: `© Acme & "Friends"`,
      footer_link_url: "https://acme.example.com/?a=1&b=2",
      footer_link_label: "Acme",
    },
    owner.apiKey,
  );
  expect(saved.status).toBe(200);
});

afterAll(() => env.cleanup());

describe("unbranded nest — /p output unchanged", () => {
  it("document view carries no brand markup and the exact sandbox CSP", async () => {
    const slug = await publishDoc(plainNest);
    const res = await app.request(`/p/${slug}`);
    expect(res.status).toBe(200);
    baselineCsp = res.headers.get("content-security-policy") ?? "";
    expect(baselineCsp.startsWith(ARTIFACT_SANDBOX_CSP)).toBe(true);
    const html = await res.text();
    expect(html).not.toContain("cn-brand");
    expect(html).not.toContain("--cn-accent");
    expect(html).toContain("<main>");
  });

  it("gate page still says Secured by PromptOwl · ContextNest", async () => {
    const slug = await publishDoc(plainNest, { access_mode: "code", code: "swordfish" });
    const html = await (await app.request(`/p/${slug}`)).text();
    expect(html).toContain("Secured by PromptOwl · ContextNest");
    expect(html).not.toContain("cn-brand");
  });
});

describe("branded nest — /p", () => {
  it("renders escaped branding with the same CSP", async () => {
    const slug = await publishDoc(brandNest);
    const res = await app.request(`/p/${slug}`);
    expect(res.status).toBe(200);
    // CSP is NOT loosened for branding: identical to the unbranded page's.
    expect(res.headers.get("content-security-policy")).toBe(baselineCsp);
    expect(baselineCsp).not.toContain("https:");
    const html = await res.text();
    expect(html).toContain("cn-brand");
    // Site title escaped, never live markup.
    expect(html).not.toContain(`<script>alert("x")</script>`);
    expect(html).toContain("Acme &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Docs");
    expect(html).toContain("© Acme &amp; &quot;Friends&quot;");
    expect(html).toContain(`href="https://acme.example.com/?a=1&amp;b=2"`);
    // Accent applied as a validated hex; a light accent gets dark text on it.
    expect(html).toContain("--cn-accent:#ffd700");
    expect(html).toContain("--cn-accent-fg:#000000");
    // Logo inlined as data: (allowed by img-src data:), not fetched same-origin.
    expect(html).toContain(`src="data:image/png;base64,${PNG_B64}"`);
    expect(html).not.toContain(logoUrl);
    // External https images are not rendered on /p — the sandbox has no https: img-src.
    expect(html).not.toContain("tracker.example.com");
    // Content still there.
    expect(html).toContain("Handbook");
  });

  it("gate page is branded and keeps the Secured-by line by default", async () => {
    const slug = await publishDoc(brandNest, { access_mode: "code", code: "swordfish" });
    const html = await (await app.request(`/p/${slug}`)).text();
    expect(html).toContain("cn-brand");
    expect(html).toContain("--cn-accent:#ffd700");
    expect(html).toContain("Secured by PromptOwl · ContextNest");
    expect(html).not.toContain(`<script>alert("x")</script>`);
  });

  it("comment shell keeps its CSP and picks up the accent", async () => {
    const slug = await publishDoc(brandNest, { comments_enabled: true });
    const res = await app.request(`/p/${slug}`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("img-src");
    const html = await res.text();
    expect(html).toContain("--cn-accent:#ffd700");
  });

  it("hide_powered_by (server admin) drops the Secured-by line", async () => {
    const current = (await jsonRequest(app, "GET", `/nests/${brandNest}`, undefined, owner.apiKey)).data.nest
      .branding;
    const saved = await jsonRequest(
      app,
      "PATCH",
      `/nests/${brandNest}/branding`,
      { ...current, hide_powered_by: true },
      admin.apiKey,
    );
    expect(saved.status).toBe(200);
    const slug = await publishDoc(brandNest, { access_mode: "code", code: "swordfish" });
    const html = await (await app.request(`/p/${slug}`)).text();
    expect(html).not.toContain("Secured by PromptOwl");
  });

  // Review finding (PR #321, round 2): an asset over the inline cap is skipped
  // without being read whole (stat first), and the page still renders.
  it("an oversized banner asset is not inlined", async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 10);
    big.set(PNG_BYTES, 0);
    const form = new FormData();
    form.append("file", new File([big], "huge.png", { type: "image/png" }));
    const up = await app.request(`/nests/${brandNest}/assets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.apiKey}` },
      body: form,
    });
    const bigUrl = (await up.json()).url;
    const saved = await jsonRequest(
      app,
      "PATCH",
      `/nests/${brandNest}/branding`,
      { site_title: "Big", banner_url: bigUrl, banner_headline: "Hello", hide_powered_by: true },
      admin.apiKey,
    );
    expect(saved.status).toBe(200);
    const slug = await publishDoc(brandNest);
    const html = await (await app.request(`/p/${slug}`)).text();
    expect(html).toContain("Hello");
    expect(html).not.toContain("background-image");
  });
});
