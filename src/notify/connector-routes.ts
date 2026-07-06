/**
 * Connector CRUD — /nests/:nestId/connectors. Rows are the outbound lego
 * bricks dispatch.ts fans events into: channel preset (slack/teams/webhook),
 * a url (literal https or env:KEY into the tools env store), and an event
 * list. No feature gate: notifications exist with or without the workflow
 * plane.
 */
import { Hono } from "hono";
import { v4 as uuid } from "uuid";
import type { AuthEnv } from "../auth/middleware.js";
import { getDb } from "../db/client.js";
import { ValidationError, NotFoundError } from "../shared/errors.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { isSafeConnectorUrl } from "./dispatch.js";

export const KNOWN_EVENTS = [
  "review_requested",
  "review_approved",
  "review_rejected",
  "run_failed",
] as const;

const CHANNELS = ["slack", "teams", "webhook"] as const;

interface ConnectorRow {
  id: string;
  channel: string;
  url: string;
  events: string;
  enabled: number;
  created_by: string;
  created_at: string;
}

function toResponse(r: ConnectorRow) {
  let events: string[] = [];
  try {
    events = JSON.parse(r.events);
  } catch {
    /* tolerate */
  }
  // env:KEY references are safe to echo; literal webhook URLs carry an
  // implicit secret in the path — mask the tail like the env store does.
  const url = r.url.startsWith("env:")
    ? r.url
    : r.url.replace(/^(https:\/\/[^/]+\/).+(.{4})$/, "$1••••$2");
  return {
    id: r.id,
    channel: r.channel,
    url,
    events,
    enabled: !!r.enabled,
    created_by: r.created_by,
    created_at: r.created_at,
  };
}

function parseEvents(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) {
    throw new ValidationError(
      `events must be a non-empty array — any of ${KNOWN_EVENTS.join(", ")}, or ["*"]`,
    );
  }
  for (const e of v) {
    if (e !== "*" && !KNOWN_EVENTS.includes(e as any)) {
      throw new ValidationError(`unknown event "${e}"`);
    }
  }
  return JSON.stringify(v);
}

function parseUrl(v: unknown): string {
  const raw = typeof v === "string" ? v.trim() : "";
  if (raw.startsWith("env:") && raw.length > 4) return raw;
  if (isSafeConnectorUrl(raw)) return raw;
  throw new ValidationError(
    'url must be a public https:// URL (loopback/private/metadata hosts are refused) or an env reference like "env:SLACK_WEBHOOK"',
  );
}

export const connectorRoutes = new Hono<AuthEnv>();

// GET /nests/:nestId/connectors
connectorRoutes.get("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  const rows = (await getDb().all(
    "SELECT * FROM connectors WHERE nest_id = ? ORDER BY created_at",
    [nestId],
  )) as ConnectorRow[];
  return c.json({ count: rows.length, connectors: rows.map(toResponse) });
});

// POST /nests/:nestId/connectors { channel, url, events }
connectorRoutes.post("/", async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<Record<string, unknown>>();
  const channel = String(body.channel ?? "");
  if (!CHANNELS.includes(channel as any)) {
    throw new ValidationError(`channel must be ${CHANNELS.join(" | ")}`);
  }
  const url = parseUrl(body.url);
  const events = parseEvents(body.events);
  const now = new Date().toISOString();
  const id = `con_${uuid()}`;
  await getDb().run(
    `INSERT INTO connectors (id, nest_id, channel, url, events, enabled, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [id, nestId, channel, url, events, await resolveCallerEmail(c.get("userId")), now, now],
  );
  const row = (await getDb().get("SELECT * FROM connectors WHERE id = ?", [id])) as ConnectorRow;
  return c.json({ connector: toResponse(row) }, 201);
});

// PATCH /nests/:nestId/connectors/:id { enabled?, events?, url? }
connectorRoutes.patch("/:id", async (c) => {
  const nestId = c.req.param("nestId")!;
  const id = c.req.param("id")!;
  const db = getDb();
  const row = (await db.get(
    "SELECT * FROM connectors WHERE id = ? AND nest_id = ?",
    [id, nestId],
  )) as ConnectorRow | undefined;
  if (!row) throw new NotFoundError("Connector not found");
  const body = await c.req.json<Record<string, unknown>>();
  const enabled = body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0;
  const events = body.events === undefined ? row.events : parseEvents(body.events);
  const url = body.url === undefined ? row.url : parseUrl(body.url);
  await db.run(
    "UPDATE connectors SET enabled = ?, events = ?, url = ?, updated_at = ? WHERE id = ?",
    [enabled, events, url, new Date().toISOString(), id],
  );
  const updated = (await db.get("SELECT * FROM connectors WHERE id = ?", [id])) as ConnectorRow;
  return c.json({ connector: toResponse(updated) });
});

// DELETE /nests/:nestId/connectors/:id
connectorRoutes.delete("/:id", async (c) => {
  const nestId = c.req.param("nestId")!;
  const id = c.req.param("id")!;
  const db = getDb();
  const row = await db.get(
    "SELECT id FROM connectors WHERE id = ? AND nest_id = ?",
    [id, nestId],
  );
  if (!row) throw new NotFoundError("Connector not found");
  await db.run("DELETE FROM connectors WHERE id = ?", [id]);
  return c.json({ deleted: true });
});
