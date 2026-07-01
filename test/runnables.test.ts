/**
 * Runnable node types: "agent" and "skill" carry a `schedule` field
 * (free-form cron/interval string, opaque to the server) that an external
 * orchestrator reads via GET /nests/:id/runnables to know what to run and
 * when. schedule is rejected on every other node type.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Automations" }, alice.apiKey);
  nestId = nest.data.nest.id;
});

afterAll(() => env.cleanup());

describe("agent/skill nodes with schedule", () => {
  it("creates an agent node carrying a schedule", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "Nightly Digest Agent",
        content: "# Agent\n\nSummarize the day.",
        type: "agent",
        schedule: "0 6 * * *",
      },
      alice.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.node.type).toBe("agent");
    expect(res.data.node.schedule).toBe("0 6 * * *");
  });

  it("creates a skill node with a schedule", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "Weekly Rollup Skill",
        content: "# Skill\n\nRoll up the week.",
        type: "skill",
        schedule: "@weekly",
      },
      alice.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.node.schedule).toBe("@weekly");
  });

  it("rejects schedule on non-runnable types", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Plain Doc", content: "# Doc", schedule: "@daily" },
      alice.apiKey,
    );
    expect(res.status).toBe(400);
  });

  it("updates and clears schedule via PATCH", async () => {
    const patch = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/nightly-digest-agent`,
      { schedule: "0 7 * * *" },
      alice.apiKey,
    );
    expect(patch.status).toBe(200);
    expect(patch.data.node.schedule).toBe("0 7 * * *");

    const clear = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/nightly-digest-agent`,
      { schedule: "" },
      alice.apiKey,
    );
    expect(clear.status).toBe(200);
    expect(clear.data.node.schedule).toBeUndefined();
  });

  it("rejects PATCH schedule on a plain document", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Another Doc", content: "# D" },
      alice.apiKey,
    );
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/another-doc`,
      { schedule: "@hourly" },
      alice.apiKey,
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /nests/:id/runnables — orchestrator fetch", () => {
  it("returns agent/skill nodes with schedule and content, nothing else", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/runnables`,
      undefined,
      alice.apiKey,
    );
    expect(res.status).toBe(200);
    const titles = res.data.runnables.map((r: any) => r.title);
    expect(titles).toContain("Nightly Digest Agent");
    expect(titles).toContain("Weekly Rollup Skill");
    expect(titles).not.toContain("Plain Doc");

    const skill = res.data.runnables.find((r: any) => r.type === "skill");
    expect(skill.schedule).toBe("@weekly");
    expect(skill.content).toContain("Roll up the week.");
    // The agent's schedule was cleared above — still listed, schedule null.
    const agent = res.data.runnables.find((r: any) => r.type === "agent");
    expect(agent.schedule).toBeNull();
  });
});
