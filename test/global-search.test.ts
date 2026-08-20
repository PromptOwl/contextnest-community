/**
 * GET /search — full-text search across every nest the caller can see. The
 * security-critical property is the negative: a nest you have no access to
 * never contributes a hit, however well it matches.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let outsider: { apiKey: string; userId: string; email: string };
let nestA: string;
let nestB: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  outsider = await registerUser(app, "outsider@acme.com", "Outsider");

  const a = await jsonRequest(app, "POST", "/nests", { name: "Nest A" }, owner.apiKey);
  nestA = a.data.nest.id;
  const b = await jsonRequest(app, "POST", "/nests", { name: "Nest B" }, owner.apiKey);
  nestB = b.data.nest.id;

  await jsonRequest(
    app,
    "POST",
    `/nests/${nestA}/nodes`,
    { title: "Onboarding Runbook", content: "# how to onboard a widget" },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestB}/nodes`,
    { title: "Widget Pricing", content: "# pricing for the widget" },
    owner.apiKey,
  );
});

afterAll(() => env.cleanup());

describe("GET /search", () => {
  it("returns hits from every nest the caller can see, stamped with the nest", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      "/search?q=widget",
      undefined,
      owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.count).toBe(2);
    expect(new Set(data.nodes.map((n: any) => n.nest_id))).toEqual(
      new Set([nestA, nestB]),
    );
    expect(new Set(data.nodes.map((n: any) => n.nest_name))).toEqual(
      new Set(["Nest A", "Nest B"]),
    );
  });

  it("snippets a deep body match around the term, not the head of the body", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestA}/nodes`,
      { title: "Long Note", content: `${"filler ".repeat(100)}gizmo tail` },
      owner.apiKey,
    );
    const { data } = await jsonRequest(
      app,
      "GET",
      "/search?q=gizmo",
      undefined,
      owner.apiKey,
    );
    expect(data.count).toBe(1);
    expect(data.nodes[0].snippet).toContain("gizmo");
    expect(data.nodes[0].snippet.length).toBeLessThanOrEqual(201);
  });

  it("matches title, body and tags with every term required", async () => {
    const { data } = await jsonRequest(
      app,
      "GET",
      "/search?q=widget%20pricing",
      undefined,
      owner.apiKey,
    );
    expect(data.nodes.map((n: any) => n.title)).toEqual(["Widget Pricing"]);
  });

  it("never returns documents from nests the caller can't see", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      "/search?q=widget",
      undefined,
      outsider.apiKey,
    );
    expect(status).toBe(200);
    expect(data.count).toBe(0);
  });

  it("requires q, whitespace included", async () => {
    for (const path of ["/search", "/search?q=", "/search?q=%20%20"]) {
      const { status } = await jsonRequest(app, "GET", path, undefined, owner.apiKey);
      expect(status).toBe(400);
    }
  });

  it("caps the result count at the requested limit", async () => {
    const { data } = await jsonRequest(
      app,
      "GET",
      "/search?q=widget&limit=1",
      undefined,
      owner.apiKey,
    );
    // count reports everything found; nodes carries the capped page.
    expect(data.count).toBe(2);
    expect(data.nodes).toHaveLength(1);
  });

  it("clamps a limit outside [1,50] instead of honouring it", async () => {
    // Above the ceiling: capped at 50, so both hits still come back.
    const high = await jsonRequest(
      app,
      "GET",
      "/search?q=widget&limit=1000",
      undefined,
      owner.apiKey,
    );
    expect(high.data.nodes).toHaveLength(2);

    // Zero and junk fall back to the default page size rather than returning
    // nothing — a search that answers with an empty list is never what a
    // caller meant by limit=0.
    for (const limit of ["0", "abc"]) {
      const { data } = await jsonRequest(
        app,
        "GET",
        `/search?q=widget&limit=${limit}`,
        undefined,
        owner.apiKey,
      );
      expect(data.nodes).toHaveLength(2);
    }

    // A negative number is a real number, so it clamps to the floor of 1
    // rather than falling back to the default.
    const negative = await jsonRequest(
      app,
      "GET",
      "/search?q=widget&limit=-5",
      undefined,
      owner.apiKey,
    );
    expect(negative.data.nodes).toHaveLength(1);
  });
});
