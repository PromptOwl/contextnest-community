import { createMiddleware } from "hono/factory";
import { getDb } from "../db/client.js";
import { hashApiKey, parseBearerToken } from "./keys.js";
import { getSessionIdFromRequest, resolveSession } from "./sessions.js";

import { HEADLESS_READER_CODE, headlessReaderVerdict } from "./headless.js";
import type { AuthEnv } from "./middleware.js";
import { config } from "../config.js";
import { tryConsume, retryAfterSeconds } from "../shared/rate-limit.js";

/**
 * Nest-scoped API keys are a boundary, not a speed bump.
 *
 * A key minted with `nest_id` is what someone hands an agent that should see
 * ONE nest. Outside that nest it is deny-by-default: this guard runs on every
 * request, ahead of every route's own auth, and lets a nest key through only to
 * the short allowlist below. Everything else — /auth/keys above all, or the key
 * could mint itself a whole-account key — gets a 403 with
 * `code: "nest_scoped_key"`. A route added later is closed to nest keys until
 * someone adds it here on purpose.
 *
 * Checked centrally rather than per route because several routes resolve the
 * caller themselves (the admin routes in auth/routes.ts read the bearer key
 * directly, never setting `nestScope`), so a per-route check would have to be
 * remembered in every one of them.
 *
 * Sessions and user-level keys are untouched: the guard only acts when the
 * bearer key carries a nest_id AND no valid session cookie came with it (the
 * cookie wins in authMiddleware, so it wins here too).
 */

export const NEST_SCOPED_KEY_CODE = "nest_scoped_key";

/** Public or self-describing routes a nest key may call with no nest filter —
 *  they expose nothing account-wide. */
const PUBLIC_PATHS = new Set([
  "/health",
  "/livez",
  "/readyz",
  "/license/status",
  "/llms.txt",
  "/auth/admin-status",
]);

function segmentMatches(seg: string, nestId: string): boolean {
  if (seg === nestId) return true;
  try {
    return decodeURIComponent(seg) === nestId;
  } catch {
    return false;
  }
}

export type NestKeyVerdict =
  | { allowed: true }
  | { allowed: false; reason: "other_nest"; mcpTransport: boolean }
  | { allowed: false; reason: "outside_nest" };

/**
 * The allowlist, as a pure function of the request so it can be unit-tested and
 * read in one place. `scope` is the key's nest id.
 */
export function nestKeyVerdict(
  method: string,
  rawPath: string,
  scope: string,
): NestKeyVerdict {
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
  const isGet = method === "GET" || method === "HEAD";

  if (PUBLIC_PATHS.has(path) && isGet) return { allowed: true };

  // Agent entry points — already filtered to the key's nest (buildNestIndex).
  if (path === "/mcp") return { allowed: true };
  if (path === "/index" && isGet) return { allowed: true };

  // Read-only cross-nest views — each narrows itself to the key's nest.
  if ((path === "/search" || path === "/stats" || path === "/nests") && isGet) {
    return { allowed: true };
  }

  // Run detail routes — every handler checks the run's nest against the scope
  // (loadRunWithPermission in workflow/run-routes.ts).
  if (path.startsWith("/runs/")) return { allowed: true };

  // Agent control room reads (po-1186) — each narrows itself to the key's
  // nest (orgScope keyNestScope; the trace re-checks the entry's nest).
  if ((path === "/ledger" || path.startsWith("/ledger/") || path === "/rollups") && isGet) {
    return { allowed: true };
  }

  // The key's own nest, every sub-route. The nests-app gate still applies the
  // owner's permission on top.
  const m = /^\/nests\/([^/]+)(\/.*)?$/.exec(path);
  if (m) {
    if (segmentMatches(m[1], scope)) return { allowed: true };
    return {
      allowed: false,
      reason: "other_nest",
      mcpTransport: m[2] === "/mcp",
    };
  }

  return { allowed: false, reason: "outside_nest" };
}

export const SYSTEM_KEY_CODE = "system_key";

/**
 * Where a named SYSTEM's key (CU-wdqcq0538g) may go at all. A system works
 * inside the nests it was granted (each gated by its collaborator row in the
 * nests-app gate, which also keeps it off the nest's people/settings/key
 * routes) and on the server-level /mcp, where nest_create is refused. It never
 * reaches /auth/* (no key minting, no password, no sessions), /systems,
 * /admin, /me, /teams, /search or /index, and never creates, edits or deletes
 * a nest itself. Pure, like the other verdicts, so it reads in one place.
 */
export function systemKeyVerdict(method: string, rawPath: string): boolean {
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
  const isGet = method === "GET" || method === "HEAD";
  if (PUBLIC_PATHS.has(path)) return isGet;
  if (path === "/mcp" || path.startsWith("/mcp/")) return true;
  if (path === "/nests") return isGet;
  const m = /^\/nests\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) return false;
  // The nest itself (GET /nests/:id): read only — no PATCH/DELETE of the nest.
  if (!m[2]) return isGet;
  return true;
}

