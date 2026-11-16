/**
 * An engine without `view` in NODE_TYPES: creating a View is refused cleanly
 * (4xx, never 500) and plain documents still work.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("@promptowl/contextnest-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@promptowl/contextnest-engine")>();
  return { ...actual, NODE_TYPES: actual.NODE_TYPES.filter((t: string) => t !== "view") };
});

import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@no-view.test", "Owner");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "NoView" }, owner.apiKey);
  nestId = nest.data.nest.id;
});

afterAll(() => env.cleanup());

describe("engine without the view type", () => {
  it("refuses to create a View without a 500", async () => {
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "V",
        type: "view",
        content: "Intro.",
        view: { blocks: [{ callout: { text: "Add blocks to this view." } }] },
      },
      owner.apiKey,
    );
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it("still creates a plain document", async () => {
    const r = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Doc", content: "Body." },
      owner.apiKey,
    );
    expect(r.status).toBe(201);
  });
});
