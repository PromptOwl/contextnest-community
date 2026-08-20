/**
 * resolveNestAccess — the single fetch every permission decision runs through.
 *
 * `resolveNestPermission` and `isPublicReader` are now thin wrappers over it,
 * so the merge rules are worth asserting directly rather than only through the
 * routes that happen to exercise them. Each case is one caller shape against
 * one nest; the point is the ORDER and the highest-wins merge, which a route
 * test would only catch by accident.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  resetAuthRateLimit,
} from "./helpers.js";
import {
  resolveNestAccess,
  resolveNestPermission,
  isPublicReader,
} from "../src/shared/access.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let collaborator: { apiKey: string; userId: string; email: string };
let steward: { apiKey: string; userId: string; email: string };
let grantee: { apiKey: string; userId: string; email: string };
let stranger: { apiKey: string; userId: string; email: string };
let privateNest: string;
let publicNest: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  // Reset between each — five registrations in a row trips the auth limiter.
  const register = async (email: string, name: string) => {
    resetAuthRateLimit();
    return registerUser(app, email, name);
  };
  owner = await register("owner@acme.com", "Owner");
  collaborator = await register("collab@acme.com", "Collab");
  steward = await register("steward@acme.com", "Steward");
  grantee = await register("grantee@acme.com", "Grantee");
  stranger = await register("stranger@acme.com", "Stranger");

  const priv = await jsonRequest(app, "POST", "/nests", { name: "Private" }, owner.apiKey);
  privateNest = priv.data.nest.id;
  const pub = await jsonRequest(app, "POST", "/nests", { name: "Public" }, owner.apiKey);
  publicNest = pub.data.nest.id;
  await jsonRequest(app, "PATCH", `/nests/${publicNest}/visibility`, { visibility: "public" }, owner.apiKey);

  await jsonRequest(app, "POST", `/nests/${privateNest}/nodes`, { title: "Doc One", content: "# one" }, owner.apiKey);
  await jsonRequest(
    app,
    "POST",
    `/nests/${privateNest}/collaborators`,
    { email: collaborator.email, permission: "write" },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${privateNest}/stewards`,
    { email: steward.email, role: "reviewer", scope: "nest" },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${privateNest}/grants`,
    { target_type: "document", target: "nodes/doc-one", email: grantee.email, role: "read" },
    owner.apiKey,
  );
}, 30000);

afterAll(() => env.cleanup());

describe("resolveNestAccess — permission merge", () => {
  it("the owner is owner", async () => {
    const a = await resolveNestAccess(privateNest, owner.userId);
    expect(a.permission).toBe("owner");
    expect(a.exists).toBe(true);
    expect(a.isPublicReader).toBe(false);
  });

  it("a collaborator gets their granted tier", async () => {
    const a = await resolveNestAccess(privateNest, collaborator.userId);
    expect(a.permission).toBe("write");
    expect(a.collaboratorPermission).toBe("write");
  });

  it("a steward gets nest-level read without a collaborator row", async () => {
    const a = await resolveNestAccess(privateNest, steward.userId);
    expect(a.isSteward).toBe(true);
    expect(a.collaboratorPermission).toBeNull();
    expect(a.permission).toBe("read");
  });

  it("a grantee holds NO nest-wide permission — that's what routes them to the per-node checks", async () => {
    const a = await resolveNestAccess(privateNest, grantee.userId);
    expect(a.permission).toBe("none");
    expect(a.hasGrant).toBe(true);
  });

  it("a stranger gets nothing, and holds no grant", async () => {
    const a = await resolveNestAccess(privateNest, stranger.userId);
    expect(a.permission).toBe("none");
    expect(a.hasGrant).toBe(false);
    expect(a.isSteward).toBe(false);
  });

  it("a missing nest resolves to none rather than throwing", async () => {
    const a = await resolveNestAccess("no-such-nest", owner.userId);
    expect(a.exists).toBe(false);
    expect(a.permission).toBe("none");
    expect(a.isPublicReader).toBe(false);
  });
});

describe("resolveNestAccess — public readers", () => {
  it("a stranger on a public nest is a public reader", async () => {
    const a = await resolveNestAccess(publicNest, stranger.userId);
    expect(a.permission).toBe("read");
    expect(a.isPublicReader).toBe(true);
  });

  it("the owner of a public nest is not a public reader", async () => {
    const a = await resolveNestAccess(publicNest, owner.userId);
    expect(a.permission).toBe("owner");
    expect(a.isPublicReader).toBe(false);
  });

  it("a collaborator on a public nest reads drafts, not approved-only", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${publicNest}/collaborators`,
      { email: collaborator.email, permission: "read" },
      owner.apiKey,
    );
    const a = await resolveNestAccess(publicNest, collaborator.userId);
    expect(a.permission).toBe("read");
    expect(a.isPublicReader).toBe(false);
  });

  it("a steward on a public nest is not a mere public reader", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${publicNest}/stewards`,
      { email: steward.email, role: "reviewer", scope: "nest" },
      owner.apiKey,
    );
    const a = await resolveNestAccess(publicNest, steward.userId);
    expect(a.isPublicReader).toBe(false);
  });
});

describe("the wrappers stay faithful to the fetch", () => {
  it("resolveNestPermission and isPublicReader agree with resolveNestAccess", async () => {
    for (const [nest, user] of [
      [privateNest, owner.userId],
      [privateNest, collaborator.userId],
      [privateNest, steward.userId],
      [privateNest, grantee.userId],
      [privateNest, stranger.userId],
      [publicNest, stranger.userId],
      [publicNest, owner.userId],
    ] as const) {
      const a = await resolveNestAccess(nest, user);
      expect(await resolveNestPermission(nest, user)).toBe(a.permission);
      expect(await isPublicReader(nest, user)).toBe(a.isPublicReader);
    }
  });
});
