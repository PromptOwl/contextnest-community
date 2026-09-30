/**
 * Hootie in the nest — off by default, enterprise-only custom identity
 * (CU-wdqcq03ewc).
 *
 * The assistant's name, logo, accent colour and greeting are server-level
 * settings an admin edits from Settings → General. Setting them is an
 * enterprise entitlement enforced on the server: a non-enterprise licence is
 * refused (403, nothing written) and every surface shows the default Hootie
 * identity, even if values were stored earlier (a lapsed licence reverts).
 */
import { describe, it, expect, afterEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

const BRAND_ENV = ["HOOTIE_NAME", "HOOTIE_LOGO_URL", "HOOTIE_ACCENT_COLOR", "HOOTIE_GREETING"];

afterEach(() => {
  for (const k of [...BRAND_ENV, "HOOTIE_ENABLED"]) delete process.env[k];
});

async function adminApp(tier: string, owner = `admin-${tier}@acme.com`) {
  setupTestEnv();
  for (const k of [...BRAND_ENV, "HOOTIE_ENABLED"]) delete process.env[k];
  const app = await createTestApp("key", { ownerEmail: owner, tier });
  const admin = await registerUser(app, owner);
  return { app, admin };
}

const health = async (app: any) => (await app.request("/health")).json();

describe("Hootie default and toggle", () => {
  it("is off on a fresh install: /health says so and the chat route 404s", async () => {
    const { app, admin } = await adminApp("community");
    expect((await health(app)).hootie_enabled).toBe(false);
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "N" }, admin.apiKey);
    const res = await app.request(`/nests/${data.nest.id}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.apiKey}` },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(404);
  });

  it("an admin turns it on and off from settings, overriding a deploy env of true", async () => {
    const { app, admin } = await adminApp("community");
    process.env.HOOTIE_ENABLED = "true";
    expect((await health(app)).hootie_enabled).toBe(true);
    const off = await jsonRequest(app, "PATCH", "/admin/settings", { hootie_enabled: false }, admin.apiKey);
    expect(off.status).toBe(200);
    expect((await health(app)).hootie_enabled).toBe(false);
    const on = await jsonRequest(app, "PATCH", "/admin/settings", { hootie_enabled: true }, admin.apiKey);
    expect(on.status).toBe(200);
    expect((await health(app)).hootie_enabled).toBe(true);
  });
});

