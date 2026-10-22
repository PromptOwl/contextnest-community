/**
 * An edit that waits for review is a draft. The PATCH reply used to report the
 * last published status ("published") while GET said "draft".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest, resetAuthRateLimit } from "./helpers.js";

describe("governed edit reply status", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@test.com", "Owner");
    await resetAuthRateLimit();
    const reviewer = await registerUser(app, "rev@test.com", "Rev");
    nestId = (await jsonRequest(app, "POST", "/nests", { name: "Gov" }, owner.apiKey)).data.nest.id;
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Doc", content: "# Doc\n\nv1" }, owner.apiKey);
    const s = await jsonRequest(app, "POST", `/nests/${nestId}/stewards`, { scope: "nest", email: "rev@test.com", role: "reviewer" }, owner.apiKey);
    expect(s.status, JSON.stringify(s.data)).toBeLessThan(300);
    void reviewer;
  }, 60000);

  afterAll(() => env.cleanup());

  it("reports draft in the PATCH reply, as GET does", async () => {
    const patch = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/nodes/doc`, { content: "# Doc\n\nv2" }, owner.apiKey);
    expect(patch.status, JSON.stringify(patch.data)).toBe(200);
    const got = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/doc`, undefined, owner.apiKey);
    expect(got.data.node?.status ?? got.data.status).toBe("draft");
    expect(patch.data.node.status).toBe("draft");
  });
});
