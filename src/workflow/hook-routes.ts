/**
 * Inbound trigger hooks — the LISTENER face of the tools layer.
 *
 * A hook row = a tokenized public URL that creates a RUN for one agent. The
 * token (the id itself) is capability auth; the PRESET is the adapter face
 * that knows a platform's wire format:
 *
 *   slack   — slash commands (form-encoded `text`) AND Events API
 *             (@agent mentions): answers the url_verification challenge,
 *             verifies X-Slack-Signature when SLACK_SIGNING_SECRET is in the
 *             nest env store, acks inside Slack's 3s window.
 *   teams   — outgoing webhook JSON; HMAC-verified when
 *             TEAMS_WEBHOOK_SECRET is set; acks {type:"message", text}.
 *   webhook — raw JSON body becomes the run inputs verbatim.
 *
 * Every face converges on the same artifact: an unclaimed run row a polling
 * runner picks up. The server stays a ledger — a hook never executes.
 */
import { Hono } from "hono";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import type { AuthEnv } from "../auth/middleware.js";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { engineCache } from "../nodes/engine.js";
import { ValidationError, NotFoundError, ConflictError } from "../shared/errors.js";
import { resolveCallerEmail } from "../governance/access-guard.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { tryConsume } from "../shared/rate-limit.js";
import { requireWorkflowPlane } from "./edge-type-routes.js";
import { envValues } from "./env-routes.js";

const PRESETS = ["slack", "teams", "webhook"] as const;
type Preset = (typeof PRESETS)[number];
const RUNNABLE_TYPES = ["agent", "skill"];

interface HookRow {
  id: string;
  nest_id: string;
  agent_node: string;
  preset: Preset;
  enabled: number;
  fire_count: number;
  last_fired_at: string | null;
  created_by: string;
  created_at: string;
}

function hookUrl(c: any, id: string): string {
  const base =
    config.PUBLIC_BASE_URL ||
    new URL(c.req.url).origin;
  return `${base}/hooks/${id}`;
}

function toResponse(c: any, r: HookRow, opts: { reveal?: boolean } = {}) {
  return {
    // The id doubles as the capability token, so the LIST view masks it —
    // the full URL is shown exactly once, at creation (API-key semantics).
    id: opts.reveal ? r.id : `${r.id.slice(0, 7)}…${r.id.slice(-4)}`,
    url: opts.reveal ? hookUrl(c, r.id) : null,
    agent_node: r.agent_node,
    preset: r.preset,
    enabled: !!r.enabled,
    fire_count: r.fire_count,
    last_fired_at: r.last_fired_at,
    created_by: r.created_by,
    created_at: r.created_at,
  };
}

// ─── Nest-scoped management ──────────────────────────────────────────────

export const hookNestRoutes = new Hono<AuthEnv>();
// Per-route gating (not use("*")) — see the LinearRouter note in edge-routes.

// GET /nests/:nestId/hooks[?agent=]
hookNestRoutes.get("/", requireWorkflowPlane, async (c) => {
  const nestId = c.req.param("nestId")!;
  const agent = c.req.query("agent");
  const rows = (await getDb().all(
    `SELECT * FROM trigger_hooks WHERE nest_id = ?${agent ? " AND agent_node = ?" : ""} ORDER BY created_at`,
    agent ? [nestId, agent] : [nestId],
  )) as HookRow[];
  return c.json({ count: rows.length, hooks: rows.map((r) => toResponse(c, r)) });
});

