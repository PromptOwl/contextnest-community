import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

// Pin/favorite frequently used nests (CU-wdqcq00d63).
//
// The rule that shapes every test here: a pin belongs to a PERSON, not to a
// nest. Two people looking at the same shared nest see their own answer, and
// pinning changes nothing anyone else can observe — which is also why it needs
// no permission tier beyond being able to see the nest at all.
describe("nest pins", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let viewer: { apiKey: string };
  let stranger: { apiKey: string };
  let nestId: string;
  let otherNestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    viewer = await registerUser(app, "viewer@acme.com", "Viewer");
    stranger = await registerUser(app, "stranger@acme.com", "Stranger");

    const { data: nest } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Shared Vault" },
      owner.apiKey,
    );
    nestId = nest.nest.id;
    const { data: other } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Second Vault" },
      owner.apiKey,
    );
    otherNestId = other.nest.id;

    // Read-only on purpose: a viewer is the likeliest person to be watching a
    // handful of nests they cannot edit.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "viewer@acme.com", permission: "read" },
      owner.apiKey,
    );
  }, 30000);

  afterAll(() => env.cleanup());

  it("pins, reports it on the list, and unpins again", async () => {
    const before = await jsonRequest(app, "GET", "/nests", null, owner.apiKey);
    expect(before.data.nests.every((n: any) => n.pinned === false)).toBe(true);

    const pin = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/pin`,
      {},
      owner.apiKey,
    );
    expect(pin.status).toBe(200);
    expect(pin.data.pinned).toBe(true);

    const after = await jsonRequest(app, "GET", "/nests", null, owner.apiKey);
    const byId = Object.fromEntries(
      after.data.nests.map((n: any) => [n.id, n.pinned]),
    );
    expect(byId[nestId]).toBe(true);
    expect(byId[otherNestId]).toBe(false);

    const un = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/pin`,
      null,
      owner.apiKey,
    );
    expect(un.status).toBe(200);
    const back = await jsonRequest(app, "GET", "/nests", null, owner.apiKey);
    expect(back.data.nests.every((n: any) => n.pinned === false)).toBe(true);
  });

  it("is idempotent in both directions", async () => {
    await jsonRequest(app, "POST", `/nests/${nestId}/pin`, {}, owner.apiKey);
    const twice = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/pin`,
      {},
      owner.apiKey,
    );
    expect(twice.status).toBe(200);

    await jsonRequest(app, "DELETE", `/nests/${nestId}/pin`, null, owner.apiKey);
    const again = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/pin`,
      null,
      owner.apiKey,
    );
    expect(again.status).toBe(200);
  });

  it("a read-only collaborator can pin — it needs no write access", async () => {
    const pin = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/pin`,
      {},
      viewer.apiKey,
    );
    expect(pin.status).toBe(200);

    const theirs = await jsonRequest(app, "GET", "/nests", null, viewer.apiKey);
    expect(
      theirs.data.nests.find((n: any) => n.id === nestId).pinned,
    ).toBe(true);
  });

  it("is private to the person who set it", async () => {
    // The viewer pinned it in the test above; the owner must not see that.
    const theirs = await jsonRequest(app, "GET", "/nests", null, owner.apiKey);
    expect(
      theirs.data.nests.find((n: any) => n.id === nestId).pinned,
    ).toBe(false);
  });

  it("refuses a nest the caller cannot see, without confirming it exists", async () => {
    const pin = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/pin`,
      {},
      stranger.apiKey,
    );
    // 404, not 403 — the endpoint must not become a way to test nest ids.
    expect(pin.status).toBe(404);
  });

  it("lets the pin go when the nest is deleted", async () => {
    await jsonRequest(app, "POST", `/nests/${otherNestId}/pin`, {}, owner.apiKey);
    const del = await jsonRequest(
      app,
      "DELETE",
      `/nests/${otherNestId}`,
      null,
      owner.apiKey,
    );
    expect(del.status).toBe(200);

    // Recreating a nest must never inherit a dead pin. The row is gone, so a
    // fresh nest starts unpinned.
    const { data: fresh } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Third Vault" },
      owner.apiKey,
    );
    const list = await jsonRequest(app, "GET", "/nests", null, owner.apiKey);
    expect(
      list.data.nests.find((n: any) => n.id === fresh.nest.id).pinned,
    ).toBe(false);
  });
});
