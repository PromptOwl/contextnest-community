/**
 * Per-nest env store — credentials the runner hands to TOOL nodes.
 * Write-only through the API: GET returns key names + a masked tail, never
 * full values. Values leave the server exactly once per run, inside the run
 * bundle (which already requires write permission to obtain).
 *
 * Honest scope: values are NOT encrypted at rest — they sit in the same
 * SQLite/Postgres the nest content sits in, same trust domain. This is a
 * convenience store for self-hosted deployments, not a vault.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { ValidationError, NotFoundError } from "../shared/errors.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { requireWorkflowPlane } from "./edge-type-routes.js";

const KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

interface EnvRow {
  key: string;
  value: string;
  updated_by: string;
  updated_at: string;
}

const mask = (v: string) =>
  v.length <= 4 ? "••••" : `••••${v.slice(-4)}`;

export const envRoutes = new Hono<AuthEnv>();
// Per-route gating (not use("*")) — see the LinearRouter note in edge-routes.

// GET /nests/:nestId/env — names + masked tails only.
envRoutes.get("/", requireWorkflowPlane, async (c) => {
  const nestId = c.req.param("nestId")!;
  const rows = (await getDb().all(
    "SELECT key, value, updated_by, updated_at FROM nest_env WHERE nest_id = ? ORDER BY key",
    [nestId],
  )) as EnvRow[];
  return c.json({
    count: rows.length,
    env: rows.map((r) => ({
      key: r.key,
      value_masked: mask(r.value),
      updated_by: r.updated_by,
      updated_at: r.updated_at,
    })),
  });
});

// PUT /nests/:nestId/env { key, value } — create or replace.
envRoutes.put("/", requireWorkflowPlane, async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<{ key?: string; value?: string }>();
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!KEY_RE.test(key)) {
    throw new ValidationError(
      "key must look like an env var: A-Z, digits, underscores (e.g. SLACK_TOKEN)",
    );
  }
  if (typeof body.value !== "string" || !body.value) {
    throw new ValidationError("value is required");
  }
  const now = new Date().toISOString();
  const by = await resolveCallerEmail(c.get("userId"));
  const db = getDb();
  await db.run(
    `INSERT INTO nest_env (nest_id, key, value, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(nest_id, key) DO UPDATE SET value = ?, updated_by = ?, updated_at = ?`,
    [nestId, key, body.value, by, now, body.value, by, now],
  );
  return c.json({ key, value_masked: mask(body.value) }, 201);
});

// DELETE /nests/:nestId/env/:key
envRoutes.delete("/:key", requireWorkflowPlane, async (c) => {
  const nestId = c.req.param("nestId")!;
  const key = c.req.param("key")!;
  const db = getDb();
  const row = await db.get(
    "SELECT key FROM nest_env WHERE nest_id = ? AND key = ?",
    [nestId, key],
  );
  if (!row) throw new NotFoundError("No such env key");
  await db.run("DELETE FROM nest_env WHERE nest_id = ? AND key = ?", [nestId, key]);
  return c.json({ deleted: true });
});

/** Full values — for the run bundle only, never a route response. The
 *  server-wide ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL (super-admin
 *  Settings) are the floor; nest env rows override them. The gateway URL
 *  rides along so the same setting routes agent runs and Hootie alike. */
export async function envValues(nestId: string): Promise<Record<string, string>> {
  const rows = (await getDb().all(
    "SELECT key, value FROM nest_env WHERE nest_id = ?",
    [nestId],
  )) as Array<{ key: string; value: string }>;
  const base: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) base.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (config.ANTHROPIC_BASE_URL) base.ANTHROPIC_BASE_URL = config.ANTHROPIC_BASE_URL;
  return { ...base, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}
