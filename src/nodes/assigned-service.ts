/**
 * "Assigned to you" for My Work (CU-wdqcq03xn2): open tasks and cards whose
 * board `assignee` is the caller, across the nests they can see.
 *
 * Served from the node_index mirror (no vault crawl). The LIKE is only a cheap
 * prefilter — frontmatter_json is plain JSON.stringify output — and every hit
 * is re-checked on the parsed metadata, then access-checked per document, so
 * a loose match can never surface someone else's card or a doc the caller
 * can't open.
 */
import { getDb } from "../db/client.js";
import { canReadNode } from "../governance/access-guard.js";
import { taskFieldsOf } from "./task-fields.js";

export interface AssignedItem {
  nest_id: string;
  nest_name: string;
  node_id: string;
  title: string;
  type: string;
  due: string | null;
  priority: string | null;
  assigned_at: string | null;
}

const MAX_ITEMS = 100;

export async function listAssignedTo(
  email: string,
  userId: string,
  nestName: Map<string, string>,
): Promise<AssignedItem[]> {
  const nestIds = [...nestName.keys()];
  if (nestIds.length === 0 || !email) return [];
  const me = email.toLowerCase();
  const rows = (await getDb().all(
    `SELECT nest_id, node_id, frontmatter_json FROM node_index
      WHERE nest_id IN (${nestIds.map(() => "?").join(",")})
        AND frontmatter_json LIKE ?`,
    [...nestIds, `%${me}%`],
  )) as Array<{ nest_id: string; node_id: string; frontmatter_json: string }>;

  const out: AssignedItem[] = [];
  for (const r of rows) {
    let fm: any;
    try {
      fm = JSON.parse(r.frontmatter_json);
    } catch {
      continue;
    }
    const f = taskFieldsOf(fm?.metadata);
    if (f.assignee !== me || f.completed_at) continue;
    if (!(await canReadNode(r.nest_id, r.node_id, userId, me))) continue;
    out.push({
      nest_id: r.nest_id,
      nest_name: nestName.get(r.nest_id) ?? r.nest_id,
      node_id: r.node_id,
      title: fm?.title != null ? String(fm.title) : r.node_id,
      type: fm?.type || "document",
      due: f.due ?? null,
      priority: f.priority ?? null,
      assigned_at: f.assigned_at ?? null,
    });
    if (out.length >= MAX_ITEMS) break;
  }
  // Overdue and soonest first (no due date last), then most recently assigned.
  return out.sort(
    (a, b) =>
      (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
      (b.assigned_at ?? "").localeCompare(a.assigned_at ?? ""),
  );
}
