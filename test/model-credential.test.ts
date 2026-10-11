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
  delete process.env.ANTHROPIC_BASE_URL;
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

  it("with byok, a nest key beats the gateway; a bare server Anthropic key (no gateway URL) is not read", async () => {
    const { resolveModelCredential } = await boot({ features: ["byok"], gateway: GATEWAY });
    // Bare own Anthropic keys live in PromptOwl's gateway now (ownModelRoute).
    process.env.ANTHROPIC_API_KEY = "sk-ant-own";
    expect(resolveModelCredential()?.source).toBe("promptowl");
    expect(
      resolveModelCredential({ ANTHROPIC_API_KEY: "sk-ant-nest", ANTHROPIC_BASE_URL: "http://gw:4000" }),
    ).toEqual({ apiKey: "sk-ant-nest", baseUrl: "http://gw:4000", source: "own", defaultModel: null });
  });

  it("a nest URL without a nest key never receives a key", async () => {
    const { resolveModelCredential } = await boot({ features: ["byok"], gateway: GATEWAY });
    expect(resolveModelCredential({ ANTHROPIC_BASE_URL: "https://evil.example" })).toEqual({
      apiKey: GATEWAY.key, baseUrl: GATEWAY.baseUrl, source: "promptowl", defaultModel: GATEWAY.defaultModel,
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
      // Read before the prefix comes off, so the picker can group by provider.
      providers: { "claude-sonnet-5": "claude", "gpt-5.5": "openai" },
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
  it("Settings refuses setting a provider key (403 byok_required) but allows clearing", async () => {
    const { app, owner } = await boot({ gateway: GATEWAY });
    const res = await jsonRequest(app, "PATCH", "/admin/settings", { provider_keys: { claude: "sk-ant-x" } }, owner.apiKey);
    expect(res.status).toBe(403);
    expect(res.data.code).toBe("byok_required");
    const clear = await jsonRequest(app, "PATCH", "/admin/settings", { provider_keys: { claude: null } }, owner.apiKey);
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

  async function routeFor(opts: Parameters<typeof boot>[0]) {
    await boot(opts);
    const { ownModelRoute } = await import("../src/shared/model-credential.js");
    return ownModelRoute;
  }
  const OWN_CRED = { apiKey: OWN_GW.key, baseUrl: OWN_GW.baseUrl, source: "own", defaultModel: null };

  it("any model of a provider with an own key goes on that key, renamed onto the own group", async () => {
    const route = await routeFor({ features: ["byok"], gateway: GATEWAY, ownGateway: OWN_GW });
    // Picked from PromptOwl's catalog: not one of the own catalog names, same provider.
    expect(route("default-openai/gpt-4o")).toEqual({ credential: OWN_CRED, model: "community-lic1-openai/gpt-4o" });
    // Picked as a "(your key)" name: already on the own group.
    expect(route(OWN_MODEL)).toEqual({ credential: OWN_CRED, model: OWN_MODEL });
  });

  it("a PromptOwl Claude model runs on the own Anthropic key (the server key moved to the gateway)", async () => {
    const route = await routeFor({
      features: ["byok"],
      gateway: GATEWAY,
      ownGateway: { ...OWN_GW, models: [...OWN_GW.models, "community-lic1-claude/claude-sonnet-5"] },
    });
    expect(route("default-claude/claude-sonnet-5")).toEqual({
      credential: OWN_CRED,
      model: "community-lic1-claude/claude-sonnet-5",
    });
  });

  it("an own model name with no group is skipped, not cut into a wrong one", async () => {
    const route = await routeFor({
      features: ["byok"],
      gateway: GATEWAY,
      // Cut by one character, "zz-openaiX" would read as group "zz-openai".
      ownGateway: { ...OWN_GW, models: ["zz-openaiX", OWN_MODEL] },
    });
    expect(route("default-openai/gpt-4o")?.model).toBe("community-lic1-openai/gpt-4o");
  });

  it("everything else keeps today's key", async () => {
    const route = await routeFor({ features: ["byok"], gateway: GATEWAY, ownGateway: OWN_GW });
    expect(route("default-grok/grok-4")).toBeNull(); // no own Grok key
    expect(route("default-claude/claude-sonnet-5")).toBeNull(); // no own Claude key on this licence
    expect(route("claude-sonnet-5")).toBeNull(); // a bare name (direct Anthropic key)
    expect(await routeFor({ gateway: GATEWAY, ownGateway: OWN_GW }).then((r) => r("default-openai/gpt-4o"))).toBeNull(); // no byok
    expect(await routeFor({ features: ["byok"], gateway: GATEWAY }).then((r) => r("default-openai/gpt-4o"))).toBeNull(); // no own key
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
    expect(res.data.providers).toEqual({ "claude-sonnet-5": "claude", [OWN_MODEL]: "openai" });
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

  it("saves the other settings first; a later refusal names that provider and keeps earlier keys", async () => {
    const { app, owner } = await boot({ features: ["byok"], gateway: GATEWAY });
    const sent = promptowl((b) =>
      b.provider === "gemini"
        ? new Response(JSON.stringify({ error: "API key not valid" }), { status: 400 })
        : new Response(JSON.stringify({ providers: {} })),
    );
    const res = await jsonRequest(
      app, "PATCH", "/admin/settings",
      { community_name: "Acme Nest", provider_keys: { openai: "sk-good", gemini: "AIza-bad" } },
      owner.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.fieldErrors).toEqual({ "provider_keys.gemini": "API key not valid" });
    expect(sent.map((b) => b.provider)).toEqual(["openai", "gemini"]);
    // The rest of the PATCH was saved before any key went out.
    expect(res.data.settings.community_name).toBe("Acme Nest");
  });

  it("a key with spaces or over 512 characters is refused before anything is sent", async () => {
    const { app, owner } = await boot({ features: ["byok"], gateway: GATEWAY });
    const sent = promptowl(() => new Response(JSON.stringify({ providers: {} })));
    const res = await jsonRequest(
      app, "PATCH", "/admin/settings", { provider_keys: { openai: "sk two words", groq: "g".repeat(513) } }, owner.apiKey,
    );
    expect(res.status).toBe(400);
    expect(Object.keys(res.data.fieldErrors).sort()).toEqual(["provider_keys.groq", "provider_keys.openai"]);
    expect(sent).toEqual([]);
  });

  it("without byok, clearing a key sends nothing to PromptOwl", async () => {
    const { app, owner } = await boot({ gateway: GATEWAY });
    const sent = promptowl(() => new Response(JSON.stringify({ providers: {} })));
    const res = await jsonRequest(app, "PATCH", "/admin/settings", { provider_keys: { openai: null } }, owner.apiKey);
    expect(res.status).toBe(200);
    expect(sent).toEqual([]);
  });

  it("a sign-in redirect or a 200 page that isn't the route is never taken as saved", async () => {
    const { app, owner } = await boot({ features: ["byok"], gateway: GATEWAY });
    const sent = promptowl(() => new Response(null, { status: 307, headers: { location: "/login" } }));
    const redirected = await jsonRequest(app, "PATCH", "/admin/settings", { provider_keys: { openai: "sk-x" } }, owner.apiKey);
    expect(redirected.status).toBe(400);
    expect(redirected.data.fieldErrors["provider_keys.openai"]).toMatch(/didn't accept/);
    expect(sent).toHaveLength(1);

    vi.restoreAllMocks();
    promptowl(() => new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const page = await jsonRequest(app, "PATCH", "/admin/settings", { provider_keys: { openai: "sk-x" } }, owner.apiKey);
    expect(page.status).toBe(400);
    expect(page.data.fieldErrors["provider_keys.openai"]).toMatch(/didn't accept/);
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

  it("Settings lists no own providers until a key is added, and an empty model gateway", async () => {
    const { app, owner } = await boot({ features: ["byok"], gateway: GATEWAY });
    const res = await jsonRequest(app, "GET", "/admin/settings", undefined, owner.apiKey);
    expect(res.data.own_providers).toEqual({});
    expect(res.data.anthropic_base_url).toBe("");
    expect(res.data.anthropic_api_key_masked).toBeNull();
    expect(res.data.model_source).toBe("promptowl");
  });
});

describe("a stored server Anthropic key moves to the model gateway at boot", () => {
  afterEach(() => vi.restoreAllMocks());

  async function stored() {
    const { getDb } = await import("../src/db/client.js");
    return getDb().get("SELECT value FROM server_settings WHERE key = ?", ["ANTHROPIC_API_KEY"]);
  }

  async function bootWithStoredKey(opts: Parameters<typeof boot>[0], answer: Response) {
    await boot(opts);
    const { persistSetting } = await import("../src/db/settings.js");
    await persistSetting("ANTHROPIC_API_KEY", "sk-ant-stored-1234");
    process.env.ANTHROPIC_API_KEY = "sk-ant-stored-1234";
    const sent: any[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init?: any) => {
      if (!String(url).endsWith("/api/license/own-models")) return realFetch(url, init);
      sent.push(JSON.parse(init.body));
      return answer;
    });
    const { moveStoredAnthropicKey } = await import("../src/shared/model-credential.js");
    await moveStoredAnthropicKey();
    return sent;
  }

  it("hands it over as the claude provider, then drops it here", async () => {
    const sent = await bootWithStoredKey({ features: ["byok"], gateway: GATEWAY }, new Response(JSON.stringify({ providers: {} })));
    expect(sent.map((b) => [b.provider, b.api_key])).toEqual([["claude", "sk-ant-stored-1234"]]);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    // A null row records "cleared", so a deploy-env copy doesn't come back on restart.
    expect((await stored())?.value ?? null).toBeNull();
  });

  it("never hands over a key paired with the server's own gateway URL", async () => {
    process.env.ANTHROPIC_BASE_URL = "http://litellm:4000";
    const sent = await bootWithStoredKey({ features: ["byok"], gateway: GATEWAY }, new Response(JSON.stringify({ providers: {} })));
    expect(sent).toEqual([]);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-stored-1234");
    expect((await stored())?.value).toBeTruthy();
  });

  it("keeps it when PromptOwl refuses, or when the licence has no byok", async () => {
    await bootWithStoredKey({ features: ["byok"], gateway: GATEWAY }, new Response(JSON.stringify({ error: "invalid x-api-key" }), { status: 400 }));
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-stored-1234");
    expect((await stored())?.value).toBeTruthy();

    const sent = await bootWithStoredKey({ gateway: GATEWAY }, new Response(JSON.stringify({ providers: {} })));
    expect(sent).toEqual([]);
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-stored-1234");
  });
});

// Enterprise self-hosted: route Hootie and agent runs through the customer's
// own LiteLLM (Bedrock, Azure, Ollama behind it). Retired by mistake in
// 9318f956; restored, byok-gated, key and URL as a pair.
describe("the server's own model gateway (byok)", () => {
  const LITELLM = "http://litellm:4000";
  afterEach(() => vi.restoreAllMocks());

  /** Answer the gateway's /v1/models (the key check and the picker); pass the rest through. */
  function gatewayAnswers(status: number, ids: string[] = []) {
    const realFetch = globalThis.fetch;
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init?: any) => {
      const u = String(url instanceof Request ? url.url : url);
      if (!u.startsWith(`${LITELLM}/v1/models`)) return realFetch(url, init);
      const h = new Headers(url instanceof Request ? url.headers : init?.headers);
      seen.push({ url: u, auth: h.get("x-api-key") ?? h.get("authorization") });
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
    return seen;
  }

  it("with byok, URL + key route every call there: after a nest key, before PromptOwl", async () => {
    const { resolveModelCredential } = await boot({ features: ["byok"], gateway: GATEWAY, ownGateway: OWN_GW });
    process.env.ANTHROPIC_BASE_URL = LITELLM;
    process.env.ANTHROPIC_API_KEY = "sk-litellm-virtual";
    const server = { apiKey: "sk-litellm-virtual", baseUrl: LITELLM, source: "own", defaultModel: null };
    expect(resolveModelCredential()).toEqual(server);
    expect(resolveModelCredential({ ANTHROPIC_API_KEY: "sk-ant-nest" })?.apiKey).toBe("sk-ant-nest");
    // A nest URL alone never receives the server's key.
    expect(resolveModelCredential({ ANTHROPIC_BASE_URL: "https://evil.example" })).toEqual(server);
  });

  it("is off without byok, or with only one half set", async () => {
    const plain = await boot({ gateway: GATEWAY });
    process.env.ANTHROPIC_BASE_URL = LITELLM;
    process.env.ANTHROPIC_API_KEY = "sk-litellm-virtual";
    expect(plain.resolveModelCredential()?.source).toBe("promptowl");
    env?.cleanup();
    const byok = await boot({ features: ["byok"], gateway: GATEWAY });
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_BASE_URL = LITELLM;
    expect(byok.resolveModelCredential()?.source).toBe("promptowl");
  });

  it("agent runs get the gateway through the run bundle", async () => {
    const { app, owner, envValues } = await boot({ features: ["byok"], gateway: GATEWAY });
    process.env.ANTHROPIC_BASE_URL = LITELLM;
    process.env.ANTHROPIC_API_KEY = "sk-litellm-virtual";
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Runs" }, owner.apiKey);
    const bundle = await envValues(nest.data.nest.id);
    expect(bundle.ANTHROPIC_BASE_URL).toBe(LITELLM);
    expect(bundle.ANTHROPIC_API_KEY).toBe("sk-litellm-virtual");
  });

  it("Settings saves URL + key after the gateway accepts the key, and never returns the key", async () => {
    const { app, owner } = await boot({ features: ["byok"], gateway: GATEWAY });
    const seen = gatewayAnswers(200);
    const res = await jsonRequest(
      app, "PATCH", "/admin/settings",
      { anthropic_base_url: `${LITELLM}/`, anthropic_api_key: "sk-litellm-virtual" }, owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(seen.length).toBe(1);
    expect(res.data.settings.anthropic_base_url).toBe(LITELLM);
    expect(res.data.settings.anthropic_api_key_masked).toBe("••••tual");
    expect(res.data.settings.model_source).toBe("own");
    expect(JSON.stringify(res.data)).not.toContain("sk-litellm-virtual");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-litellm-virtual");
  });

  it("a key the gateway rejects, a key with no URL, or a bad URL is a field error", async () => {
    const { app, owner } = await boot({ features: ["byok"], gateway: GATEWAY });
    gatewayAnswers(401);
    const rejected = await jsonRequest(
      app, "PATCH", "/admin/settings", { anthropic_base_url: LITELLM, anthropic_api_key: "sk-bad" }, owner.apiKey,
    );
    expect(rejected.status).toBe(400);
    expect(rejected.data.fieldErrors.anthropic_api_key).toMatch(/gateway rejected/);
    const noUrl = await jsonRequest(app, "PATCH", "/admin/settings", { anthropic_api_key: "sk-x" }, owner.apiKey);
    expect(noUrl.data.fieldErrors.anthropic_api_key).toMatch(/gateway URL/);
    const badUrl = await jsonRequest(app, "PATCH", "/admin/settings", { anthropic_base_url: "ftp://x" }, owner.apiKey);
    expect(badUrl.data.fieldErrors.anthropic_base_url).toMatch(/http/);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("clearing the URL clears its key too, so a boot can't hand it to PromptOwl", async () => {
    const { app, owner } = await boot({ features: ["byok"], gateway: GATEWAY });
    gatewayAnswers(200);
    await jsonRequest(
      app, "PATCH", "/admin/settings", { anthropic_base_url: LITELLM, anthropic_api_key: "sk-litellm-virtual" }, owner.apiKey,
    );
    const res = await jsonRequest(app, "PATCH", "/admin/settings", { anthropic_base_url: "" }, owner.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.settings.anthropic_api_key_masked).toBeNull();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(res.data.settings.model_source).toBe("promptowl");
  });

  it("without byok, setting either half is refused (403); clearing is allowed", async () => {
    const { app, owner } = await boot({ gateway: GATEWAY });
    for (const body of [{ anthropic_base_url: LITELLM }, { anthropic_api_key: "sk-x" }]) {
      const res = await jsonRequest(app, "PATCH", "/admin/settings", body, owner.apiKey);
      expect(res.status).toBe(403);
      expect(res.data.code).toBe("byok_required");
    }
    const clear = await jsonRequest(app, "PATCH", "/admin/settings", { anthropic_base_url: "" }, owner.apiKey);
    expect(clear.status).toBe(200);
  });

  it("the Hootie picker lists the gateway's models as named, without PromptOwl's own-provider models", async () => {
    const { app, owner } = await boot({ features: ["byok"], gateway: GATEWAY, ownGateway: OWN_GW });
    process.env.ANTHROPIC_BASE_URL = LITELLM;
    process.env.ANTHROPIC_API_KEY = "sk-litellm-virtual";
    gatewayAnswers(200, ["bedrock/anthropic.claude-sonnet-5", "ollama/llama3.2"]);
    const res = await jsonRequest(app, "GET", "/admin/models", undefined, owner.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.source).toBe("own");
    expect(res.data.models).toEqual(["bedrock/anthropic.claude-sonnet-5", "ollama/llama3.2"]);
    expect(res.data).not.toHaveProperty("own_models");
  });
});