type KeyScope =
  | { kind: "nest"; scope: string; headless: false; keyId: string }
  | { kind: "headless"; scope: string; headless: true; keyId: string }
  | { kind: "system"; keyId: string };

/** Look up the nest a bearer key is scoped to, and whether it is a headless
 *  access key. null = no key, unknown key, or a user-level key — in every one
 *  of those cases the guard has nothing to say. */
async function bearerKeyScope(
  authorization: string | undefined,
): Promise<KeyScope | null> {
  const key = parseBearerToken(authorization);
  if (!key) return null;
  const row = (await getDb().get(
    `SELECT k.id, k.nest_id, u.is_service,
            (SELECT 1 FROM system_accounts sa WHERE sa.user_id = k.user_id) AS is_system
       FROM api_keys k LEFT JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = ?`,
    [hashApiKey(key)],
  )) as
    | { id: string; nest_id: string | null; is_service: number | null; is_system: number | null }
    | undefined;
  if (!row) return null;
  // A named system (CU-wdqcq0538g) is a service identity too, but NOT a
  // headless reader: it gets its own fence, never the headless allowlist.
  if (row.is_system) return { kind: "system", keyId: row.id };
  // A service identity's key is ALWAYS a headless access key — even if its
  // nest scope were somehow lost, it must fail closed (empty scope matches no
  // nest), never fall back to acting as an ordinary user-level key.
  if (row.is_service) {
    return { kind: "headless", scope: row.nest_id ?? "", headless: true, keyId: row.id };
  }
  if (!row.nest_id) return null;
  return { kind: "nest", scope: row.nest_id, headless: false, keyId: row.id };
}

export const nestScopedKeyGuard = createMiddleware<AuthEnv>(async (c, next) => {
  const found = await bearerKeyScope(c.req.header("Authorization"));
  if (!found) return next();

  // A named system key: its own fence, and no session escape hatch either —
  // a system can't sign in, so a cookie riding along must not widen it.
  if (found.kind === "system") {
    if (systemKeyVerdict(c.req.method, c.req.path)) return next();
    return c.json(
      {
        error:
          "A system key can only work inside the nests it was granted. It cannot sign in, mint keys, or manage the server.",
        code: SYSTEM_KEY_CODE,
      },
      403,
    );
  }
  const { scope } = found;

  // A headless access key (CU-wdqcq0314u) gets the narrower read-only
  // allowlist, and no session escape hatch: its identity can't sign in, so a
  // cookie riding along belongs to someone else and must not widen the key.
  if (found.headless) {
    if (headlessReaderVerdict(c.req.method, c.req.path, scope)) {
      // Per-key rate limit (CU-wdqcq0538g): access keys go to outside parties
      // by design, so this keeps one from becoming an unmetered scraping
      // endpoint. Counted only for requests the key may make at all.
      const rl = { max: config.HEADLESS_KEY_RATE_LIMIT_PER_MIN, windowMs: 60_000 };
      const bucket = `headless-key:${found.keyId}`;
      if (!tryConsume(bucket, rl)) {
        c.header("Retry-After", String(retryAfterSeconds(bucket, rl)));
        return c.json(
          {
            error: "Rate limit exceeded for this access key. Retry later.",
            code: "rate_limited",
          },
          429,
        );
      }
      return next();
    }
    return c.json(
      {
        error:
          "This is a read-only access key for a published nest. It can list, get, query and search that nest's documents (over MCP or the read API) — nothing else.",
        code: HEADLESS_READER_CODE,
      },
      403,
    );
  }

  const verdict = nestKeyVerdict(c.req.method, c.req.path, scope);
  if (verdict.allowed) return next();

  // Cookie wins over the bearer in authMiddleware — a signed-in browser that
  // also carries a nest key is a session caller, not a nest key.
  const sessionId = getSessionIdFromRequest(c);
  if (sessionId && (await resolveSession(sessionId))) return next();

  if (verdict.reason === "other_nest") {
    const error = `API key not authorized for this nest — this key is scoped to nest "${scope}". Use that nest's MCP URL, or mint a user-level key in the Connect dialog.`;
    if (verdict.mcpTransport) {
      // MCP clients only display a JSON-RPC error's message; a bare {error}
      // body shows up as a generic connection failure.
      let id: string | number | null = null;
      try {
        id = (await c.req.json())?.id ?? null;
      } catch {
        /* unparseable body — id stays null */
      }
      return c.json(
        { jsonrpc: "2.0", id, error: { code: -32000, message: error } },
        403,
      );
    }
    return c.json({ error, code: NEST_SCOPED_KEY_CODE }, 403);
  }

  return c.json(
    {
      error:
        "This API key is scoped to one nest and can't reach account-wide or server-wide routes (API keys, admin, teams, people, your inbox). Use a key for all your nests for those.",
      code: NEST_SCOPED_KEY_CODE,
    },
    403,
  );
});
