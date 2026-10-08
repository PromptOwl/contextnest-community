/**
 * Which key a model call uses (pricing spec §6.1, §9.3): the server's or a
 * nest's own key only with the `byok` licence feature (Enterprise); otherwise
 * the PromptOwl gateway from the licence check, metered in credits.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

const GATEWAY = {
  baseUrl: "https://llm.promptowl.ai",
  key: "sk-litellm-licence",
  defaultModel: "default-claude/claude-sonnet-5",
};
const OWN_MODEL = "community-lic1-openai/gpt-5.6-sol";
const OWN_GW = {
  baseUrl: "https://llm.promptowl.ai",
  key: "sk-litellm-own",
  models: [OWN_MODEL],
  providers: { openai: { masked: "9876", updatedAt: null } },
};
const OWNER = "owner@acme.com";

let env: ReturnType<typeof setupTestEnv> | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.FEATURE_WORKFLOW_PLANE;
});

async function boot(opts: { features?: string[]; gateway?: typeof GATEWAY | null; ownGateway?: typeof OWN_GW | null }) {
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
    expect(resolveModelCredential()).toEqual({
      apiKey: GATEWAY.key, baseUrl: GATEWAY.baseUrl, source: "promptowl", defaultModel: GATEWAY.defaultModel,
    });
    expect(resolveModelCredential({ ANTHROPIC_API_KEY: "sk-ant-nest" })?.source).toBe("promptowl");
  });

  it("with byok, a nest key beats the server key, and the server key beats the gateway", async () => {
    const { resolveModelCredential } = await boot({ features: ["byok"], gateway: GATEWAY });
    process.env.ANTHROPIC_API_KEY = "sk-ant-own";
    expect(resolveModelCredential()).toEqual({ apiKey: "sk-ant-own", baseUrl: null, source: "own", defaultModel: null });
    expect(
      resolveModelCredential({ ANTHROPIC_API_KEY: "sk-ant-nest", ANTHROPIC_BASE_URL: "http://gw:4000" }),
    ).toEqual({ apiKey: "sk-ant-nest", baseUrl: "http://gw:4000", source: "own", defaultModel: null });
  });

  it("a nest URL without a nest key never receives the server's key", async () => {
    const { resolveModelCredential } = await boot({ features: ["byok"], gateway: GATEWAY });
    process.env.ANTHROPIC_API_KEY = "sk-ant-own";
    expect(resolveModelCredential({ ANTHROPIC_BASE_URL: "https://evil.example" })).toEqual({
      apiKey: "sk-ant-own", baseUrl: null, source: "own", defaultModel: null,
    });
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

describe("which model Hootie asks for", () => {
  it("the admin's pick, else the gateway's team default, else Anthropic's id", async () => {
    const { hootieModel } = await import("../src/shared/model-credential.js");
    const own = { apiKey: "k", baseUrl: null, source: "own" as const, defaultModel: null };
    const gw = { ...own, source: "promptowl" as const, defaultModel: "default-claude/claude-sonnet-5" };
    const before = process.env.HOOTIE_MODEL;
    try {
      delete process.env.HOOTIE_MODEL;
      expect(hootieModel(gw)).toBe("claude-sonnet-5") // shown and stored without the prefix;
      expect(hootieModel(own)).toBe("claude-sonnet-5");
      expect(hootieModel(null)).toBe("claude-sonnet-5");
      process.env.HOOTIE_MODEL = "gpt-5.5";
      expect(hootieModel(gw)).toBe("gpt-5.5");
    } finally {
      if (before === undefined) delete process.env.HOOTIE_MODEL;
      else process.env.HOOTIE_MODEL = before;
    }
  });
});

describe("the PromptOwl prefix goes on at call time", () => {
  afterEach(() => vi.restoreAllMocks());
  const gw = {
    apiKey: "sk-gw-prefix", baseUrl: "https://llm.promptowl.ai", source: "promptowl" as const,
    defaultModel: "default-claude/claude-sonnet-5",
  };

  it("a plain name becomes the team's full name; full names and own keys go as given", async () => {
    const { resolveGatewayModel } = await import("../src/shared/model-credential.js");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "default-claude/claude-sonnet-5" }, { id: "default-openai/gpt-5.5" }] })),
    );
    expect(await resolveGatewayModel(gw, "claude-sonnet-5")).toBe("default-claude/claude-sonnet-5");
    expect(await resolveGatewayModel(gw, "gpt-5.5")).toBe("default-openai/gpt-5.5");
    expect(await resolveGatewayModel(gw, "default-openai/gpt-5.5")).toBe("default-openai/gpt-5.5");
    expect(await resolveGatewayModel(gw, "not-in-catalog")).toBe("not-in-catalog");
    const own = { ...gw, source: "own" as const, defaultModel: null };
    expect(await resolveGatewayModel(own, "claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("a gateway that can't list still sends the name", async () => {
    const { resolveGatewayModel } = await import("../src/shared/model-credential.js");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 503 }));
    expect(await resolveGatewayModel({ ...gw, apiKey: "sk-gw-down" }, "gpt-5.5")).toBe("gpt-5.5");
  });
});

describe("/admin/models — the Hootie model picker", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists what the gateway key can reach, with the model in use; admins only", async () => {
    const { app, owner } = await boot({ gateway: GATEWAY });
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init?: any) => {
      if (String(url) !== "https://llm.promptowl.ai/v1/models") return realFetch(url, init);
      expect(init.headers.authorization).toBe(`Bearer ${GATEWAY.key}`);
      return new Response(JSON.stringify({ data: [{ id: "default-openai/gpt-5.5" }, { id: "default-claude/claude-sonnet-5" }] }));
    });
    const res = await jsonRequest(app, "GET", "/admin/models", undefined, owner.apiKey);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      models: ["claude-sonnet-5", "gpt-5.5"],
      current: "claude-sonnet-5",
      source: "promptowl",
    });
    expect(spy).toHaveBeenCalled();

    const member = await registerUser(app, "member@acme.com");
    expect((await jsonRequest(app, "GET", "/admin/models", undefined, member.apiKey)).status).toBe(403);
  });

  it("Settings reports the model in use, so the picker preselects it", async () => {
    const before = process.env.HOOTIE_MODEL;
    delete process.env.HOOTIE_MODEL;
    try {
      const { app, owner } = await boot({ gateway: GATEWAY });
      const res = await jsonRequest(app, "GET", "/admin/settings", undefined, owner.apiKey);
      expect(res.data.hootie_model).toBe("claude-sonnet-5");
    } finally {
      if (before !== undefined) process.env.HOOTIE_MODEL = before;
    }
  });

  it("a gateway that can't list still answers, so a name can be typed", async () => {
    const { app, owner } = await boot({ gateway: GATEWAY });
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init?: any) =>
      String(url).startsWith("https://llm.promptowl.ai") ? new Response("nope", { status: 503 }) : realFetch(url, init),
    );
    const res = await jsonRequest(app, "GET", "/admin/models", undefined, owner.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.models).toEqual([]);
    expect(res.data.current).toBe("claude-sonnet-5");
  });
});

describe("the UI is told whether own keys are allowed", () => {
  it("/health and /admin/settings carry byok_available", async () => {
    for (const features of [[], ["byok"]]) {
      const { app, owner } = await boot({ features, gateway: GATEWAY });
      const health = await jsonRequest(app, "GET", "/health");
      const settings = await jsonRequest(app, "GET", "/admin/settings", undefined, owner.apiKey);
      expect(health.data.byok_available).toBe(features.length > 0);
      expect(settings.data.byok_available).toBe(features.length > 0);
      env?.cleanup();
      env = null;
    }
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

describe("the Hootie model picks the key (own providers, byok)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("an own-provider model goes on the own key; any other model keeps today's key", async () => {
    const { resolveModelCredential } = await boot({ features: ["byok"], gateway: GATEWAY, ownGateway: OWN_GW });
    expect(resolveModelCredential({}, OWN_MODEL)).toEqual({
      apiKey: OWN_GW.key, baseUrl: OWN_GW.baseUrl, source: "own", defaultModel: null,
    });
    expect(resolveModelCredential({}, "grok-4")?.source).toBe("promptowl");
    expect(resolveModelCredential()?.source).toBe("promptowl");
    process.env.ANTHROPIC_API_KEY = "sk-ant-own";
    expect(resolveModelCredential({}, "claude-sonnet-5")?.apiKey).toBe("sk-ant-own");
    expect(resolveModelCredential({}, OWN_MODEL)?.apiKey).toBe(OWN_GW.key);
  });

  it("without byok an own-provider model name gets no own key", async () => {
    const { resolveModelCredential } = await boot({ gateway: GATEWAY, ownGateway: OWN_GW });
    expect(resolveModelCredential({}, OWN_MODEL)?.source).toBe("promptowl");
  });

  it("/admin/models adds the own-provider models and names them", async () => {
    const { app, owner } = await boot({ features: ["byok"], gateway: GATEWAY, ownGateway: OWN_GW });
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init?: any) =>
      String(url) === "https://llm.promptowl.ai/v1/models"
        ? new Response(JSON.stringify({ data: [{ id: "default-claude/claude-sonnet-5" }] }))
        : realFetch(url, init),
    );
    const res = await jsonRequest(app, "GET", "/admin/models", undefined, owner.apiKey);
    expect(res.data.models).toEqual(["claude-sonnet-5", OWN_MODEL]);
    expect(res.data.own_models).toEqual([OWN_MODEL]);
    expect(res.data.source).toBe("promptowl");
  });
});

describe("own-provider keys from Settings (byok)", () => {
  afterEach(() => vi.restoreAllMocks());

  function promptowl(answer: (body: any) => Response) {
    const realFetch = globalThis.fetch;
    const sent: any[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init?: any) => {
      if (!String(url).endsWith("/api/license/own-models")) return realFetch(url, init);
      const body = JSON.parse(init.body);
      sent.push(body);
      return answer(body);
    });
    return sent;
  }

  it("forwards each key to PromptOwl and never stores it on this server", async () => {
    const { app, owner } = await boot({ features: ["byok"], gateway: GATEWAY, ownGateway: OWN_GW });
    const sent = promptowl(() => new Response(JSON.stringify({ providers: {} })));
    const res = await jsonRequest(
      app, "PATCH", "/admin/settings", { provider_keys: { openai: " sk-openai-1234 ", gemini: null } }, owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(sent.map((b) => [b.provider, b.api_key])).toEqual([["openai", "sk-openai-1234"], ["gemini", null]]);
    expect(JSON.stringify(res.data)).not.toContain("sk-openai-1234");
    expect(res.data.settings.own_providers).toEqual(OWN_GW.providers);
    const { getDb } = await import("../src/db/client.js");
    const rows = JSON.stringify(await getDb().all("SELECT * FROM server_settings"));
    expect(rows).not.toContain("sk-openai-1234");
  });

  it("a key the provider refuses comes back as that provider's field error", async () => {
    const { app, owner } = await boot({ features: ["byok"], gateway: GATEWAY });
    promptowl(() => new Response(JSON.stringify({ error: "Incorrect API key" }), { status: 400 }));
    const res = await jsonRequest(app, "PATCH", "/admin/settings", { provider_keys: { openai: "sk-bad" } }, owner.apiKey);
    expect(res.status).toBe(400);
    expect(res.data.fieldErrors).toEqual({ "provider_keys.openai": "Incorrect API key" });
  });

  it("refuses without byok, and rejects unknown providers before calling PromptOwl", async () => {
    const { app, owner } = await boot({ gateway: GATEWAY });
    const sent = promptowl(() => new Response("{}"));
    const noByok = await jsonRequest(app, "PATCH", "/admin/settings", { provider_keys: { openai: "sk-x" } }, owner.apiKey);
    expect(noByok.status).toBe(403);
    expect(noByok.data.code).toBe("byok_required");

    const byok = await boot({ features: ["byok"], gateway: GATEWAY });
    const unknown = await jsonRequest(byok.app, "PATCH", "/admin/settings", { provider_keys: { mistral: "k" } }, byok.owner.apiKey);
    expect(unknown.status).toBe(400);
    expect(unknown.data.fieldErrors["provider_keys.mistral"]).toMatch(/Unknown/);
    expect(sent).toEqual([]);
  });

  it("Settings says which key calls fall back to", async () => {
    const { app, owner } = await boot({ features: ["byok"], gateway: GATEWAY });
    const res = await jsonRequest(app, "GET", "/admin/settings", undefined, owner.apiKey);
    expect(res.data.model_source).toBe("promptowl");
    expect(res.data.own_providers).toEqual({});
  });
});
