/**
 * Prometheus metrics, behind METRICS_ENABLED (off by default; importers load
 * this module only when it is on). Labels use the
 * route PATTERN (`/nests/:nestId/nodes`), never the raw path, so the series
 * count stays bounded however many nests and documents there are.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";
import { routePath } from "hono/route";
import client from "prom-client";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import type { PostgresAdapter } from "../db/adapter.postgres.js";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "contextnest_" });

const httpDuration = new client.Histogram({
  name: "contextnest_http_request_duration_seconds",
  help: "HTTP request latency by method, route pattern and status.",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

// Status 503 here is a vault write-lock timeout (VAULT_BUSY).
const mcpDuration = new client.Histogram({
  name: "contextnest_mcp_tool_duration_seconds",
  help: "MCP tool call latency by tool and status (count = calls).",
  labelNames: ["tool", "status"],
  registers: [registry],
});

for (const [key, help] of [
  ["totalCount", "Postgres pool connections open."],
  ["idleCount", "Postgres pool connections idle."],
  ["waitingCount", "Requests waiting for a Postgres pool connection."],
] as const) {
  new client.Gauge({
    name: `contextnest_db_pool_${key.replace("Count", "")}`,
    help,
    registers: [registry],
    collect() {
      const db = getDb();
      if (db.dialect === "postgres") this.set((db as PostgresAdapter).pool[key]);
    },
  });
}

export async function httpMetrics(c: Context, next: Next): Promise<void> {
  const start = performance.now();
  try {
    await next();
  } finally {
    // After next(), routeIndex points at the handler that answered.
    httpDuration.observe(
      { method: c.req.method, route: routePath(c) || "unmatched", status: String(c.res.status) },
      (performance.now() - start) / 1000,
    );
  }
}

export function recordToolCall(tool: string, status: number, ms: number): void {
  mcpDuration.observe({ tool, status: String(status) }, ms / 1000);
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** GET /metrics. With METRICS_TOKEN set, the scraper must send it as a bearer token. */
export async function metricsHandler(c: Context): Promise<Response> {
  const token = config.METRICS_TOKEN;
  if (token) {
    const sent = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!timingSafeEqual(digest(sent), digest(token))) return c.text("Unauthorized", 401);
  }
  return c.body(await registry.metrics(), 200, { "Content-Type": registry.contentType });
}