describe("Hootie branding — enterprise only", () => {
  const brand = {
    hootie_name: "Ava",
    hootie_logo_url: "https://cdn.acme.com/ava.png",
    hootie_accent_color: "#0a7cff",
    hootie_greeting: "Hi, I'm Ava from Acme.",
  };

  it("non-enterprise: settings report branding unavailable and /health shows the default identity", async () => {
    const { app, admin } = await adminApp("community");
    const s = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(s.status).toBe(200);
    expect(s.data.hootie_branding_available).toBe(false);
    const h = await health(app);
    expect(h.hootie_brand).toEqual({
      name: "Hootie",
      logo_url: null,
      accent_color: null,
      greeting: null,
    });
    expect(h.hootie_branding_available).toBe(false);
  });

  it("non-enterprise: setting any branding field is refused (403) and nothing is written — even alongside other settings", async () => {
    const { app, admin } = await adminApp("community");
    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { hootie_enabled: true, ...brand },
      admin.apiKey,
    );
    expect(res.status).toBe(403);
    expect(res.data.code).toBe("enterprise_required");
    expect(process.env.HOOTIE_NAME).toBeUndefined();
    expect((await health(app)).hootie_enabled).toBe(false);
  });

  it("non-enterprise: echoing the stored branding values back is a no-op, so an unrelated save still works", async () => {
    const { app, admin } = await adminApp("community");
    const current = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      {
        hootie_model: "claude-sonnet-5",
        hootie_name: current.data.hootie_name,
        hootie_logo_url: current.data.hootie_logo_url,
        hootie_accent_color: current.data.hootie_accent_color,
        hootie_greeting: current.data.hootie_greeting,
      },
      admin.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.settings.hootie_model).toBe("claude-sonnet-5");
    // A real change is still refused.
    const change = await jsonRequest(app, "PATCH", "/admin/settings", { hootie_name: "Ava" }, admin.apiKey);
    expect(change.status).toBe(403);
    delete process.env.HOOTIE_MODEL;
  });

  it("non-enterprise: branding set out-of-band (deploy env) still shows the default identity", async () => {
    const { app } = await adminApp("community");
    process.env.HOOTIE_NAME = "Ava";
    process.env.HOOTIE_ACCENT_COLOR = "#0a7cff";
    const h = await health(app);
    expect(h.hootie_brand.name).toBe("Hootie");
    expect(h.hootie_brand.accent_color).toBeNull();
  });

  it("enterprise: an admin sets name, logo, colour and greeting; /health and settings return them", async () => {
    const { app, admin } = await adminApp("enterprise");
    const res = await jsonRequest(app, "PATCH", "/admin/settings", brand, admin.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.settings.hootie_branding_available).toBe(true);
    expect(res.data.settings.hootie_name).toBe("Ava");
    const h = await health(app);
    expect(h.hootie_branding_available).toBe(true);
    expect(h.hootie_brand).toEqual({
      name: "Ava",
      logo_url: "https://cdn.acme.com/ava.png",
      accent_color: "#0a7cff",
      greeting: "Hi, I'm Ava from Acme.",
    });
  });

  it("enterprise: rejects unsafe or malformed values with field errors, writing nothing", async () => {
    const { app, admin } = await adminApp("enterprise");
    const bad = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      {
        hootie_name: "x".repeat(41),
        hootie_logo_url: "http://cdn.acme.com/ava.png",
        hootie_accent_color: "red",
        hootie_greeting: "y".repeat(201),
      },
      admin.apiKey,
    );
    expect(bad.status).toBe(400);
    const errs = bad.data.fieldErrors ?? bad.data.errors ?? {};
    expect(Object.keys(errs).sort()).toEqual(
      ["hootie_accent_color", "hootie_greeting", "hootie_logo_url", "hootie_name"],
    );
    expect(process.env.HOOTIE_NAME).toBeUndefined();

    for (const url of [
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "https://",
      "https://user:pass@cdn.acme.com/ava.png",
      "https://cdn.acme.com/ava.svg",
    ]) {
      const r = await jsonRequest(app, "PATCH", "/admin/settings", { hootie_logo_url: url }, admin.apiKey);
      expect(r.status).toBe(400);
    }
  });

  it("enterprise: names are single-line and colours normalise; empty values reset to the default", async () => {
    const { app, admin } = await adminApp("enterprise");
    await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { hootie_name: "  Ava\n\n  Bot ", hootie_accent_color: "#0AF" },
      admin.apiKey,
    );
    let h = await health(app);
    expect(h.hootie_brand.name).toBe("Ava Bot");
    expect(h.hootie_brand.accent_color).toBe("#00aaff");
    await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { hootie_name: "", hootie_accent_color: "" },
      admin.apiKey,
    );
    h = await health(app);
    expect(h.hootie_brand.name).toBe("Hootie");
    expect(h.hootie_brand.accent_color).toBeNull();
  });

  it("a lapsed licence reverts to the default identity without clearing the stored values", async () => {
    const owner = "admin-lapse@acme.com";
    const { app, admin } = await adminApp("enterprise", owner);
    await jsonRequest(app, "PATCH", "/admin/settings", brand, admin.apiKey);
    // Same server, licence no longer enterprise.
    const lapsed = await createTestApp("key", { ownerEmail: owner, tier: "community" });
    expect((await health(lapsed)).hootie_brand.name).toBe("Hootie");
    expect(process.env.HOOTIE_NAME).toBe("Ava");
  });
});
