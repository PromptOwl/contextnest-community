/**
 * The full draft behind a card (AC-CRD-04, V18). Mounted inside the
 * authenticated /surfaces router, so an anonymous fetch is a 401 before this
 * runs; a signed-in non-reader of the nest gets 403. R2: the draft itself is
 * shown only to people who may approve that item (canUserApprove) and to
 * server admins — the same rule as S2a's pending-draft hiding; other readers
 * see "Pending review — available once approved". The page carries no
 * Open Graph / Twitter tags (nothing to unfurl), `noindex`, and the URL
 * holds only the item id — no capability token.
 */
import { getDb } from "../../db/client.js";
import { resolveNestPermission, permissionLevel } from "../../shared/access.js";
import { engineCache } from "../../nodes/engine.js";
import { canUserApprove } from "../../governance/stewardship-service.js";
import { isOrgAdmin } from "./binding-service.js";
import { personalNestRefusal, surfacesPersonalOwner } from "../draft-visibility.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#111;line-height:1.5}pre{white-space:pre-wrap;font-family:inherit}</style></head><body>${body}</body></html>`;
}

export async function draftPage(itemId: string, userId: string): Promise<{ status: 200; html: string } | { status: 403 | 404; error: string }> {
  const it = (await getDb().get("SELECT * FROM surface_proposal_items WHERE id = ?", [itemId])) as Record<string, any> | undefined;
  if (!it) return { status: 404, error: "Not found" };
  let level = 0;
  try {
    level = permissionLevel(await resolveNestPermission(it.nest_id, userId));
  } catch {
    level = 0;
  }
  if (level < permissionLevel("read")) return { status: 403, error: "Only readers of this nest can open this draft." };
  // A personal (DM) nest's drafts are its owner's alone — server admins included (Misha, 2026-11-01).
  const personal = await surfacesPersonalOwner(it.nest_id);
  if (personal && personal.userId !== userId) return { status: 403, error: personalNestRefusal(personal) };
  if (it.state !== "pending" || !it.node_id) {
    return { status: 200, html: page("Proposal", `<p>This proposal was ${esc(String(it.state))}. ${it.state === "approved" ? "It is in the nest now." : "The draft was deleted."}</p>`) };
  }
  const u = (await getDb().get("SELECT email FROM users WHERE id = ?", [userId])) as { email: string } | undefined;
  const reviewer = !!u && (await canUserApprove(it.nest_id, it.node_id, u.email).catch(() => ({ allowed: false }))).allowed;
  if (!reviewer && !(await isOrgAdmin(userId))) {
    return { status: 200, html: page("Pending review", "<p>Pending review — available once approved.</p>") };
  }
  let body = "";
  try {
    const { storage } = await engineCache.get(it.nest_id);
    const d = await storage.readDocument(it.node_id);
    body = String(d.body ?? "");
  } catch {
    return { status: 404, error: "Not found" };
  }
  return {
    status: 200,
    html: page(it.title ?? "Draft", `<p><em>Draft proposed by Nest · waiting for a reviewer · ${esc(it.target_folder)}</em></p><h1>${esc(it.title ?? "Draft")}</h1><pre>${esc(body)}</pre>`),
  };
}
