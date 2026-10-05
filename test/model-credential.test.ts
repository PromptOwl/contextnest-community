/**
 * Which key a model call uses (pricing spec §6.1, §9.3): the server's or a
 * nest's own key only with the `byok` licence feature (Enterprise); otherwise
 * the PromptOwl gateway from the licence check, metered in credits.
 */
import { describe, it, expect, afterEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

const GATEWAY = { baseUrl: "https://llm.promptowl.ai", key: "sk-litellm-licence" };
const OWNER = "owner@acme.com";

let env: ReturnType<typeof setupTestEnv> | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.FEATURE_WORKFLOW_PLANE;
});

async function boot(opts: { features?: string[]; gateway?: typeof GATEWAY | null }) {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  env = setupTestEnv();
  const app = await createTestApp("key", { ownerEmail: OWNER, ...opts });
  const owner = await registerUser(app, OWNER);
  const { resolveModelCredential } = await import("../src/shared/model-credential.js");
  const { envValues } = await import("../src/workflow/env-routes.js");
  return { app, owner, resolveModelCredential, envValues };
}

describe("resolveModelCredential", () => {
  it("without byok, the server's own key is ignored and PromptOwl's gateway is used", async () => {
    const { resolveModelCredential } = await boot({ gateway: GATEWAY });
    process.env.ANTHROPIC_API_KEY = "sk-ant-own";
    expect(resolveModelCredential()).toEqual({ apiKey: GATEWAY.key, baseUrl: GATEWAY.baseUrl, source: "promptowl" });
    expect(resolveModelCredential({ ANTHROPIC_API_KEY: "sk-ant-nest" })?.source).toBe("promptowl");
  });

  it("with byok, a nest key beats the server key, and the server key beats the gateway", async () => {
    const { resolveModelCredential } = await boot({ features: ["byok"], gateway: GATEWAY });
    process.env.ANTHROPIC_API_KEY = "sk-ant-own";
    expect(resolveModelCredential()).toEqual({ apiKey: "sk-ant-own", baseUrl: null, source: "own" });
    expect(
      resolveModelCredential({ ANTHROPIC_API_KEY: "sk-ant-nest", ANTHROPIC_BASE_URL: "http://gw:4000" }),
    ).toEqual({ apiKey: "sk-ant-nest", baseUrl: "http://gw:4000", source: "own" });
  });

  it("with byok but no own key yet, PromptOwl's gateway still answers", async () => {
    const { resolveModelCredential } = await boot({ features: ["byok"], gateway: GATEWAY });
    expect(resolveModelCredential()?.source).toBe("promptowl");
  });

  it("nothing to call with is null (the existing 'no key' answer)", async () => {
    const { resolveModelCredential } = await boot({});
    process.env.ANTHROPIC_API_KEY = "sk-ant-own";
    expect(resolveModelCredential()).toBeNull();
  });
});

describe("the run bundle and Hootie use the same credential", () => {
  it("a nest's own key rides the bundle with byok, and is swapped for the gateway once byok is gone", async () => {
    const features = ["byok"];
    const { app, owner, envValues } = await boot({ features, gateway: GATEWAY });
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Runs" }, owner.apiKey);
    const nestId = nest.data.nest.id;
    const put = await jsonRequest(
      app, "PUT", `/nests/${nestId}/env`, { key: "ANTHROPIC_API_KEY", value: "sk-ant-nest" }, owner.apiKey,
    );
    expect(put.status).toBe(201);
    expect((await envValues(nestId)).ANTHROPIC_API_KEY).toBe("sk-ant-nest");

    features.length = 0; // the licence loses byok (read live on every call)
    const after = await envValues(nestId);
    expect(after.ANTHROPIC_API_KEY).toBe(GATEWAY.key);
    expect(after.ANTHROPIC_BASE_URL).toBe(GATEWAY.baseUrl);
  });

  it("Hootie without any credential says models come from PromptOwl", async () => {
    process.env.HOOTIE_ENABLED = "true";
    const { app, owner } = await boot({});
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Ask" }, owner.apiKey);
    const res = await jsonRequest(app, "POST", `/nests/${nest.data.nest.id}/chat`, { message: "hi" }, owner.apiKey);
    expect(res.status).toBe(503);
    expect(res.data.reason).toBe("no_api_key");
    expect(res.data.error).toMatch(/PromptOwl models/);
    delete process.env.HOOTIE_ENABLED;
  });
});

describe("own keys can't be stored without byok", () => {
  it("Settings refuses setting a key or gateway (403 byok_required) but allows clearing", async () => {
    const { app, owner } = await boot({ gateway: GATEWAY });
    for (const body of [{ anthropic_api_key: "sk-ant-x" }, { anthropic_base_url: "http://gw:4000" }]) {
      const res = await jsonRequest(app, "PATCH", "/admin/settings", body, owner.apiKey);
      expect(res.status).toBe(403);
      expect(res.data.code).toBe("byok_required");
    }
    const clear = await jsonRequest(app, "PATCH", "/admin/settings", { anthropic_api_key: "" }, owner.apiKey);
    expect(clear.status).toBe(200);
  });

  it("a nest env can't hold a model key without byok; other env keys are fine", async () => {
    const { app, owner } = await boot({ gateway: GATEWAY });
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Tools" }, owner.apiKey);
    const nestId = nest.data.nest.id;
    const key = await jsonRequest(
      app, "PUT", `/nests/${nestId}/env`, { key: "ANTHROPIC_API_KEY", value: "sk-ant-x" }, owner.apiKey,
    );
    expect(key.status).toBe(403);
    const other = await jsonRequest(
      app, "PUT", `/nests/${nestId}/env`, { key: "SLACK_TOKEN", value: "xoxb-1" }, owner.apiKey,
    );
    expect(other.status).toBe(201);
  });
});
