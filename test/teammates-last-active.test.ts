/** Teammates "Last active" counts web sessions, not only API-key use (CU-wdqcq02cxq). */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@acme.com"] });
});

afterAll(() => env.cleanup());

describe("GET /auth/teammates last_active", () => {
  it("reflects a teammate who has only used the web app", async () => {
    const root = await registerUser(app, "root@acme.com", "Root");
    // Registration opens a session; bob's API key is never used.
    await registerUser(app, "bob@acme.com", "Bob");
    const res = await jsonRequest(app, "GET", "/auth/teammates", undefined, root.apiKey);
    expect(res.status).toBe(200);
    const bob = res.data.teammates.find((t: any) => t.email === "bob@acme.com");
    expect(bob.last_active).toBeTruthy();
  });
});
