/**
 * Repro for "turned stewardship on but card still shows Ungoverned".
 * The dashboard list must carry per-nest stewardship_enabled so the badge
 * can reflect governance state, not just anon-ownership.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, jsonRequest, registerUser } from "./helpers";

describe("repro: governed badge data", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let user: { apiKey: string; userId: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    user = await registerUser(app, "owner@acme.com", "Owner");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Registry" }, user.apiKey);
    nestId = nest.data.nest.id;
  });

  afterAll(() => env.cleanup());

  async function cardStewardship(): Promise<boolean | undefined> {
    const { data } = await jsonRequest(app, "GET", "/nests", undefined, user.apiKey);
    return data.nests.find((n: any) => n.id === nestId)?.stewardship_enabled;
  }

  it("GET /nests exposes stewardship_enabled and it flips when enabled", async () => {
    expect(await cardStewardship()).toBeFalsy();

    const patch = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { stewardship_enabled: true },
      user.apiKey,
    );
    expect(patch.status).toBe(200);

    expect(await cardStewardship()).toBeTruthy();
  });
});
