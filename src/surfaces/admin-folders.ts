/**
 * A seed's `admin_only` folders (PRD §13, S7-R2 L4), enforced on EVERY commit
 * path — the web review queue and REST approve, MCP `context_approve`,
 * approve-with-edits, Slack — through canUserApprove(Many) and approve(), and
 * on direct writes (createNode / updateNode): only nest owners/admins may
 * approve or write documents in them.
 *
 * The folders are read from the NEST's seed applications, not from a binding's
 * listener, so a missing listener can't open them. Dependency-light (the
 * governance and node layers import it). Fails CLOSED: any lookup error other
 * than the Surfaces tables being absent treats every document as admin-only
 * for that call (non-admins are refused). Logs counts only.
 */
import { getDb } from "../db/client.js";

/** Tests only. */
export const adminFolderTestHooks: { failLookup?: boolean; failWith?: string } = {};

/** Only THIS table missing means "no seeds yet" (SQLite and Postgres wording). Anything else fails closed. */
const MISSING_TABLE = /no such table: surface_seed_applications\b|relation "surface_seed_applications" does not exist/i;

export const ADMIN_FOLDER_REFUSAL = "Only admins of this nest can approve or write documents in that folder.";

type Folders = string[] | "unknown";

async function adminFolders(nestId: string): Promise<Folders> {
  try {
    if (adminFolderTestHooks.failLookup) throw new Error("injected lookup failure");
    if (adminFolderTestHooks.failWith) throw new Error(adminFolderTestHooks.failWith);
    const rows = (await getDb().all("SELECT listener_json FROM surface_seed_applications WHERE nest_id = ?", [nestId])) as Array<{ listener_json: string }>;
    const out = new Set<string>();
    for (const r of rows) {
      const l = JSON.parse(r.listener_json) as { admin_folders?: unknown };
      if (l.admin_folders !== undefined && !Array.isArray(l.admin_folders)) return "unknown";
      for (const f of (l.admin_folders as unknown[] | undefined) ?? []) {
        if (typeof f !== "string") return "unknown";
        out.add(f);
      }
    }
    return [...out];
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (MISSING_TABLE.test(msg)) return [];
    console.error("[surfaces] admin-folder lookup failed; failing closed (1)");
    return "unknown";
  }
}

/** Is this node inside one of the nest's admin-only folders? ("unknown" = can't tell.) */
export async function inAdminFolder(nestId: string, nodeId: string): Promise<boolean | "unknown"> {
  const folders = await adminFolders(nestId);
  if (folders === "unknown") return "unknown";
  if (!folders.length) return false;
  const rel = nodeId.replace(/^nodes\//, "");
  return folders.some((f) => rel.startsWith(f));
}

async function isNestAdmin(nestId: string, userEmail: string): Promise<boolean> {
  const u = (await getDb().get("SELECT id FROM users WHERE LOWER(email) = LOWER(?)", [userEmail])) as { id: string } | undefined;
  if (!u) return false;
  const { resolveNestPermission, permissionLevel } = await import("../shared/access.js");
  try {
    return permissionLevel(await resolveNestPermission(nestId, u.id)) >= permissionLevel("admin");
  } catch {
    return false;
  }
}

/** null when this user may act on this node; otherwise the refusal text. */
export async function adminFolderRefusal(nestId: string, nodeId: string, userEmail: string): Promise<string | null> {
  const inside = await inAdminFolder(nestId, nodeId);
  if (inside === false) return null;
  return (await isNestAdmin(nestId, userEmail)) ? null : ADMIN_FOLDER_REFUSAL;
}

/**
 * The same verdict for many documents of one nest in a fixed number of
 * queries (one folder lookup, at most one admin check): canUserApproveMany
 * stays O(1) in queries. Returns the refused node ids.
 */
export async function adminFolderRefusedMany(nestId: string, nodeIds: string[], userEmail: string): Promise<Set<string>> {
  const folders = await adminFolders(nestId);
  if (folders !== "unknown" && !folders.length) return new Set();
  const inside = nodeIds.filter((id) => folders === "unknown" || folders.some((f) => id.replace(/^nodes\//, "").startsWith(f)));
  if (!inside.length) return new Set();
  return (await isNestAdmin(nestId, userEmail)) ? new Set() : new Set(inside);
}

/**
 * Folder moves and renames (S7-R3 R2-L3): refused for non-admins when the
 * source or the destination folder IS, is INSIDE, or CONTAINS an admin-only
 * folder. Paths are content-relative (e.g. "a" or "a/b"), without "nodes/".
 */
export async function adminFolderPathRefusal(nestId: string, folderPaths: string[], userEmail: string): Promise<string | null> {
  const folders = await adminFolders(nestId);
  if (folders !== "unknown" && !folders.length) return null;
  const touches = (p: string) => {
    const dir = `${p.replace(/^nodes\//, "").replace(/^\/+|\/+$/g, "")}/`;
    return folders === "unknown" || folders.some((f) => dir.startsWith(f) || f.startsWith(dir));
  };
  if (!folderPaths.some(touches)) return null;
  return (await isNestAdmin(nestId, userEmail)) ? null : ADMIN_FOLDER_REFUSAL;
}
