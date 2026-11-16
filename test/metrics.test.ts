/**
 * GET /metrics (METRICS_ENABLED). Route labels must be the route PATTERN, so a
 * nest id never becomes its own series.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

beforeEach(() => setupTestEnv());
afterEach(() => {
  delete process.env.METRICS_ENABLED;
  delete process.env.METRICS_TOKEN;
});

const scrape = async (app: any, token?: string) => {
  const res = await app.request("/metrics", token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  return { status: res.status, body: await res.text() };
};

describe("/metrics", () => {
  it("is not served unless METRICS_ENABLED", async () => {
    const app = await createTestApp("key");
    expect((await scrape(app)).body).not.toContain("contextnest_");
  });

  it("labels requests by route pattern, and counts MCP tool calls", async () => {
    process.env.METRICS_ENABLED = "true";
    const app = await createTestApp("key");
    const user = await registerUser(app, "m@example.com");
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Metrics" }, user.apiKey);
    await jsonRequest(app, "GET", `/nests/${data.nest.id}/nodes`, undefined, user.apiKey);

    const { recordToolCall } = await import("../src/ops/metrics.js");
    recordToolCall("context_search", 200, 12);

    const { status, body } = await scrape(app);
    expect(status).toBe(200);
    expect(body).toMatch(/contextnest_http_request_duration_seconds_count\{method="GET",route="\/nests\/:nestId\/nodes",status="200"\} 1/);
    expect(body).not.toContain(data.nest.id);
    expect(body).toMatch(/contextnest_mcp_tool_duration_seconds_count\{tool="context_search",status="200"\} 1/);
    expect(body).toContain("contextnest_process_cpu_seconds_total");
  });

  it("needs the bearer token when METRICS_TOKEN is set", async () => {
    process.env.METRICS_ENABLED = "true";
    process.env.METRICS_TOKEN = "scrape-secret";
    const app = await createTestApp("key");
    expect((await scrape(app)).status).toBe(401);
    expect((await scrape(app, "wrong")).status).toBe(401);
    expect((await scrape(app, "scrape-secret")).status).toBe(200);
  });
});
