import { createMiddleware } from "hono/factory";
import { getDb } from "../db/client.js";
import { hashApiKey, parseBearerToken } from "./keys.js";
import { getSessionIdFromRequest, resolveSession } from "./sessions.js";

import { HEADLESS_READER_CODE, headlessReaderVerdict } from "./headless.js";

import type { AuthEnv } from "./middleware.js";

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

/** Look up the nest a bearer key is scoped to, and whether it is a headless
 *  access key. null = no key, unknown key, or a user-level key — in every one
 *  of those cases the guard has nothing to say. */
async function bearerKeyScope(
  authorization: string | undefined,
): Promise<{ scope: string; headless: boolean } | null> {
  const key = parseBearerToken(authorization);
  if (!key) return null;
  const row = (await getDb().get(
    `SELECT k.nest_id, u.is_service
       FROM api_keys k LEFT JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = ?`,
    [hashApiKey(key)],
  )) as { nest_id: string | null; is_service: number | null } | undefined;
  if (!row?.nest_id) return null;
  return { scope: row.nest_id, headless: !!row.is_service };
}

export const nestScopedKeyGuard = createMiddleware<AuthEnv>(async (c, next) => {
  const found = await bearerKeyScope(c.req.header("Authorization"));
  if (!found) return next();
  const { scope } = found;

  // A headless access key (CU-wdqcq0314u) gets the narrower read-only
  // allowlist, and no session escape hatch: its identity can't sign in, so a
  // cookie riding along belongs to someone else and must not widen the key.
  if (found.headless) {
    if (headlessReaderVerdict(c.req.method, c.req.path, scope)) return next();
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
