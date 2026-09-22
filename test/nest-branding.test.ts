/**
 * Per-nest branding for public reader sites — PATCH /nests/:id/branding.
 *
 * CU-wdqcq02ptm. A nest owner/admin brands the public reader (logo, banner,
 * accent + header colors, page tint, site title, footer, favicon). The
 * security-relevant properties this file pins:
 *
 *   - colors are strict `#rgb` / `#rrggbb` only — a CSS-injection string like
 *     `red; background:url(...)` is refused with 400 and nothing is saved;
 *   - image fields take THIS nest's uploaded image asset or an https image URL
 *     — `javascript:`, `data:`, plain http, SVG, a non-image URL, a video
 *     asset, another nest's asset, or a missing asset are all 400;
 *   - only the nest owner/admin (or the server admin) may write it — an
 *     editor or viewer gets 403, an anonymous caller 401;
 *   - `hide_powered_by` (white-label) is server-admin only, and survives an
 *     owner's later edit that doesn't mention it;
 *   - the branding rides the ordinary GET /nests/:id payload, so an anonymous
 *     reader of a public reader-mode nest sees it — and a private nest still
 *     404s, leaking nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  jsonRequest,
  registerUser,
  resetAuthRateLimit,
} from "./helpers";

// 1x1 transparent PNG.
const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (ch) => ch.charCodeAt(0),
);

type User = { apiKey: string; userId: string; email: string };

describe("PATCH /nests/:id/branding", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let admin: User;
  let owner: User;
  let nestAdmin: User;
  let writer: User;
  let reader: User;
  let nestId: string;
  let privateNestId: string;
  let logoUrl: string;
  let otherNestAssetUrl: string;
  let videoUrl: string;

  async function upload(nest: string, name: string, key: string, type = "image/png") {
    const form = new FormData();
    form.append("file", new File([PNG_BYTES], name, { type }));
    const res = await app.request(`/nests/${nest}/assets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    return (await res.json()).url as string;
  }

  const patch = (body: any, key?: string, nest = nestId) =>
    jsonRequest(app, "PATCH", `/nests/${nest}/branding`, body, key);
  const read = (key?: string, nest = nestId) =>
    jsonRequest(app, "GET", `/nests/${nest}`, undefined, key);

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { superAdmins: ["admin@acme.com"] });
    admin = await registerUser(app, "admin@acme.com", "Admin");
    await resetAuthRateLimit();
    owner = await registerUser(app, "owner@acme.com", "Owner");
    await resetAuthRateLimit();
    nestAdmin = await registerUser(app, "nest-admin@acme.com", "Nest Admin");
    await resetAuthRateLimit();
    writer = await registerUser(app, "writer@acme.com", "Writer");
    await resetAuthRateLimit();
    reader = await registerUser(app, "reader@acme.com", "Reader");

    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Acme Docs" }, owner.apiKey);
    nestId = data.nest.id;
    const priv = await jsonRequest(app, "POST", "/nests", { name: "Secret" }, owner.apiKey);
    privateNestId = priv.data.nest.id;

    for (const [u, permission] of [
      [nestAdmin, "admin"],
      [writer, "write"],
      [reader, "read"],
    ] as const) {
      await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/collaborators`,
        { email: u.email, permission },
        owner.apiKey,
      );
    }

    logoUrl = await upload(nestId, "logo.png", owner.apiKey);
    otherNestAssetUrl = await upload(privateNestId, "other.png", owner.apiKey);
    videoUrl = await upload(nestId, "clip.mp4", owner.apiKey, "video/mp4");
  });

  afterAll(() => env.cleanup());

  it("an unbranded nest reads branding: null (and never the raw column)", async () => {
    const res = await read(owner.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.nest.branding).toBeNull();
    expect(res.data.nest).not.toHaveProperty("branding_json");
  });

  it("the owner saves a full branding and GET reflects it", async () => {
    const body = {
      logo_url: logoUrl,
      banner_url: "https://cdn.example.com/brand/banner.jpg",
      banner_headline: "Acme Handbook",
      banner_subtext: "Everything we know, versioned.",
      accent_color: "#E11D48",
      header_bg_color: "#0f172a",
      page_tint_color: "#fef",
      site_title: "Acme Docs",
      footer_text: "© Acme Corp",
      footer_link_url: "https://acme.example.com/",
      footer_link_label: "acme.example.com",
      favicon_url: logoUrl,
    };
    const res = await patch(body, owner.apiKey);
    expect(res.status).toBe(200);
    // Colors are normalised to lowercase #rrggbb.
    expect(res.data.branding.accent_color).toBe("#e11d48");
    expect(res.data.branding.page_tint_color).toBe("#ffeeff");
    expect(res.data.branding.logo_url).toBe(logoUrl);

    const got = await read(owner.apiKey);
    expect(got.data.nest.branding.site_title).toBe("Acme Docs");
    expect(got.data.nest.branding.banner_url).toBe("https://cdn.example.com/brand/banner.jpg");
    expect(got.data.nest.branding.hide_powered_by).toBe(false);
  });

  it("a nest admin collaborator may edit branding", async () => {
    const res = await patch({ site_title: "Acme Knowledge", accent_color: "#2563eb" }, nestAdmin.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.branding.site_title).toBe("Acme Knowledge");
    // PATCH replaces the whole branding object — fields not sent are cleared.
    expect(res.data.branding.logo_url ?? null).toBeNull();
  });

  it("an editor (write) is refused with 403 and nothing changes", async () => {
    const res = await patch({ site_title: "Hijacked" }, writer.apiKey);
    expect(res.status).toBe(403);
    expect((await read(owner.apiKey)).data.nest.branding.site_title).toBe("Acme Knowledge");
  });

  it("a viewer (read) is refused with 403", async () => {
    const res = await patch({ site_title: "Hijacked" }, reader.apiKey);
    expect(res.status).toBe(403);
  });

  it("an anonymous caller is refused (401)", async () => {
    const res = await patch({ site_title: "Hijacked" });
    expect(res.status).toBe(401);
  });

  describe("validation — 400 and nothing saved", () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["CSS injection in accent", { accent_color: "red; background:url(https://evil.example/x)" }],
      ["named color", { accent_color: "red" }],
      ["5-digit hex", { accent_color: "#12345" }],
      ["non-hex digits", { header_bg_color: "#ggg" }],
      ["trailing semicolon", { page_tint_color: "#fff;" }],
      ["expression() payload", { header_bg_color: "expression(alert(1))" }],
      ["var() payload", { accent_color: "var(--x)" }],
      ["javascript: logo", { logo_url: "javascript:alert(1)" }],
      ["data: logo", { logo_url: "data:image/png;base64,iVBORw0KGgo=" }],
      ["plain http logo", { logo_url: "http://cdn.example.com/logo.png" }],
      ["svg banner", { banner_url: "https://cdn.example.com/banner.svg" }],
      ["non-image https URL", { banner_url: "https://cdn.example.com/page.html" }],
      ["credentials in URL", { logo_url: "https://user:pw@cdn.example.com/logo.png" }],
      ["protocol-relative", { logo_url: "//cdn.example.com/logo.png" }],
      ["another nest's asset", { logo_url: "OTHER" }],
      ["video asset as logo", { logo_url: "VIDEO" }],
      ["missing asset", { favicon_url: "MISSING" }],
      ["traversal in asset path", { logo_url: "BADPATH" }],
      ["javascript: footer link", { footer_link_url: "javascript:alert(1)" }],
      ["unknown key", { custom_css: "body{display:none}" }],
      ["overlong site title", { site_title: "x".repeat(121) }],
      ["non-boolean hide", { hide_powered_by: "yes" }],
      ["non-string title", { site_title: 42 }],
    ];
    for (const [label, body] of bad) {
      it(label, async () => {
        const before = (await read(owner.apiKey)).data.nest.branding;
        const resolved: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(body)) {
          resolved[k] =
            v === "OTHER"
              ? otherNestAssetUrl
              : v === "VIDEO"
                ? videoUrl
                : v === "MISSING"
                  ? `/nests/${nestId}/assets/00000000-0000-4000-8000-000000000000.png`
                  : v === "BADPATH"
                    ? `/nests/${nestId}/assets/../../../etc/passwd.png`
                    : v;
        }
        const res = await patch(resolved, owner.apiKey);
        expect(res.status).toBe(400);
        expect((await read(owner.apiKey)).data.nest.branding).toEqual(before);
      });
    }
  });

  describe("hide_powered_by is server-admin only", () => {
    it("the owner cannot turn it on (403)", async () => {
      const res = await patch({ site_title: "Acme", hide_powered_by: true }, owner.apiKey);
      expect(res.status).toBe(403);
      expect((await read(owner.apiKey)).data.nest.branding.hide_powered_by).toBe(false);
    });

    it("the server admin can turn it on", async () => {
      const res = await patch({ site_title: "Acme", hide_powered_by: true }, admin.apiKey);
      expect(res.status).toBe(200);
      expect(res.data.branding.hide_powered_by).toBe(true);
    });

    it("an owner edit that omits it keeps it on", async () => {
      const res = await patch({ site_title: "Acme v2", accent_color: "#0ea5e9" }, owner.apiKey);
      expect(res.status).toBe(200);
      expect(res.data.branding.hide_powered_by).toBe(true);
      expect(res.data.branding.site_title).toBe("Acme v2");
    });

    // Review finding (PR #321): a non-admin's full clear used to drop the
    // admin's white-label flag along with everything else.
    it("an owner's full clear (null or {}) keeps the admin's hide_powered_by", async () => {
      expect((await patch({ site_title: "Acme", hide_powered_by: true }, admin.apiKey)).status).toBe(200);
      const viaNull = await patch(null as any, owner.apiKey);
      expect(viaNull.status).toBe(200);
      expect(viaNull.data.branding).toEqual({ hide_powered_by: true });
      expect((await read(owner.apiKey)).data.nest.branding?.hide_powered_by).toBe(true);
      const viaEmpty = await patch({}, owner.apiKey);
      expect(viaEmpty.status).toBe(200);
      expect(viaEmpty.data.branding?.hide_powered_by).toBe(true);
      // Restore the state the next test expects.
      expect((await patch({ site_title: "Acme v2", hide_powered_by: true }, owner.apiKey)).status).toBe(200);
    });

    it("the server admin's full clear really clears", async () => {
      const res = await patch(null as any, admin.apiKey);
      expect(res.status).toBe(200);
      expect(res.data.branding).toBeNull();
      expect((await patch({ site_title: "Acme v2", hide_powered_by: true }, admin.apiKey)).status).toBe(200);
    });

    it("an owner may turn it back off (the less-privileged state)", async () => {
      const res = await patch({ site_title: "Acme v2", hide_powered_by: false }, owner.apiKey);
      expect(res.status).toBe(200);
      expect(res.data.branding.hide_powered_by).toBe(false);
    });
  });

  it("null clears branding back to unbranded", async () => {
    const res = await patch(null as any, owner.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.branding).toBeNull();
    expect((await read(owner.apiKey)).data.nest.branding).toBeNull();
  });

  it("an empty object also clears", async () => {
    await patch({ site_title: "Temp" }, owner.apiKey);
    const res = await patch({}, owner.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.branding).toBeNull();
  });

  describe("public read", () => {
    beforeAll(async () => {
      await jsonRequest(
        app,
        "PATCH",
        `/nests/${nestId}/visibility`,
        { visibility: "public", acknowledge_public: true },
        owner.apiKey,
      );
      await jsonRequest(app, "PATCH", `/nests/${nestId}/reader-mode`, { enabled: true }, owner.apiKey);
      await patch({ site_title: "Acme Public", accent_color: "#e11d48", logo_url: logoUrl }, owner.apiKey);
      await patch({ site_title: "Hidden Brand" }, owner.apiKey, privateNestId);
    });

    it("an anonymous reader of a public reader-mode nest gets the branding", async () => {
      const res = await read(undefined);
      expect(res.status).toBe(200);
      expect(res.data.nest.reader_mode).toBe(1);
      expect(res.data.nest.branding).toMatchObject({
        site_title: "Acme Public",
        accent_color: "#e11d48",
        logo_url: logoUrl,
      });
      // …and the logo it points at is servable to that same anonymous reader.
      const img = await app.request(logoUrl);
      expect(img.status).toBe(200);
    });

    it("a private nest's branding is not readable anonymously", async () => {
      const res = await read(undefined, privateNestId);
      expect(res.status).not.toBe(200);
      expect(JSON.stringify(res.data)).not.toContain("Hidden Brand");
    });

    it("reader-mode gating is unchanged — an anonymous caller still can't configure it", async () => {
      const res = await jsonRequest(app, "PATCH", `/nests/${nestId}/reader-mode`, { enabled: false });
      expect(res.status).toBe(401);
    });
  });
});
