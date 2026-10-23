import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import type { Querier } from "../db/adapter.js";
import { generateApiKey, getKeyPrefix, hashApiKey } from "./keys.js";
import { parseSharedTeams } from "../governance/teams-service.js";

/**
 * Headless publishing (CU-wdqcq0314u): a private nest handed out as API-only
 * ACCESS KEYS. A key holder reads the nest's approved content through ctx /
 * MCP / the read REST routes and nothing else — no UI, no writes, no history,
 * no export, no account routes.
 *
 * Each access key belongs to its own SERVICE identity (users.is_service = 1),
 * never to the owner's account. That identity has no usable password, is never
 * listed as a person, and holds exactly one thing: a `headless_readers` row
 * naming the nest it reads. resolveNestAccess turns that row into approved-
 * content-only 'read' on that nest while the nest's `headless` switch is on —
 * so every existing read path (REST, per-nest and server-level MCP) serves the
 * key exactly what a visibility-only reader would see, with no per-route code.
 *
 * What the key may CALL is narrower than what 'read' allows (a read
 * collaborator can comment, pin, export…), so two allowlists close the rest:
 * headlessReaderVerdict for HTTP routes (enforced in the nest-scope guard,
 * ahead of every route) and HEADLESS_READER_TOOLS for MCP tools (enforced in
 * handleToolCall and in tools/list). Both are deny-by-default: a route or tool
 * added later is closed to access keys until someone adds it here on purpose.
 *
 * A commercial boundary, not a cryptographic seal: ctx needs document bodies,
 * so a key holder can read every APPROVED document one call at a time. What it
 * can never do is browse, export, see drafts or history, or write.
 */

export const HEADLESS_READER_CODE = "headless_reader";

/** MCP tools an access key may call — the reads `ctx` issues (list, get,
 *  query, search) plus the other read-only lookups. Nothing that writes,
 *  exports in bulk, reveals history/comments/governance, or runs a workflow. */
export const HEADLESS_READER_TOOLS: ReadonlySet<string> = new Set([
  "context_list",
  "context_get",
  "context_query",
  "context_search",
  "context_resolve",
  "context_overview",
  "context_table_query",
  "context_verify",
]);

/** Server-level MCP adds the grounded index (already narrowed to the key's
 *  nest by the scope filter). */
export const HEADLESS_READER_SERVER_TOOLS: ReadonlySet<string> = new Set([
  "nest_index",
  ...HEADLESS_READER_TOOLS,
]);

export function headlessToolRefusal(tool: string): string {
  return `This is a read-only access key for a published nest — "${tool}" isn't available with it. It can list, get, query and search the nest's documents.`;
}

const PUBLIC_PATHS = new Set(["/health", "/license/status", "/llms.txt", "/auth/admin-status"]);

/** Nest-level GET routes a key may read (the part after /nests/:id). Not the
 *  folder tree or the glossary: neither is approval-gated (folders are read
 *  off disk, so a draft-only folder's name would show), and ctx needs neither. */
const NEST_GET = new Set(["", "/nodes", "/search", "/context"]);
/** Nest-level POST routes that are retrieval queries, not mutations. */
const NEST_POST = new Set(["/context", "/query", "/table-query"]);
/** Node sub-resources a key may NOT read: history, discussion, governance,
 *  and the raw files behind hosted artifacts and PDFs. A node id contains
 *  slashes, so this branch has to name what it refuses —
 *  test/headless-reader-verdict.test.ts fails when a node sub-route is
 *  registered that this list doesn't cover. */
const NODE_SUBRESOURCE =
  /\/(versions(\/\d+)?|comments|annotations(\/.*)?|activity|task-log|reviews|stewards|watchers|relations|hosted|pdf|can-access|can-approve|can-edit|approvers|external-edits(\/[^/]+)?)$/;

function segmentMatches(seg: string, nestId: string): boolean {
  if (seg === nestId) return true;
  try {
    return decodeURIComponent(seg) === nestId;
  } catch {
    return false;
  }
}

/**
 * May an access key scoped to `scope` make this request? A pure function of
 * the request so the whole surface is readable (and tested) in one place.
 *
 * Known imprecision, on the safe side: a document whose slug is exactly one of
 * the sub-resource names (e.g. `nodes/comments`) can't be read over REST —
 * the path is indistinguishable from that sub-resource. `context_get` still
 * reads it.
 */
