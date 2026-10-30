/**
 * EffectiveReaders(nest) from the Community permission model (PRD §4.10,
 * VERIFY V8; §12 R1). Every read path in src/shared/access.ts is covered, and
 * anything that isn't a person who could sit in a conversation becomes a
 * non-user principal (fail closed):
 *
 * | Path (access.ts)                          | Principal                     |
 * |-------------------------------------------|-------------------------------|
 * | owner (step 1)                            | user (anon owner → `anon`)    |
 * | server admin (steps 2–3)                  | EXCLUDED, disclosed (§12 R1)  |
 * | nest_collaborators (step 4)               | user; service identity → key / agent |
 * | shared teams (any role)                   | user                          |
 * | active stewards                           | user (no account → absent reader) |
 * | document/folder share grants              | user                          |
 * | visibility public (org on a shared deploy)| UNIVERSE                      |
 * | visibility org (single-company deploy)    | orgWide (blocks subset rule)  |
 * | live /p publish link (link sharing)       | UNIVERSE                      |
 * | headless key while headless is on         | key                           |
 * | metacognition agent on the nest           | agent (except the listener)   |
 * | enabled outbound connector row            | connector                     |
 * | server-wide SLACK/MSTEAMS webhook         | connector                     |
 *
 * Personal API keys and MCP OAuth tokens act as their user, so they add no
 * principal (AC-GRD-04). No hosted support-access grant exists in this
 * codebase (VERIFY: none found), so `support` is never produced.
 */
import { createHash } from "crypto";
import { getDb } from "../../db/client.js";
import { config } from "../../config.js";
import { ANON_USER_ID } from "../../shared/constants.js";
import { isLicenseAdminEmail } from "../../auth/license.js";
import { isSuperAdmin } from "../../governance/access-service.js";
import { parseSharedTeams } from "../../governance/teams-service.js";
import type { ReaderSet } from "../core/guard.js";

export interface EffectiveReaders extends ReaderSet {
  /** Server admins (exempt path), for the surface_ok "can read" check. */
  serverAdmins: string[];
  /** Stable hash of everything above, for change detection (§4.17). */
  fingerprint: string;
}

