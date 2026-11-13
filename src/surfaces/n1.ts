/**
 * N1 — personal (DM) nest redaction, in one place. A personal nest belongs to
 * one person; for anyone else (a server admin included) its rows lose their
 * title, conversation/source, summary, evidence and reviewer, and carry only
 * counts. Shared by the Surfaces read models (report-service), the decision
 * ledger, its export, the rollups and their MCP twins (po-1186 AC-CR-07), so
 * every surface redacts identically.
 */
import { getDb } from "../db/client.js";

export const PRIVATE_TITLE = "DM · private nest · title hidden";
export const PRIVATE_CONVERSATION = "DM · private nest";

/** Is this nest someone's personal (DM) nest, and whose? */
export async function personalOwner(nestId: string): Promise<string | null> {
  const r = (await getDb().get("SELECT community_user_id FROM surface_personal_nests WHERE nest_id = ?", [nestId])) as
    | { community_user_id: string }
    | undefined;
  return r?.community_user_id ?? null;
}

/**
 * The owner of every personal nest among `nestIds`, in one query. Nests that
 * aren't personal are absent from the map.
 */
export async function personalOwners(nestIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(nestIds)];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = (await getDb().all(
      `SELECT nest_id, community_user_id FROM surface_personal_nests WHERE nest_id IN (${chunk.map(() => "?").join(",")})`,
      chunk,
    )) as Array<{ nest_id: string; community_user_id: string }>;
    for (const r of rows) out.set(r.nest_id, r.community_user_id);
  }
  return out;
}

/** Must this viewer see the nest's rows redacted? Only its owner sees them whole. */
export function n1Redacts(owners: Map<string, string>, nestId: string, viewerUserId: string): boolean {
  const owner = owners.get(nestId);
  return !!owner && owner !== viewerUserId;
}
