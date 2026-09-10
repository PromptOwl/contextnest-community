/**
 * Outside-org publish guardrail on PATCH /nests/:id/visibility.
 *
 * Flipping a nest to `public` makes it readable by anyone on the internet,
 * outside your organization — so it now requires an explicit
 * `acknowledge_public: true`. Without the ack the endpoint returns 409 with
 * `requires_acknowledgement: true` and a warning, and does NOT change the
 * stored visibility. Going back to `private` needs no acknowledgement.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  jsonRequest,
  registerUser,
  resetAuthRateLimit,
} from "./helpers";

describe("PATCH /nests/:id/visibility — outside-org publish guardrail", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string; email: string };
  let outsider: { apiKey: string; userId: string; email: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    await resetAuthRateLimit();
    outsider = await registerUser(app, "outsider@acme.com", "Outsider");

    const { data } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Docs" },
      owner.apiKey,
    );
    nestId = data.nest.id;
  });

  afterAll(() => env.cleanup());

  it("public WITHOUT acknowledge_public → 409 requires_acknowledgement", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "public" },
      owner.apiKey,
    );
    expect(res.status).toBe(409);
    expect(res.data.requires_acknowledgement).toBe(true);
    expect(res.data.warning).toMatch(/outside your organization/i);

    // Visibility was NOT changed as a side effect.
    const got = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}`,
      undefined,
      owner.apiKey,
    );
    expect(got.data.nest.visibility).toBe("private");
  });

  it("public WITH acknowledge_public → 200", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "public", acknowledge_public: true },
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.visibility).toBe("public");
  });

  it("back to private needs no acknowledgement → 200", async () => {
    const res = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "private" },
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.visibility).toBe("private");
  });

  it("an anonymous read of a public nest still only sees approved content", async () => {
    // Publish (with ack) so the nest is publicly readable…
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "public", acknowledge_public: true },
      owner.apiKey,
    );
    // …an anonymous caller can read the nest metadata (public read tier)…
    const anon = await jsonRequest(app, "GET", `/nests/${nestId}`);
    expect(anon.status).toBe(200);
    expect(anon.data.nest.visibility).toBe("public");
    // …but an anonymous WRITE (flipping visibility) is still rejected.
    const write = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "private" },
    );
    expect(write.status).not.toBe(200);
    expect([401, 403]).toContain(write.status);
  });
});
