/**
 * Task activity log — the simple way for an agent (or a person) to say what
 * it did on a task: "working on it", "done", "blocked: waiting on keys".
 *
 * One row per call to MCP `context_task_log`, REST POST
 * /nests/:id/nodes/:nodeId/task-log, or `ctx task log`. Every row is attributed
 * to the authenticated user — an agent always acts ON BEHALF of somebody, and
 * that somebody is who the key belongs to. A call made on an API key also
 * records which key (label + prefix, and whether it was scoped to this nest),
 * and the caller's §9.4 `client` block (the agent name, a session) rides along
 * exactly as it does on node_versions. Like `client` everywhere else, those are
 * labels, never identity: nothing here grants or gates anything.
 *
 * Deliberately NOT a document write: no version, no hash chain, no review. It
 * is collaboration metadata alongside the node, like a comment.
 */
import { v4 as uuid } from "uuid";
import { getDb } from "../db/client.js";
import { ValidationError } from "../shared/errors.js";
import {
  deserializeClient,
  serializeClient,
  type ClientMetadata,
} from "../shared/client-metadata.js";

export const TASK_LOG_STATUSES = ["working", "done", "blocked"] as const;
export type TaskLogStatus = (typeof TASK_LOG_STATUSES)[number];

/** Long enough for a paragraph; short enough that a runaway agent can't
 *  stuff a document into the timeline. */
export const TASK_LOG_NOTE_MAX = 2000;

export interface TaskActivityKey {
  label?: string;
  prefix?: string;
  /** The key is scoped to this one nest (a "scoped key"), not account-wide. */
  scoped: boolean;
}

export interface TaskActivity {
  id: string;
  nodeId: string;
  /** Email of the user the call authenticated as. */
  actor: string;
  status?: TaskLogStatus;
  note: string;
  surface: "mcp" | "api";
  /** Present when the call came in on an API key. */
  key?: TaskActivityKey;
  /** The caller's §9.4 attribution — `agent`, `session_id`, custom keys. */
  client?: ClientMetadata;
  at: string;
}

/** Validate the caller's input once; shared by MCP and REST. */
export function parseTaskLogInput(raw: {
  note?: unknown;
  status?: unknown;
}): { note: string; status?: TaskLogStatus } {
  if (typeof raw.note !== "string" || !raw.note.trim()) {
    throw new ValidationError("note is required — say what was done");
  }
  const note = raw.note.trim();
  if (note.length > TASK_LOG_NOTE_MAX) {
    throw new ValidationError(`note is too long (max ${TASK_LOG_NOTE_MAX} characters)`);
  }
  let status: TaskLogStatus | undefined;
  if (raw.status !== undefined && raw.status !== null && raw.status !== "") {
    if (
      typeof raw.status !== "string" ||
      !(TASK_LOG_STATUSES as readonly string[]).includes(raw.status)
    ) {
      throw new ValidationError(
        `status must be one of ${TASK_LOG_STATUSES.join(", ")}, got "${String(raw.status)}"`,
      );
    }
    status = raw.status as TaskLogStatus;
  }
  return { note, ...(status ? { status } : {}) };
}

export async function recordTaskActivity(params: {
  nestId: string;
  nodeId: string;
  actor: string;
  userId?: string | null;
  note: string;
  status?: TaskLogStatus;
  surface: "mcp" | "api";
  apiKeyId?: string | null;
  client?: ClientMetadata;
}): Promise<TaskActivity> {
  const db = getDb();
  // The key's label/prefix/scope are read from the key row itself, not from
  // anything the caller sent — the one part of the attribution that is fact.
  let key: TaskActivityKey | undefined;
  if (params.apiKeyId) {
    const row = (await db.get(
      "SELECT label, key_prefix, nest_id FROM api_keys WHERE id = ?",
      [params.apiKeyId],
    )) as { label: string | null; key_prefix: string | null; nest_id: string | null } | undefined;
    if (row) {
      key = {
        ...(row.label ? { label: row.label } : {}),
        ...(row.key_prefix ? { prefix: row.key_prefix } : {}),
        scoped: row.nest_id === params.nestId,
      };
    }
  }
  const id = uuid();
  await db.run(
    `INSERT INTO task_activity
       (id, nest_id, node_id, actor, user_id, status, note, surface,
        api_key_id, api_key_label, api_key_prefix, key_scoped, client_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.nestId,
      params.nodeId,
      params.actor,
      params.userId ?? null,
      params.status ?? null,
      params.note,
      params.surface,
      params.apiKeyId ?? null,
      key?.label ?? null,
      key?.prefix ?? null,
      key?.scoped ? 1 : 0,
      serializeClient(params.client),
      // Millisecond ISO, stamped here: an agent logging "working" then "done"
      // in the same second must still read back in order, on either dialect.
      new Date().toISOString(),
    ],
  );
  const row = await db.get("SELECT * FROM task_activity WHERE id = ?", [id]);
  return rowToActivity(row);
}

export async function listTaskActivity(params: {
  nestId: string;
  nodeId?: string;
  limit?: number;
}): Promise<TaskActivity[]> {
  const db = getDb();
  const limit =
    Number.isFinite(params.limit) && (params.limit as number) > 0
      ? Math.min(params.limit as number, 1000)
      : 100;
  const rows = (await db.all(
    `SELECT * FROM task_activity
      WHERE nest_id = ?${params.nodeId ? " AND node_id = ?" : ""}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    params.nodeId ? [params.nestId, params.nodeId, limit] : [params.nestId, limit],
  )) as any[];
  return rows.map(rowToActivity);
}

/**
 * One line for a person: "Claude Code (key ctx CLI (laptop)) on behalf of
 * misha@x · working · picked it up". The agent is the §9.4 `client.agent`;
 * when it is only the key label echoed back (that is what a key with no
 * handshake derives), the key is named once, not twice.
 */
export function describeTaskActivity(a: Pick<TaskActivity, "actor" | "status" | "note" | "key" | "client">): string {
  const agent = typeof a.client?.agent === "string" ? a.client.agent : undefined;
  const keyLabel = a.key ? a.key.label || a.key.prefix : undefined;
  let who: string;
  if (agent && keyLabel && agent !== keyLabel) who = `${agent} (key ${keyLabel}) on behalf of ${a.actor}`;
  else if (agent || keyLabel) who = `${agent || keyLabel} on behalf of ${a.actor}`;
  else who = a.actor;
  return [who, a.status, a.note].filter(Boolean).join(" · ");
}

function rowToActivity(r: any): TaskActivity {
  const key: TaskActivityKey | undefined = r.api_key_id
    ? {
        ...(r.api_key_label ? { label: r.api_key_label } : {}),
        ...(r.api_key_prefix ? { prefix: r.api_key_prefix } : {}),
        scoped: !!r.key_scoped,
      }
    : undefined;
  const client = deserializeClient(r.client_json);
  return {
    id: r.id,
    nodeId: r.node_id,
    actor: r.actor,
    ...(r.status ? { status: r.status } : {}),
    note: r.note,
    surface: r.surface,
    ...(key ? { key } : {}),
    ...(client ? { client } : {}),
    at: r.created_at,
  };
}
