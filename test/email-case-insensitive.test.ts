/**
 * CU-wdqcpztrhf — email must be case-insensitive. Mixed-case email created
 * duplicate user rows: collaborator grants landed on one row while the person
 * logged into another (no nest access), and login/reset case mismatches piled
 * up failures until the rate-limiter locked the user out.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  jsonRequest,
  registerUser,
  resetAuthRateLimit,
} from "./helpers";
import { getDb } from "../src/db/client";

describe("email is case-insensitive", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;

  beforeEach(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
  });
  afterEach(() => env.cleanup());

  it("login works regardless of the email case used", async () => {
    await jsonRequest(app, "POST", "/auth/register", {
      email: "Mixed@Case.com",
      password: "testpass8",
    });
    await resetAuthRateLimit();
    const res = await jsonRequest(app, "POST", "/auth/login", {
      email: "mixed@case.com",
      password: "testpass8",
    });
    expect(res.status).toBe(200);
  });

  it("registering the same email in a different case does not create a duplicate", async () => {
    await jsonRequest(app, "POST", "/auth/register", {
      email: "user@x.com",
      password: "testpass8",
    });
    await resetAuthRateLimit();
    await jsonRequest(app, "POST", "/auth/register", {
      email: "USER@x.com",
      password: "testpass8",
    });
    const { c } = getDb()
      .prepare("SELECT COUNT(*) AS c FROM users WHERE LOWER(email) = LOWER(?)")
      .get("user@x.com") as { c: number };
    expect(c).toBe(1);
  });

  it("a collaborator added by mixed-case email resolves to the user's nest access", async () => {
    const owner = await registerUser(app, "owner@x.com", "Owner");
    await resetAuthRateLimit();
    const her = await registerUser(app, "her@x.com", "Her");
    await resetAuthRateLimit();

    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Shared Nest" },
      owner.apiKey,
    );
    const nestId = data.nest.id;

    // Added in a DIFFERENT case than she registered with.
    const add = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: "HER@X.com", permission: "write" },
      owner.apiKey,
    );
    expect(add.status).toBe(201);

    // She should see the nest (shared) and there must be no duplicate row.
    const list = await jsonRequest(app, "GET", "/nests", undefined, her.apiKey);
    const ids = (list.data.nests || []).map((n: any) => n.id);
    expect(ids).toContain(nestId);

    const { c } = getDb()
      .prepare("SELECT COUNT(*) AS c FROM users WHERE LOWER(email) = LOWER(?)")
      .get("her@x.com") as { c: number };
    expect(c).toBe(1);
  });
});