export async function effectiveReaders(nestId: string, opts: { listenerAgentNodeId?: string | null } = {}): Promise<EffectiveReaders> {
  const db = getDb();
  const nest = (await db.get("SELECT user_id, visibility, shared_teams, headless FROM nests WHERE id = ?", [nestId])) as
    | { user_id: string; visibility: string; shared_teams: string | null; headless: number | null }
    | undefined;
  const users = new Set<string>();
  const nonUser: ReaderSet["nonUser"] = [];
  let universe = false;
  if (!nest) {
    // Unknown nest: nothing can be guaranteed about who reads it.
    return { users: [], nonUser: [{ kind: "anon", id: nestId }], universe: true, serverAdmins: [], fingerprint: "missing" };
  }

  // Service identities and what they are.
  const personas = new Map<string, string>(
    ((await db.all("SELECT persona_user_id, node_id FROM metacognition_agents WHERE nest_id = ?", [nestId])) as Array<{
      persona_user_id: string;
      node_id: string;
    }>).map((r) => [r.persona_user_id, r.node_id]),
  );
  const addUser = async (userId: string) => {
    if (userId === ANON_USER_ID) {
      nonUser.push({ kind: "anon", id: "anon" });
      return;
    }
    const u = (await db.get("SELECT is_service FROM users WHERE id = ?", [userId])) as { is_service: number | null } | undefined;
    if (u?.is_service) {
      const agentNode = personas.get(userId);
      if (agentNode) {
        if (agentNode !== opts.listenerAgentNodeId) nonUser.push({ kind: "agent", id: agentNode });
      } else {
        nonUser.push({ kind: "key", id: userId });
      }
      return;
    }
    users.add(userId);
  };

  // 1. owner
  await addUser(nest.user_id);
  // 4. direct collaborators
  // Role marks: a role change doesn't change WHO reads, but it changes who
  // may approve, so it must still trigger a re-check (§4.17 "role changed").
  const roles: string[] = [];
  for (const r of (await db.all("SELECT user_id, permission FROM nest_collaborators WHERE nest_id = ?", [nestId])) as Array<{
    user_id: string;
    permission: string;
  }>) {
    roles.push(`c:${r.user_id}:${r.permission}`);
    await addUser(r.user_id);
  }
  // teams shared onto the nest (every role reads). Read by userId straight
  // from the roster, as access.ts grants it — never de-duplicated by email
  // (security L2). An entry with no userId can't be in the room: absent reader.
  const teamIds = parseSharedTeams(nest.shared_teams).map((t) => t.teamId).filter(Boolean).sort();
  if (teamIds.length) {
    for (const t of (await db.all(`SELECT id, members FROM teams WHERE id IN (${teamIds.map(() => "?").join(",")}) ORDER BY id`, teamIds)) as Array<{
      id: string;
      members: string | null;
    }>) {
      roles.push(`t:${t.id}:${t.members ?? ""}`);
      let roster: Array<{ userId?: string; email?: string }> = [];
      try {
        const parsed = JSON.parse(t.members || "[]");
        roster = Array.isArray(parsed) ? parsed : [];
      } catch {
        // unreadable roster: nobody can be shown present for it
        users.add(`team:${t.id}:unreadable`);
      }
      for (const m of roster) {
        if (m && typeof m.userId === "string" && m.userId) await addUser(m.userId);
        else users.add(`team:${t.id}:${String(m?.email ?? "?").toLowerCase()}`);
      }
    }
  }
  for (const st of (await db.all("SELECT user_email, role, scope, node_pattern, tag_name FROM stewards WHERE nest_id = ? AND is_active = 1", [nestId])) as Array<
    Record<string, string | null>
  >) {
    roles.push(`s:${[st.user_email, st.role, st.scope, st.node_pattern, st.tag_name].join(":")}`);
  }
  // stewards (nest-level read); a steward with no account can't be in the room
  for (const s of (await db.all(
    `SELECT s.user_email AS email, u.id AS user_id FROM stewards s LEFT JOIN users u ON LOWER(u.email) = LOWER(s.user_email)
      WHERE s.nest_id = ? AND s.is_active = 1`,
    [nestId],
  )) as Array<{ email: string; user_id: string | null }>) {
    if (s.user_id) await addUser(s.user_id);
    else users.add(`email:${(s.email || "").toLowerCase()}`);
  }
  // document / folder share grants
  for (const g of (await db.all("SELECT user_id, target_type, target, role FROM grants WHERE nest_id = ?", [nestId])) as Array<{
    user_id: string;
    target_type: string;
    target: string;
    role: string;
  }>) {
    roles.push(`g:${g.user_id}:${g.target_type}:${g.target}:${g.role}`);
    await addUser(g.user_id);
  }
  // visibility: public is the world. org is every account on the deployment —
  // org-internal on a single-company server, but every customer on a shared
  // one, where it counts as the world.
  let orgWide = false;
  if (nest.visibility === "public") universe = true;
  if (nest.visibility === "org") {
    if (config.SHARED_DEPLOYMENT) universe = true;
    else orgWide = true;
  }
  // live per-document publish links
  const live = (await db.get(
    "SELECT 1 AS hit FROM publish WHERE nest_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
    [nestId, new Date().toISOString()],
  )) as { hit: number } | undefined;
  if (live) universe = true;
  // headless access keys read while headless publishing is on
  if (nest.headless) {
    for (const h of (await db.all("SELECT key_id FROM headless_readers WHERE nest_id = ?", [nestId])) as Array<{ key_id: string }>) {
      nonUser.push({ kind: "key", id: h.key_id });
    }
  }
  // metacognition agents configured on the nest (their persona reads it)
  for (const [, node] of personas) {
    if (node !== opts.listenerAgentNodeId && !nonUser.some((p) => p.kind === "agent" && p.id === node)) {
      nonUser.push({ kind: "agent", id: node });
    }
  }
  // outbound connectors (any event)
  for (const c of (await db.all("SELECT id FROM connectors WHERE nest_id = ? AND enabled = 1", [nestId])) as Array<{ id: string }>) {
    nonUser.push({ kind: "connector", id: c.id });
  }
  // server-wide governance webhooks post every nest's events
  if (config.SLACK_WEBHOOK_URL) nonUser.push({ kind: "connector", id: "env:SLACK_WEBHOOK_URL" });
  if (config.MSTEAMS_WEBHOOK_URL) nonUser.push({ kind: "connector", id: "env:MSTEAMS_WEBHOOK_URL" });

  // Server admins (§12 R1): only the server-admin path itself is exempt, so
  // they are never added above for being admins — but one who is ALSO the
  // owner / a collaborator / team member / steward / grantee stays a reader.
  const serverAdmins = await serverAdminIds();

  const userList = [...users].sort();
  const fp = createHash("sha256")
    .update(
      JSON.stringify({
        u: userList,
        n: nonUser.map((p) => `${p.kind}:${p.id}`).sort(),
        w: universe,
        o: orgWide,
        a: serverAdmins,
        r: roles.sort(),
        t: nest.shared_teams ?? "",
      }),
    )
    .digest("hex");
  return { users: userList, nonUser, universe, orgWide, serverAdmins, fingerprint: fp };
}

export async function serverAdminIds(): Promise<string[]> {
  const rows = (await getDb().all("SELECT id, email FROM users WHERE COALESCE(is_service, 0) = 0")) as Array<{ id: string; email: string }>;
  return rows
    .filter((r) => !!r.email && (isLicenseAdminEmail(r.email) || isSuperAdmin(r.email)))
    .map((r) => r.id)
    .sort();
}