// POST /nests/:nestId/hooks { agent_node, preset }
hookNestRoutes.post("/", requireWorkflowPlane, async (c) => {
  const nestId = c.req.param("nestId")!;
  const body = await c.req.json<Record<string, unknown>>();
  const agentRaw = typeof body.agent_node === "string" ? body.agent_node.trim() : "";
  if (!agentRaw) throw new ValidationError("agent_node is required");
  const agentNode = assertSafeNodeId(agentRaw);
  const preset = String(body.preset ?? "webhook") as Preset;
  if (!PRESETS.includes(preset)) {
    throw new ValidationError(`preset must be ${PRESETS.join(" | ")}`);
  }

  const { storage } = await engineCache.get(nestId);
  let doc;
  try {
    doc = await storage.readDocument(agentNode);
  } catch {
    throw new NotFoundError(`Agent node not found: ${agentNode}`);
  }
  const t = doc.frontmatter.type || "document";
  if (!RUNNABLE_TYPES.includes(t)) {
    throw new ValidationError(`"${agentNode}" is type "${t}" — only agent/skill nodes are triggerable`);
  }

  // 128-bit random token — the capability. hk_ prefix for log greppability.
  const id = `hk_${randomUUID().replace(/-/g, "")}`;
  const now = new Date().toISOString();
  await getDb().run(
    `INSERT INTO trigger_hooks (id, nest_id, agent_node, preset, enabled, fire_count, last_fired_at, created_by, created_at)
     VALUES (?, ?, ?, ?, 1, 0, NULL, ?, ?)`,
    [id, nestId, agentNode, preset, await resolveCallerEmail(c.get("userId")), now],
  );
  const row = (await getDb().get("SELECT * FROM trigger_hooks WHERE id = ?", [id])) as HookRow;
  return c.json({ hook: toResponse(c, row, { reveal: true }) }, 201);
});

// DELETE /nests/:nestId/hooks/:id — accepts the full token OR the masked
// display form (hk_xxxx…yyyy) the list returns, so revoke works without
// ever re-exposing the capability.
hookNestRoutes.delete("/:id", requireWorkflowPlane, async (c) => {
  const nestId = c.req.param("nestId")!;
  const id = c.req.param("id")!;
  const db = getDb();
  const masked = id.match(/^(.{7})…(.{4})$/);
  const row = (await db.get(
    masked
      ? "SELECT id FROM trigger_hooks WHERE nest_id = ? AND id LIKE ? AND id LIKE ?"
      : "SELECT id FROM trigger_hooks WHERE nest_id = ? AND id = ?",
    masked ? [nestId, `${masked[1]}%`, `%${masked[2]}`] : [nestId, id],
  )) as { id: string } | undefined;
  if (!row) throw new NotFoundError("Hook not found");
  await db.run("DELETE FROM trigger_hooks WHERE id = ?", [row.id]);
  return c.json({ deleted: true });
});

// ─── Public fire endpoint ────────────────────────────────────────────────

/** Constant-time compare that tolerates length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Slack request signing (https://api.slack.com/authentication/verifying-requests). */
function slackSignatureValid(
  secret: string,
  ts: string | undefined,
  sig: string | undefined,
  rawBody: string,
): boolean {
  if (!ts || !sig) return false;
  // Replay fence: reject stamps older than 5 minutes.
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;
  const mine = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex")}`;
  return safeEqual(mine, sig);
}

/** Teams outgoing-webhook HMAC: base64 sha256 of the raw body, keyed by the
 *  base64-decoded shared secret, sent as `Authorization: HMAC <sig>`. */
function teamsSignatureValid(
  secret: string,
  authHeader: string | undefined,
  rawBody: string,
): boolean {
  if (!authHeader?.startsWith("HMAC ")) return false;
  const mine = createHmac("sha256", Buffer.from(secret, "base64"))
    .update(rawBody, "utf8")
    .digest("base64");
  return safeEqual(mine, authHeader.slice(5).trim());
}

/** Strip Slack `<@U123>` / Teams `<at>…</at>` mention markup from the ask. */
function stripMentions(text: string): string {
  return text
    .replace(/<@[^>]+>/g, "")
    .replace(/<at>[^<]*<\/at>/gi, "")
    .trim();
}

export const hookFireRoutes = new Hono<AuthEnv>();

