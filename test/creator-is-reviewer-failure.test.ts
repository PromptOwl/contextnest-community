/**
 * Creator reviews their documents — when stewarding the author fails.
 *
 * v1 publishes on the strength of the creator's reviewer row, so the row is
 * written first and a failure there fails the whole create: no document, no
 * version rows, no "published because the creator is its reviewer" note
 * over a document nobody can approve.
 *
 * Separate file because the mock below is module-wide for the file.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

const failNext = { on: false };

vi.mock("../src/governance/stewardship-service.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/governance/stewardship-service.js")
  >();
  return {
    ...actual,
    stewardDocumentCreator: async (...args: [string, string, string]) => {
      if (failNext.on) {
        failNext.on = false;
        throw new Error("simulated steward write failure");
      }
      return actual.stewardDocumentCreator(...args);
    },
  };
});

type User = { apiKey: string; userId: string; email: string };

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: User;
let alice: User;
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const { data } = await jsonRequest(app, "POST", "/nests", { name: "Nest" }, owner.apiKey);
  nestId = data.nest.id;
  await jsonRequest(
    app,
    "PATCH",
    `/nests/${nestId}/settings`,
    { stewardship_enabled: true, creator_is_reviewer: true },
    owner.apiKey,
  );
  const r = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/stewards`,
    { scope: "nest", users: [{ email: alice.email, role: "editor" }] },
    owner.apiKey,
  );
  expect(r.status).toBe(201);
});

afterAll(() => env.cleanup());

describe("steward write fails", () => {
  it("the create fails and nothing is written", async () => {
    failNext.on = true;
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "doomed", content: "v1" },
      alice.apiKey,
    );
    expect(status).toBe(500);

    const read = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/doomed`,
      undefined,
      owner.apiKey,
    );
    expect(read.status).toBe(404);
    const stewards = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/stewards`,
      undefined,
      owner.apiKey,
    );
    expect(
      stewards.data.stewards.filter((s: any) => s.scope === "document"),
    ).toEqual([]);
  });

  it("a retry after the failure creates the document normally", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "doomed", content: "v1" },
      alice.apiKey,
    );
    expect(status).toBe(201);
    const read = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/doomed`,
      undefined,
      owner.apiKey,
    );
    expect(read.data.node.status).toBe("published");
  });
});
