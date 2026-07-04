/**
 * Workflow-plane schedules: CRUD on /nests/:id/schedules plus the scheduler
 * tick that turns due schedules into run rows (which a polling runner then
 * executes — the server never runs anything itself).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  process.env.FEATURE_WORKFLOW_PLANE = "true";
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Sched" }, alice.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(
    app, "POST", `/nests/${nestId}/nodes`,
    { title: "Digest Agent", content: "# Digest instructions", type: "agent" },
    alice.apiKey,
  );
  await jsonRequest(
    app, "POST", `/nests/${nestId}/nodes`,
    { title: "Plain Doc", content: "# Not runnable" },
    alice.apiKey,
  );
});

afterAll(() => {
  delete process.env.FEATURE_WORKFLOW_PLANE;
  env.cleanup();
});

describe("schedule CRUD", () => {
  let scheduleId: string;

  it("creates a schedule for an agent node", async () => {
    const res = await jsonRequest(
      app, "POST", `/nests/${nestId}/schedules`,
      { agent_node: "nodes/digest-agent", every_minutes: 60 },
      alice.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.schedule.enabled).toBe(true);
    expect(res.data.schedule.every_minutes).toBe(60);
    scheduleId = res.data.schedule.id;
  });

  it("refuses a second schedule for the same agent (409)", async () => {
    const res = await jsonRequest(
      app, "POST", `/nests/${nestId}/schedules`,
      { agent_node: "nodes/digest-agent", every_minutes: 15 },
      alice.apiKey,
    );
    expect(res.status).toBe(409);
  });

  it("refuses non-runnable nodes (400) and unknown nodes (404)", async () => {
    const doc = await jsonRequest(
      app, "POST", `/nests/${nestId}/schedules`,
      { agent_node: "nodes/plain-doc", every_minutes: 60 },
      alice.apiKey,
    );
    expect(doc.status).toBe(400);
    const ghost = await jsonRequest(
      app, "POST", `/nests/${nestId}/schedules`,
      { agent_node: "nodes/ghost", every_minutes: 60 },
      alice.apiKey,
    );
    expect(ghost.status).toBe(404);
  });

  it("bounds every_minutes (400 below 5 or non-integer)", async () => {
    for (const bad of [1, 0, -5, 2.5, "soon"]) {
      const res = await jsonRequest(
        app, "POST", `/nests/${nestId}/schedules`,
        { agent_node: "nodes/digest-agent", every_minutes: bad },
        alice.apiKey,
      );
      expect(res.status, `every_minutes=${bad}`).toBeGreaterThanOrEqual(400);
    }
  });

  it("lists, patches, and disables", async () => {
    const list = await jsonRequest(
      app, "GET", `/nests/${nestId}/schedules`, undefined, alice.apiKey,
    );
    expect(list.status).toBe(200);
    expect(list.data.count).toBe(1);
    expect(list.data.schedules[0].next_due_at).toBeTruthy();

    const patched = await jsonRequest(
      app, "PATCH", `/nests/${nestId}/schedules/${scheduleId}`,
      { every_minutes: 15, enabled: false }, alice.apiKey,
    );
    expect(patched.status).toBe(200);
    expect(patched.data.schedule.every_minutes).toBe(15);
    expect(patched.data.schedule.enabled).toBe(false);
    expect(patched.data.schedule.next_due_at).toBeNull();
  });
});

describe("scheduler tick", () => {
  it("fires a due schedule into a run row, then respects the interval", async () => {
    const { schedulerTick } = await import("../src/workflow/scheduler.js");

    // Re-enable the schedule created above.
    const list = await jsonRequest(
      app, "GET", `/nests/${nestId}/schedules`, undefined, alice.apiKey,
    );
    const sched = list.data.schedules[0];
    await jsonRequest(
      app, "PATCH", `/nests/${nestId}/schedules/${sched.id}`,
      { enabled: true }, alice.apiKey,
    );

    const t0 = Date.now();
    const first = await schedulerTick(t0);
    expect(first.length).toBe(1);

    // Same instant again: not due (interval hasn't elapsed).
    const again = await schedulerTick(t0 + 60_000);
    expect(again.length).toBe(0);

    // The created run is visible, running, and attributed to the schedule.
    const runs = await jsonRequest(
      app, "GET", `/nests/${nestId}/runs`, undefined, alice.apiKey,
    );
    expect(runs.status).toBe(200);
    const run = runs.data.runs.find((r: any) => r.id === first[0]);
    expect(run).toBeTruthy();
    expect(run.agent_node).toBe("nodes/digest-agent");
    expect(run.status).toBe("running");
    expect(run.triggered_by).toBe(`schedule:${alice.email}`);

    // After the interval elapses it fires again.
    const later = await schedulerTick(t0 + 16 * 60_000);
    expect(later.length).toBe(1);
  });
});
