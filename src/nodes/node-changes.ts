/**
 * Who moved a document, and who changed its tags (po-1400). A move seals no
 * version and a retag's version does not say which tags, so both are recorded
 * here. Server-written only: unlike a task log note, nobody can type one.
 *
 * Keyed to the node (NODE_KEYED_TABLES): a move carries the history along, a
 * delete purges it.
 */
import { v4 as uuid } from "uuid";
import type { DatabaseAdapter } from "../db/adapter.js";
import { getDb } from "../db/client.js";
import { deserializeClient, serializeClient, type ClientMetadata } from "../shared/client-metadata.js";
import { TICKET_NAMESPACE } from "./task-rules.js";

export type NodeChangeKind = "moved" | "tags_changed";

export interface NodeChange {
  id: string;
  nodeId: string;
  kind: NodeChangeKind;
  actor: string;
  detail: string;
  client?: ClientMetadata;
  at: string;
}

export async function recordNodeChange(
  db: Pick<DatabaseAdapter, "run">,
  c: { nestId: string; nodeId: string; kind: NodeChangeKind; actor: string; detail: string; client?: ClientMetadata },
): Promise<void> {
  await db.run(
    `INSERT INTO node_changes (id, nest_id, node_id, kind, actor, detail, client_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), c.nestId, c.nodeId, c.kind, c.actor, c.detail, serializeClient(c.client), new Date().toISOString()],
  );
}

/** "nodes/a/b/doc" → "a/b"; the nest root reads as "(root)". */
const folderLabel = (id: string): string => id.split("/").slice(0, -1).join("/").replace(/^nodes\/?/, "") || "(root)";

export const moveDetail = (fromId: string, toId: string): string => `${folderLabel(fromId)} → ${folderLabel(toId)}`;

/**
 * What changed between two tag sets, or null: "stage:backlog → stage:done"
 * when one tag took the place of another in its group, "+x" and "−x" for the
 * rest. The server-assigned ticket number is not a person's change.
 */
export function tagChangeDetail(before: readonly string[], after: readonly string[]): string | null {
  const bare = (t: string) => t.trim().replace(/^#+/, "");
  const kept = (tags: readonly string[]) =>
    new Map(
      tags
        .map(bare)
        .filter((t) => t && !t.toLowerCase().startsWith(`${TICKET_NAMESPACE}:`))
        .map((t) => [t.toLowerCase(), t]),
    );
  const from = kept(before);
  const to = kept(after);
  const removed = [...from].filter(([k]) => !to.has(k)).map(([, t]) => t);
  const added = [...to].filter(([k]) => !from.has(k)).map(([, t]) => t);
  if (!removed.length && !added.length) return null;
  const group = (t: string) => (t.includes(":") ? t.slice(0, t.indexOf(":")).toLowerCase() : null);
  const parts: string[] = [];
  for (const r of removed) {
    const i = group(r) === null ? -1 : added.findIndex((a) => group(a) === group(r));
    if (i === -1) parts.push(`−${r}`);
    else parts.push(`${r} → ${added.splice(i, 1)[0]}`);
  }
  return [...parts, ...added.map((a) => `+${a}`)].join(", ");
}

export async function listNodeChanges(params: { nestId: string; nodeId?: string; limit: number }): Promise<NodeChange[]> {
  const rows = (await getDb().all(
    `SELECT id, node_id, kind, actor, detail, client_json, created_at FROM node_changes
      WHERE nest_id = ?${params.nodeId ? " AND node_id = ?" : ""}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    params.nodeId ? [params.nestId, params.nodeId, params.limit] : [params.nestId, params.limit],
  )) as any[];
  return rows.map((r) => {
    const client = deserializeClient(r.client_json);
    return {
      id: r.id,
      nodeId: r.node_id,
      kind: r.kind,
      actor: r.actor,
      detail: r.detail,
      ...(client ? { client } : {}),
      at: r.created_at,
    };
  });
}
