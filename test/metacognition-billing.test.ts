/**
 * Metacognition agents (CU-wdqcq041jm) — who pays for a run on an Enterprise
 * licence (`byok`) that ALSO has PromptOwl's gateway.
 *
 * With no own key stored, the run must go through the gateway and be recorded
 * as PromptOwl credits. Found in local verification: the run resolved its key
 * from the run-bundle env, which already carries the RESOLVED credential under
 * ANTHROPIC_API_KEY — so with byok on, the gateway key was re-read as an own
 * key, the model name lost its gateway prefix, and the run was recorded as
 * not billed by PromptOwl.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let calls: Array<{ source: string; apiKey: string; model: string }> = [];

beforeAll(() => {
  vi.doMock("../src/metacognition/model.js", async () => {
    const actual = await vi.importActual<typeof import("../src/metacognition/model.js")>("../src/metacognition/model.js");
    return {
      ...actual,
      createTurn: async (params: any) => {
        calls.push({ source: params.credential.source, apiKey: params.credential.apiKey, model: params.request.model });
        return { content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } };
      },
    };
  });
});
afterAll(() => vi.doUnmock("../src/metacognition/model.js"));

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; email: string };
let nestId: string;

async function runOnce(): Promise<any> {
  const start = await jsonRequest(app, "POST", `/nests/${nestId}/metacognition/nodes/scout/run`, {}, owner.apiKey);
  expect(start.status).toBe(202);
  for (let i = 0; i < 200; i++) {
    const r = await jsonRequest(app, "GET", `/runs/${start.data.run_id}`, undefined, owner.apiKey);
    if (r.data.run.status !== "running") return r.data.run;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("run never finished");
}

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  delete process.env.ANTHROPIC_API_KEY;
  env = setupTestEnv();
  app = await createTestApp("key", {
    features: ["byok"],
    gateway: { baseUrl: "https://gateway.promptowl.test", key: "po-gateway-key", defaultModel: "default-claude/claude-sonnet-5" },
  });
  owner = await registerUser(app, "owner@acme.com", "Owner");
  nestId = (await jsonRequest(app, "POST", "/nests", { name: "Billing" }, owner.apiKey)).data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Scout", type: "agent", content: "Look around." }, owner.apiKey);
  const put = await jsonRequest(app, "PUT", `/nests/${nestId}/metacognition/nodes/scout`, { persona: { name: "Scout" } }, owner.apiKey);
  expect(put.status).toBe(200);
});

afterAll(async () => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  delete process.env.FEATURE_METACOGNITION;
  await env.cleanup();
});

describe("billing on a byok licence with a gateway", () => {
  it("with no own key stored, uses the gateway and records PromptOwl credits", async () => {
    calls = [];
    const run = await runOnce();
    expect(calls[0]).toEqual({ source: "promptowl", apiKey: "po-gateway-key", model: "default-claude/claude-sonnet-5" });
    expect(run.trace.billing).toBe("promptowl_credits");
  });

  it("with the nest's own key stored, uses it and records own_key", async () => {
    await jsonRequest(app, "PUT", `/nests/${nestId}/env`, { key: "ANTHROPIC_API_KEY", value: "sk-nest-own" }, owner.apiKey);
    calls = [];
    const run = await runOnce();
    expect(calls[0].source).toBe("own");
    expect(calls[0].apiKey).toBe("sk-nest-own");
    expect(run.trace.billing).toBe("own_key");
  });
});