export function headlessReaderVerdict(method: string, rawPath: string, scope: string): boolean {
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
  const isGet = method === "GET" || method === "HEAD";

  if (PUBLIC_PATHS.has(path)) return isGet;
  if (path === "/mcp") return true;
  if (path === "/index" || path === "/nests") return isGet;

  const m = /^\/nests\/([^/]+)(\/.*)?$/.exec(path);
  if (!m || !segmentMatches(m[1], scope)) return false;
  const rest = m[2] ?? "";

  // The per-nest MCP transport, any method (clients probe with GET, close with
  // DELETE) — same as /mcp above. Every tool call on it is gated by
  // HEADLESS_READER_TOOLS in handleToolCall.
  if (rest === "/mcp") return true;

  if (isGet) {
    if (NEST_GET.has(rest)) return true;
    if (rest.startsWith("/nodes/")) return !NODE_SUBRESOURCE.test(rest.slice("/nodes".length));
    return false;
  }
  return method === "POST" && NEST_POST.has(rest);
}

/** Is this user an access key's service identity? */
export async function isServiceUser(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const row = (await getDb().get("SELECT is_service FROM users WHERE id = ?", [userId])) as
    | { is_service: number | null }
    | undefined;
  return !!row?.is_service;
}

/**
 * Is this a service identity that gets the headless-reader clamp — an access
 * key's identity (or a metacognition persona) — as opposed to a named SYSTEM
 * (CU-wdqcq0538g)? Systems are service identities too (no login, not a seat),
 * but they work inside their granted nests through ordinary collaborator rows,
 * so the headless allowlists must not narrow them. One definition, used by
 * every place that used to read `is_service` as "headless".
 */
export async function isHeadlessIdentity(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const row = (await getDb().get(
    `SELECT u.is_service,
            (SELECT 1 FROM system_accounts sa WHERE sa.user_id = u.id) AS is_system
       FROM users u WHERE u.id = ?`,
    [userId],
  )) as { is_service: number | null; is_system: number | null } | undefined;
  return !!row?.is_service && !row?.is_system;
}

/** Number of real people on this server/** Number of real people on this server — every account except access-key
 *  service identities. */
export async function countPeople(): Promise<number> {
  const row = (await getDb().get(
    "SELECT COUNT(*) AS c FROM users WHERE COALESCE(is_service, 0) = 0",
  )) as { c: number | string };
  return Number(row.c);
}

export interface HeadlessKeySummary {
  id: string;
  label: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
}

export async function isNestHeadless(nestId: string): Promise<boolean> {
  const row = (await getDb().get("SELECT headless FROM nests WHERE id = ?", [nestId])) as
    | { headless: number | null }
    | undefined;
  return !!row?.headless;
}

export async function listHeadlessKeys(nestId: string): Promise<HeadlessKeySummary[]> {
  return (await getDb().all(
    `SELECT k.id, hr.label, k.key_prefix, k.created_at, k.last_used_at
       FROM headless_readers hr
       JOIN api_keys k ON k.id = hr.key_id
      WHERE hr.nest_id = ?
      ORDER BY k.created_at ASC, k.id ASC`,
    [nestId],
  )) as HeadlessKeySummary[];
}

/** Mint one access key: a fresh service identity, its reader row, and a key
 *  scoped to the nest. The plaintext is returned once and never stored. */
export async function mintHeadlessKey(
  nestId: string,
  label: string,
  createdBy: string,
): Promise<{ key: HeadlessKeySummary; apiKey: string }> {
  const db = getDb();
  const serviceId = uuid();
  const keyId = uuid();
  const apiKey = generateApiKey();
  // `.invalid` is reserved (RFC 2606): no mailbox, no identity provider, so
  // nothing can ever sign in or be emailed as this address. The password hash
  // is not a hash at all, so no password can match it.
  const email = `access-key-${serviceId}@headless.invalid`;
  await db.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO users (id, email, name, password_hash, is_service) VALUES (?, ?, ?, ?, 1)",
      [serviceId, email, `Access key: ${label}`, "!"],
    );
    await tx.run(
      "INSERT INTO api_keys (id, user_id, key_hash, key_prefix, nest_id, label) VALUES (?, ?, ?, ?, ?, ?)",
      [keyId, serviceId, hashApiKey(apiKey), getKeyPrefix(apiKey), nestId, label],
    );
    await tx.run(
      "INSERT INTO headless_readers (user_id, nest_id, key_id, label, created_by) VALUES (?, ?, ?, ?, ?)",
      [serviceId, nestId, keyId, label, createdBy],
    );
  });
  const key = (await db.get(
    `SELECT k.id, hr.label, k.key_prefix, k.created_at, k.last_used_at
       FROM headless_readers hr JOIN api_keys k ON k.id = hr.key_id
      WHERE k.id = ?`,
    [keyId],
  )) as HeadlessKeySummary | undefined;
  if (!key) throw new Error("access key was not saved");
  return { key, apiKey };
}

