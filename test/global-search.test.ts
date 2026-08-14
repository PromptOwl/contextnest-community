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

  it("requires q", async () => {
    const { status } = await jsonRequest(
      app,
      "GET",
      "/search",
      undefined,
      owner.apiKey,
    );
    expect(status).toBe(400);
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
});
