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

// A person shared ONE document reaches the nest only through that grant. The
// dashboard lists the nest for them, so it shows them its pin control — and a
// control the UI offers must not 404. The nest middleware admits a grantee for
// a specific set of routes; pinning was missing from that list (CU-wdqcq00d63
// review), so the request died before reaching the handler that would allow it.
describe("nest pins — a document grantee", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let guest: { apiKey: string; email: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    guest = await registerUser(app, "guest@acme.com", "Guest");
    const { data: nest } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Granted Vault" },
      owner.apiKey,
    );
    nestId = nest.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Shared One", content: "# shared" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      {
        target_type: "document",
        target: "nodes/shared-one",
        email: guest.email,
        role: "read",
      },
      owner.apiKey,
    );
  }, 30000);

  afterAll(() => env.cleanup());

  it("can pin the nest it was granted a document in", async () => {
    const pin = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/pin`,
      {},
      guest.apiKey,
    );
    expect(pin.status).toBe(200);

    const list = await jsonRequest(app, "GET", "/nests", null, guest.apiKey);
    const row = list.data.nests.find((n: any) => n.id === nestId);
    // The card the grantee sees is the one carrying the pin control.
    expect(row).toBeTruthy();
    expect(row.pinned).toBe(true);

    const un = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/pin`,
      null,
      guest.apiKey,
    );
    expect(un.status).toBe(200);
  });

  it("pinning still grants no wider read", async () => {
    await jsonRequest(app, "POST", `/nests/${nestId}/pin`, {}, guest.apiKey);
    // The sibling document was never shared; a pin must not have changed that.
    const sibling = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/sibling-secret`,
      null,
      guest.apiKey,
    );
    expect([403, 404]).toContain(sibling.status);
  });
});

// Two clicks landing together both pass the existence check, so the loser's
// INSERT trips the composite primary key — a 409 on SQLite, a 500 on Postgres,
// for an operation whose whole contract is idempotence (CU-wdqcq00d63 review).
describe("nest pins — concurrent pins of the same nest", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    const { data: nest } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Racy Vault" },
      owner.apiKey,
    );
    nestId = nest.nest.id;
  }, 30000);

  afterAll(() => env.cleanup());

  it("both requests succeed and the nest ends up pinned once", async () => {
    const [a, b] = await Promise.all([
      jsonRequest(app, "POST", `/nests/${nestId}/pin`, {}, owner.apiKey),
      jsonRequest(app, "POST", `/nests/${nestId}/pin`, {}, owner.apiKey),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const list = await jsonRequest(app, "GET", "/nests", null, owner.apiKey);
    expect(
      list.data.nests.filter((n: any) => n.id === nestId && n.pinned).length,
    ).toBe(1);
  });
});

// A pin must never be the thing that stops an admin removing an account.
// nest_pins.user_id cascades, and DELETE /users/:id clears it explicitly too —
// without either, foreign_keys=ON fails the whole removal transaction on a
// single pinned nest (CU-wdqcq00d63 review).
describe("nest pins — removing a user who pinned something", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let admin: { apiKey: string };
  let leaver: { apiKey: string; email: string; userId: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { ownerEmail: "admin@acme.com" });
    admin = await registerUser(app, "admin@acme.com", "Admin");
    leaver = await registerUser(app, "leaver@acme.com", "Leaver");

    // The admin owns the nest, not the leaver: a user who owns nests is
    // refused removal by an earlier guard, so the pin could never be what
    // breaks it. The reachable case is a pin on someone else's shared nest.
    const { data: nest } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Team Vault" },
      admin.apiKey,
    );
    nestId = nest.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "leaver@acme.com", permission: "read" },
      admin.apiKey,
    );
    const pin = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/pin`,
      {},
      leaver.apiKey,
    );
    expect(pin.status).toBe(200);
  }, 30000);

  afterAll(() => env.cleanup());

  it("removes the account instead of failing on a foreign key", async () => {
    const removed = await jsonRequest(
      app,
      "DELETE",
      `/auth/users/${leaver.userId}`,
      null,
      admin.apiKey,
    );
    expect(removed.status).toBe(200);
  });
});
