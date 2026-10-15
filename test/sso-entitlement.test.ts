/**
 * Enterprise SSO is Enterprise only (licence feature sso, CU-wdqcq04t04).
 *
 * Entra ID, Okta and custom OIDC issuers need the entitlement; the Google
 * preset works on every plan. Only a change is refused, so a server already
 * on an enterprise IdP keeps signing in.
 */
import { describe, it, expect, afterEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

const OIDC_ENV = ["OIDC_ENABLED", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"];
const ENTRA = "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0";
const GOOGLE = "https://accounts.google.com";

afterEach(() => {
  for (const k of OIDC_ENV) delete process.env[k];
});

async function adminApp(tier: string) {
  setupTestEnv();
  for (const k of OIDC_ENV) delete process.env[k];
  const owner = `admin-${tier}@acme.com`;
  const app = await createTestApp("key", { ownerEmail: owner, tier });
  const admin = await registerUser(app, owner);
  const patch = (body: Record<string, unknown>) =>
    jsonRequest(app, "PATCH", "/admin/settings", body, admin.apiKey);
  const settings = async () => (await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey)).data;
  return { patch, settings };
}

describe.each(["community", "self-hosted"])("%s licence (no sso)", (tier) => {
  it("reports sso unavailable", async () => {
    const { settings } = await adminApp(tier);
    expect((await settings()).sso_available).toBe(false);
  });

  it("allows the Google preset", async () => {
    const { patch } = await adminApp(tier);
    const res = await patch({ oidc_issuer: GOOGLE });
    expect(res.status).toBe(200);
    expect(process.env.OIDC_ISSUER).toBe(GOOGLE);
  });

  it("refuses an enterprise issuer and writes nothing", async () => {
    const { patch } = await adminApp(tier);
    const res = await patch({ oidc_issuer: ENTRA, oidc_client_id: "app" });
    expect(res.status).toBe(403);
    expect(res.data.code).toBe("sso_required");
    expect(process.env.OIDC_ISSUER).toBeUndefined();
    expect(process.env.OIDC_CLIENT_ID).toBeUndefined();
  });

  it("keeps an already-configured enterprise IdP working, but won't turn it back on", async () => {
    const { patch, settings } = await adminApp(tier);
    Object.assign(process.env, {
      OIDC_ENABLED: "true",
      OIDC_ISSUER: ENTRA,
      OIDC_CLIENT_ID: "app",
      OIDC_CLIENT_SECRET: "old",
    });
    expect((await settings()).oidc_ready).toBe(true);
    // Whole-form save echoing the issuer + secret rotation is fine.
    expect((await patch({ oidc_enabled: true, oidc_issuer: ENTRA, oidc_client_secret: "new" })).status).toBe(200);
    expect((await settings()).oidc_ready).toBe(true);
    // Off is always allowed; back on needs Enterprise.
    expect((await patch({ oidc_enabled: false })).status).toBe(200);
    expect((await patch({ oidc_enabled: true })).data.code).toBe("sso_required");
  });
});

describe("enterprise licence", () => {
  it("reports sso available and allows an enterprise issuer", async () => {
    const { patch, settings } = await adminApp("enterprise");
    expect((await settings()).sso_available).toBe(true);
    const res = await patch({ oidc_issuer: ENTRA });
    expect(res.status).toBe(200);
    expect(process.env.OIDC_ISSUER).toBe(ENTRA);
  });
});
