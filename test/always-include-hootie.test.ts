/**
 * Always-include documents reach Hootie (CU-wdqcq05rn0): the nest's standing
 * instructions sit in the system prompt BEFORE the retrieved documents,
 * whatever the question retrieved — and only the approved text the caller
 * may read.
 *
 * The model call is the one thing mocked (as in hootie-chat.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  describeModelError as realDescribeModelError,
  ModelRefusedError as RealModelRefusedError,
  ToolsRejectedError as RealToolsRejectedError,
} from "../src/hootie/model.js";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";

let lastSystem: string | null = null;

const TEST_GATEWAY = { baseUrl: "http://127.0.0.1:9", key: "sk-po-test", defaultModel: "default-claude/claude-sonnet-5" };

beforeAll(() => {
  vi.doMock("../src/hootie/model.js", () => ({
    streamAnswer: async function* (params: { system: string }) {
      lastSystem = params.system;
      yield "Hoot.";
    },
    streamRound: async function* (params: { system: string }) {
      lastSystem = params.system;
      yield "Hoot.";
      return { toolCalls: [], assistant: [{ type: "text", text: "Hoot." }] };
    },
    describeModelError: realDescribeModelError,
    ModelRefusedError: RealModelRefusedError,
    ToolsRejectedError: RealToolsRejectedError,
  }));
});
afterAll(() => {
  vi.doUnmock("../src/hootie/model.js");
});

describe("Hootie gets the standing instructions", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; email: string; userId: string };
  let reader: { apiKey: string; email: string; userId: string };
  let guest: { apiKey: string; email: string; userId: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    process.env.HOOTIE_ENABLED = "true";
    app = await createTestApp("key", { features: ["byok"], gateway: TEST_GATEWAY });
    owner = await registerUser(app, "owner@acme.com", "Owner");
    await resetAuthRateLimit();
    reader = await registerUser(app, "reader@acme.com", "Reader");
    guest = await registerUser(app, "guest@acme.com", "Guest");
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Hoot Rules" }, owner.apiKey);
    nestId = data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: reader.email, permission: "read" },
      owner.apiKey,
    );
    // Ungoverned: the owner's writes publish (and are approved) at once.
    for (const [title, content, tags] of [
      ["Tone Rules", "TONE-RULE-TEXT: be brief and kind.", ["always-include"]],
      ["Board Rules", "BOARD-RULE-TEXT: confidential.", ["always-include"]],
      ["Weather Notes", "It rains a lot in spring.", ["weather"]],
    ] as const) {
      const r = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title, content, tags: [...tags] },
        owner.apiKey,
      );
      expect(r.status).toBe(201);
    }
    // The guest holds a share on the tone rules and nothing else.
    const grant = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      { target_type: "document", target: "nodes/tone-rules", email: guest.email, role: "read" },
      owner.apiKey,
    );
    expect(grant.status).toBe(201);
  });

  async function systemFor(apiKey: string): Promise<string> {
    lastSystem = null;
    const res = await app.request(`/nests/${nestId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ message: "does it rain in spring?" }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(lastSystem).not.toBeNull();
    return lastSystem!;
  }

  afterAll(async () => {
    delete process.env.HOOTIE_ENABLED;
    await env.cleanup();
  });

  it("puts a standing-instructions block before the retrieved documents", async () => {
    const system = await systemFor(reader.apiKey);
    expect(system).toContain("Standing instructions for this nest");
    expect(system).toContain("TONE-RULE-TEXT");
    expect(system).toContain('<standing_document id="nodes/tone-rules"');
    expect(system.indexOf("TONE-RULE-TEXT")).toBeLessThan(system.indexOf("<documents>"));
    expect(system).toContain("BOARD-RULE-TEXT");
  });

  it("gives a reader with a document share only the rules they can read", async () => {
    const system = await systemFor(guest.apiKey);
    expect(system).toContain("TONE-RULE-TEXT");
    expect(system).not.toContain("BOARD-RULE-TEXT");
    expect(system).not.toContain("nodes/board-rules");
  });
});
