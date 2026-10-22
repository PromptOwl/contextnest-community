/**
 * POST /auth/device/poll takes the client_secret in the JSON body, so the
 * secret never lands in this server's access logs. GET with query params is
 * deprecated but kept for older CLIs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestEnv, createTestApp } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let fetchUrls: string[];

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("open");
  vi.stubGlobal("fetch", async (url: string) => {
    fetchUrls.push(String(url));
    return new Response(JSON.stringify({ status: "pending" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  env.cleanup();
});

beforeEach(() => {
  fetchUrls = [];
});

const post = (body: unknown) =>
  app.request("/auth/device/poll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /auth/device/poll", () => {
  it("reads code and client_secret from the body and relays the status", async () => {
    const res = await post({ code: "C1", client_secret: "S1" });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("pending");
    expect(fetchUrls).toHaveLength(1);
    expect(fetchUrls[0]).toContain("/api/auth/device/poll");
  });

  it.each([
    ["missing secret", { code: "C1" }],
    ["non-string secret", { code: "C1", client_secret: 42 }],
    ["invalid JSON", "{not json"],
  ])("returns 400 for %s without calling PromptOwl", async (_, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(fetchUrls).toHaveLength(0);
  });

  it("ignores query params, so a secret in the URL is not accepted", async () => {
    const res = await app.request("/auth/device/poll?code=C1&client_secret=S1", {
      method: "POST",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /auth/device/poll (deprecated)", () => {
  it("still works for older CLIs", async () => {
    const res = await app.request("/auth/device/poll?code=C1&client_secret=S1");
    expect(res.status).toBe(200);
    expect(fetchUrls).toHaveLength(1);
  });
});
