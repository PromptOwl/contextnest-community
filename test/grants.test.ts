/**
 * Document + folder share grants: an owner/admin shares a single doc or a
 * folder with a person who is NOT a nest collaborator. The grantee can reach
 * exactly the granted node(s) — read or write per the grant — and nothing
 * else in the nest. The security-critical property is the negative: no
 * over-reach to sibling docs or nest management.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let guest: { apiKey: string; userId: string; email: string };
let outsider: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  guest = await registerUser(app, "guest@acme.com", "Guest");
  outsider = await registerUser(app, "outsider@acme.com", "Outsider");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Private" }, owner.apiKey);
  nestId = nest.data.nest.id;
  // A shared doc, a sibling doc (never shared), and a folder with two docs.
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Shared One", content: "# shared" }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Sibling Secret", content: "# secret sibling" }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Deal A", content: "# a", folder: "gtm/deals" }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Deal B", content: "# b", folder: "gtm/deals" }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "GTM Other", content: "# other", folder: "gtm" }, owner.apiKey);
});

afterAll(() => env.cleanup());

describe("managing grants", () => {
  it("owner shares one document read-only with guest", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      { target_type: "document", target: "nodes/shared-one", email: guest.email, role: "read" },
      owner.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.grant.role).toBe("read");
  });

  it("a non-admin cannot manage grants", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      { target_type: "document", target: "nodes/shared-one", email: outsider.email, role: "read" },
      guest.apiKey,
    );
    // Denied — either 403 (reached the handler) or 404 (a grant-only caller
    // can't even see /grants). Both prove a non-admin can't share.
    expect([403, 404]).toContain(res.status);
  });

  it("validates target_type and role", async () => {
    for (const body of [
      { target_type: "bogus", target: "nodes/x", email: guest.email, role: "read" },
      { target_type: "document", target: "nodes/x", email: guest.email, role: "admin" },
      { target_type: "document", target: "", email: guest.email, role: "read" },
    ]) {
      const res = await jsonRequest(app, "POST", `/nests/${nestId}/grants`, body, owner.apiKey);
      expect(res.status).toBe(400);
    }
  });
});

describe("document grant — access is scoped to exactly that doc", () => {
  it("guest can READ the shared doc", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/shared-one`, undefined, guest.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.node.content).toContain("shared");
  });

  it("guest CANNOT read the sibling secret (no grant)", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/sibling-secret`, undefined, guest.apiKey);
    expect(res.status).toBe(404);
  });

  it("guest's node list shows ONLY the shared doc, not the whole nest", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, guest.apiKey);
    expect(res.status).toBe(200);
    const ids = res.data.nodes.map((n: any) => n.id);
    expect(ids).toEqual(["nodes/shared-one"]);
  });

  it("read grant does NOT allow writing", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/shared-one`,
      { content: "hacked" },
      guest.apiKey,
    );
    expect(res.status).toBe(403);
  });

  it("upgrading to write lets guest edit that doc", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      { target_type: "document", target: "nodes/shared-one", email: guest.email, role: "write" },
      owner.apiKey,
    );
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/shared-one`,
      { append: "\nedited by guest" },
      guest.apiKey,
    );
    expect(res.status).toBe(200);
    // Still can't touch the sibling.
    const sib = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/sibling-secret`,
      { content: "x" },
      guest.apiKey,
    );
    expect(sib.status).toBe(404);
  });

  it("guest cannot reach nest management (settings/grants)", async () => {
    const settings = await jsonRequest(app, "GET", `/nests/${nestId}/settings`, undefined, guest.apiKey);
    expect([403, 404]).toContain(settings.status);
    const grants = await jsonRequest(app, "GET", `/nests/${nestId}/grants`, undefined, guest.apiKey);
    expect([403, 404]).toContain(grants.status);
  });
});

describe("folder grant — covers everything under the prefix", () => {
  it("sharing the gtm/deals folder gives outsider both deals, not gtm/other", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      { target_type: "folder", target: "nodes/gtm/deals", email: outsider.email, role: "read" },
      owner.apiKey,
    );
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, outsider.apiKey);
    const ids = list.data.nodes.map((n: any) => n.id).sort();
    expect(ids).toEqual(["nodes/gtm/deals/deal-a", "nodes/gtm/deals/deal-b"]);
    // gtm/other is one level up — NOT under gtm/deals — so it's excluded.
    expect(ids).not.toContain("nodes/gtm/gtm-other");

    const dealA = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/gtm/deals/deal-a`, undefined, outsider.apiKey);
    expect(dealA.status).toBe(200);
    const other = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/gtm/gtm-other`, undefined, outsider.apiKey);
    expect(other.status).toBe(404);
  });

  it("a folder-prefix grant doesn't leak to a sibling with a shared name-prefix", async () => {
    // nodes/gtm/deals must NOT match a hypothetical nodes/gtm/deals-archive.
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Archive X", content: "# arch", folder: "gtm/deals-archive" }, owner.apiKey);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, outsider.apiKey);
    const ids = list.data.nodes.map((n: any) => n.id);
    expect(ids).not.toContain("nodes/gtm/deals-archive/archive-x");
  });
});

describe("revoking", () => {
  it("deleting the grant removes access", async () => {
    const roster = await jsonRequest(app, "GET", `/nests/${nestId}/grants`, undefined, owner.apiKey);
    const g = roster.data.grants.find((x: any) => x.email === guest.email);
    const del = await jsonRequest(app, "DELETE", `/nests/${nestId}/grants/${g.id}`, undefined, owner.apiKey);
    expect(del.status).toBe(200);
    const read = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/shared-one`, undefined, guest.apiKey);
    expect(read.status).toBe(404);
  });
});
