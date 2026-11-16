/**
 * Always-include documents reach the metacognition agent (CU-wdqcq05rn0): its
 * system prompt carries the nest's standing instructions, fenced and labelled
 * as approved documents — not as its own instructions.
 *
 * The model call is the one thing mocked (as in metacognition.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

let requests: any[] = [];

beforeAll(() => {
  vi.doMock("../src/metacognition/model.js", async () => {
    const actual = await vi.importActual<typeof import("../src/metacognition/model.js")>(
      "../src/metacognition/model.js",
    );
    return {
      ...actual,
      createTurn: async (params: any) => {
        requests.push(JSON.parse(JSON.stringify(params.request)));
        return {
          content: [{ type: "text", text: "Nothing to do." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    };
  });
});
afterAll(() => {
  vi.doUnmock("../src/metacognition/model.js");
});

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; email: string; userId: string };
let nestId: string;

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  process.env.FEATURE_METACOGNITION = "true";
  process.env.METACOGNITION_STARTS_PER_HOUR = "1000";
  env = setupTestEnv();
  app = await createTestApp("key", {
    gateway: { baseUrl: "https://gateway.promptowl.test", key: "po-key", defaultModel: "default-claude/claude-sonnet-5" },
  });
  owner = await registerUser(app, "owner@acme.com", "Owner");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Meta Rules" }, owner.apiKey);
  nestId = nest.data.nest.id;
  for (const body of [
    { title: "Archivist", content: "Keep things current.", type: "agent" },
    { title: "Style Rules", content: "STYLE-RULE-TEXT: dates are ISO.", tags: ["always-include"] },
  ]) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, body, owner.apiKey);
    expect(r.status).toBe(201);
  }
  const cfg = await jsonRequest(
    app,
    "PUT",
    `/nests/${nestId}/metacognition/nodes/archivist`,
    {
      persona: { name: "Archivist", avatar: "🦉" },
      scope: { read: [], propose: [] },
      caps: { max_steps: 2, max_tokens: 50_000, max_seconds: 30, max_proposals: 1 },
      feeds: [],
      mcp_servers: [],
    },
    owner.apiKey,
  );
  expect(cfg.status, JSON.stringify(cfg.data)).toBe(200);
});

afterAll(async () => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  delete process.env.FEATURE_METACOGNITION;
  await env.cleanup();
});

describe("metacognition gets the standing instructions", () => {
  it("its system prompt carries the always-include documents, fenced", async () => {
    requests = [];
    const start = await jsonRequest(app, "POST", `/nests/${nestId}/metacognition/nodes/archivist/run`, {}, owner.apiKey);
    expect(start.status, JSON.stringify(start.data)).toBe(202);
    for (let i = 0; i < 200 && requests.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(requests.length).toBeGreaterThan(0);
    const system = String(requests[0].system);
    expect(system).toContain("Standing instructions for this nest");
    expect(system).toContain("STYLE-RULE-TEXT");
    expect(system).toContain('<standing_document id="nodes/style-rules"');
  });
});