// POST /hooks/:token — public; the token is the auth.
hookFireRoutes.post("/:token", async (c) => {
  const token = c.req.param("token")!;
  // Global fence FIRST (bounded key). The per-token bucket is only created
  // after the row is known to exist — keying a limiter on an
  // attacker-controlled string before validation would let /hooks/<random>
  // grow the bucket map without bound.
  if (!tryConsume("hook:*", { max: 120, windowMs: 60_000 })) {
    return c.json({ error: "rate limited" }, 429);
  }

  const db = getDb();
  // The nest join is the archive gate. This route mounts outside the
  // /nests/:nestId chain, so the permission cap that makes an archived nest
  // read-only never reaches it — an enabled hook would otherwise keep firing
  // agent runs against a nest that was deliberately put away, which is the one
  // thing archiving is for. Same shape as getPublishBySlug, and it folds into
  // the lookup that was already happening.
  const hook = (await db.get(
    `SELECT h.* FROM trigger_hooks h
       JOIN nests n ON n.id = h.nest_id
      WHERE h.id = ? AND h.enabled = 1 AND n.archived_at IS NULL`,
    [token],
  )) as HookRow | undefined;
  // Uniform 404 for unknown, disabled AND archived — a prober learns nothing.
  if (!hook) throw new NotFoundError("Not found");
  if (!tryConsume(`hook:${hook.id}`, { max: 30, windowMs: 60_000 })) {
    return c.json({ error: "rate limited" }, 429);
  }

  const raw = await c.req.text();
  const ct = c.req.header("content-type") || "";
  let payload: Record<string, any> = {};
  if (ct.includes("form")) {
    payload = Object.fromEntries(new URLSearchParams(raw));
  } else if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      /* webhook preset treats unparseable as empty inputs */
    }
  }

  const env = await envValues(hook.nest_id);
  let inputs: unknown = null;
  let ack: (runId: string) => Response;

  if (hook.preset === "slack") {
    // Events API handshake happens before any signature or run logic —
    // Slack sends it when you first save the endpoint URL.
    if (payload.type === "url_verification") {
      return c.json({ challenge: payload.challenge });
    }
    const secret = env.SLACK_SIGNING_SECRET;
    if (secret) {
      const ok = slackSignatureValid(
        secret,
        c.req.header("x-slack-request-timestamp"),
        c.req.header("x-slack-signature"),
        raw,
      );
      if (!ok) return c.json({ error: "bad signature" }, 401);
    }
    if (payload.type === "event_callback") {
      const ev = payload.event ?? {};
      // @agent mention in a channel. Ignore other event types quietly —
      // Slack retries non-200s, and there's nothing to do for them.
      if (ev.type !== "app_mention") return c.json({ ok: true });
      inputs = { input: stripMentions(String(ev.text ?? "")), from: ev.user, channel: ev.channel };
      ack = () => c.json({ ok: true });
    } else {
      // Slash command.
      inputs = {
        input: String(payload.text ?? "").trim(),
        from: payload.user_name,
        channel: payload.channel_name,
      };
      ack = (runId) =>
        c.json({
          response_type: "ephemeral",
          text: `⏳ Queued *${hook.agent_node}* (run ${runId.slice(0, 12)}…) — output lands for review in the nest.`,
        });
    }
  } else if (hook.preset === "teams") {
    const secret = env.TEAMS_WEBHOOK_SECRET;
    if (secret && !teamsSignatureValid(secret, c.req.header("authorization"), raw)) {
      return c.json({ error: "bad signature" }, 401);
    }
    inputs = { input: stripMentions(String(payload.text ?? "")), from: payload.from?.name };
    ack = (runId) =>
      c.json({ type: "message", text: `⏳ Queued ${hook.agent_node} (run ${runId.slice(0, 12)}…)` });
  } else {
    inputs = Object.keys(payload).length ? payload : null;
    ack = (runId) => c.json({ ok: true, run_id: runId }, 201);
  }

  // Same flood cap as manual triggers and the scheduler.
  const { n } = (await db.get(
    `SELECT COUNT(*) AS n FROM runs
      WHERE nest_id = ? AND parent_run_id IS NULL AND status = 'running'`,
    [hook.nest_id],
  )) as { n: number };
  if (n >= config.RUN_MAX_CONCURRENT_ROOTS) {
    throw new ConflictError("too many concurrent runs — try again shortly");
  }

  const runId = `run_${randomUUID()}`;
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO runs (id, nest_id, agent_node, triggered_by, status, inputs, started_at, parent_run_id, depth)
     VALUES (?, ?, ?, ?, 'running', ?, ?, NULL, 0)`,
    [
      runId,
      hook.nest_id,
      hook.agent_node,
      `hook:${hook.preset}:${hook.created_by}`,
      inputs === null ? null : JSON.stringify(inputs),
      now,
    ],
  );
  await db.run(
    "UPDATE trigger_hooks SET fire_count = fire_count + 1, last_fired_at = ? WHERE id = ?",
    [now, hook.id],
  );
  return ack(runId);
});
