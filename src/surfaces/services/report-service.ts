/**
 * Surfaces read models (S2a part): the verdict log. Counts, verdicts and
 * reasons only — window rows never hold text. Org admins see every window;
 * others see windows of bindings on nests they administer.
 */
import { getDb } from "../../db/client.js";
import { canAdministerNest, isOrgAdmin } from "./binding-service.js";

export async function listWindows(
  actorUserId: string,
  f: { bindingId?: string; verdict?: string; from?: string; to?: string; nestId?: string; limit?: number } = {},
) {
  const where: string[] = [];
  const p: string[] = [];
  if (f.bindingId) (where.push("binding_id = ?"), p.push(f.bindingId));
  if (f.verdict) (where.push("verdict = ?"), p.push(f.verdict));
  if (f.from) (where.push("created_at >= ?"), p.push(f.from));
  if (f.to) (where.push("created_at <= ?"), p.push(f.to));
  if (f.nestId) (where.push("nest_id = ?"), p.push(f.nestId));
  const rows = (await getDb().all(
    `SELECT id, binding_id, nest_id, forced, opened_at, closed_at, close_reason, message_count, status, verdict, reason_code, item_count, kinds, blocked,
            model, prompt_version, cost_micros, judged_at
       FROM surface_windows ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`,
    [...p, Math.min(Math.max(f.limit ?? 200, 1), 1000)],
  )) as Array<Record<string, any>>;
  const admin = await isOrgAdmin(actorUserId);
  const allowed = new Map<string, boolean>();
  const out = [];
  for (const r of rows) {
    if (!admin) {
      if (!allowed.has(r.nest_id)) allowed.set(r.nest_id, await canAdministerNest(r.nest_id, actorUserId));
      if (!allowed.get(r.nest_id)) continue;
    }
    out.push({ ...r, forced: !!r.forced, kinds: safe(r.kinds, []), blocked: safe(r.blocked, {}), cost_micros: Number(r.cost_micros) });
  }
  return out;
}

function safe<T>(s: unknown, d: T): T {
  try {
    return typeof s === "string" ? (JSON.parse(s) as T) : d;
  } catch {
    return d;
  }
}