/** Revoke one key for good: the key, its reader row and its identity. */
export async function revokeHeadlessKey(nestId: string, keyId: string): Promise<boolean> {
  const db = getDb();
  const row = (await db.get(
    "SELECT user_id FROM headless_readers WHERE nest_id = ? AND key_id = ?",
    [nestId, keyId],
  )) as { user_id: string } | undefined;
  if (!row) return false;
  // One transaction: a failure part-way must not leave a dead key's identity
  // behind (or a live key without its reader row).
  await db.transaction((tx) => removeServiceIdentities(tx, [row.user_id]));
  return true;
}

/** Every access key of a nest, gone — called inside deleteNest's transaction. */
export async function revokeAllHeadlessKeys(db: Querier, nestId: string): Promise<void> {
  const rows = (await db.all("SELECT user_id FROM headless_readers WHERE nest_id = ?", [
    nestId,
  ])) as Array<{ user_id: string }>;
  await removeServiceIdentities(db, rows.map((r) => r.user_id));
}

async function removeServiceIdentities(db: Querier, userIds: string[]): Promise<void> {
  for (const id of userIds) {
    // Explicit, not left to ON DELETE CASCADE: api_keys references users with
    // no cascade, and headless_readers only cascades where foreign_keys is on.
    await db.run("DELETE FROM headless_readers WHERE user_id = ?", [id]);
    await db.run("DELETE FROM api_keys WHERE user_id = ?", [id]);
    await db.run("DELETE FROM users WHERE id = ? AND is_service = 1", [id]);
  }
}

// ─── Owner controls, shared by REST (nests/headless-routes.ts) and MCP
//     (context_headless in mcp/tools.ts) so the two surfaces can't drift. ───

export const MAX_HEADLESS_LABEL = 80;

export type HeadlessResult<T> =
  | ({ ok: true } & T)
  | { ok: false; status: 400 | 404 | 409; error: string };

/** Who keeps access regardless of headless — counted so the owner sees it
 *  before publishing. */
export async function headlessSharedWith(nestId: string) {
  const db = getDb();
  const count = async (sql: string) =>
    Number(((await db.get(sql, [nestId])) as { c: number | string }).c);
  const row = (await db.get("SELECT shared_teams FROM nests WHERE id = ?", [nestId])) as
    | { shared_teams: string | null }
    | undefined;
  return {
    collaborators: await count("SELECT COUNT(*) AS c FROM nest_collaborators WHERE nest_id = ?"),
    teams: parseSharedTeams(row?.shared_teams ?? null).length,
    grants: await count("SELECT COUNT(DISTINCT user_id) AS c FROM grants WHERE nest_id = ?"),
  };
}

/** Publish API-only (enabled) or stop (pauses every key). Only a private nest
 *  can be headless: an org or public nest is already readable by people
 *  without a key, which is the opposite of the promise. */
export async function setNestHeadless(
  nestId: string,
  enabled: unknown,
): Promise<HeadlessResult<{ enabled: boolean }>> {
  if (typeof enabled !== "boolean") {
    return { ok: false, status: 400, error: "enabled must be a boolean" };
  }
  const db = getDb();
  const nest = (await db.get("SELECT visibility FROM nests WHERE id = ?", [nestId])) as
    | { visibility: string }
    | undefined;
  if (!nest) return { ok: false, status: 404, error: "Nest not found" };
  if (enabled && nest.visibility !== "private") {
    return {
      ok: false,
      status: 409,
      error: `Only a private nest can be published API-only — this one is ${nest.visibility}. Make it private first.`,
    };
  }
  // Conditional on still being private, so a visibility change racing this
  // request can't leave a nest both public and headless.
  const res = enabled
    ? await db.run("UPDATE nests SET headless = 1 WHERE id = ? AND visibility = 'private'", [nestId])
    : await db.run("UPDATE nests SET headless = 0 WHERE id = ?", [nestId]);
  if (enabled && res.changes === 0) {
    return { ok: false, status: 409, error: "The nest is no longer private — make it private first." };
  }
  return { ok: true, enabled };
}

/** Validate a label and mint one access key on a headless nest. */
export async function createHeadlessKey(
  nestId: string,
  rawLabel: unknown,
  createdBy: string,
): Promise<HeadlessResult<{ key: HeadlessKeySummary; apiKey: string }>> {
  const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
  if (!label) {
    return {
      ok: false,
      status: 400,
      error: "label is required — name who the key is for (e.g. the buyer)",
    };
  }
  if (label.length > MAX_HEADLESS_LABEL) {
    return { ok: false, status: 400, error: `label must be ${MAX_HEADLESS_LABEL} characters or fewer` };
  }
  if (!(await isNestHeadless(nestId))) {
    return {
      ok: false,
      status: 409,
      error: "Publish this nest API-only first — access keys only work on a headless nest.",
    };
  }
  const { key, apiKey } = await mintHeadlessKey(nestId, label, createdBy);
  return { ok: true, key, apiKey };
}
