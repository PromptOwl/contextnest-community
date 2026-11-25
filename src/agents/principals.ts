/**
 * Agent principals (epic recipes-and-the-central-harness): a hired agent is
 * its own identity in the nest, so any member can DM it or @mention it and the
 * agent reads that conversation with ITS key, not with the key of whoever
 * hired it.
 *
 * ── Built on what exists, no new table ────────────────────────────────────
 * An agent principal is a `users` row with is_service = 1 — the same no-login
 * SERVICE identity a named system (auth/systems.ts), a headless access key or
 * a metacognition persona uses, so every "people only" rule applies for free:
 * no password, no session, no OIDC / SSO / PromptOwl sign-in, not a seat, not
 * in people lists or search. What it holds, all in existing stores:
 *
 *   users              is_service = 1, name = its display name, and an
 *                      address under the reserved `agent.contextnest.invalid`
 *                      domain that names its handle and its ONE nest:
 *                      `<handle>.<nestId>@agent.contextnest.invalid`
 *                      (RFC 2606: unroutable, no identity provider can assert
 *                      it). Kind, handle and home nest are read from it.
 *   nest_collaborators one row on its home nest, 'write' (an editor).
 *   api_keys           one nest-scoped write key owned by the principal.
 *   hired_agents       the C10 hire marker (kind 'key') naming that key; its
 *                      `hired_by` is the OWNER: the person who hired it.
 *   agent_webhooks     optionally, its wake target (same handle).
 *
 * Letting it go deletes the key, the collaborator row and the marker; the
 * users row stays (no key, no access) so a re-hire of the handle REUSES the
 * identity and what it wrote stays attributed to the same principal.
 *
 * ── Fences (what makes it safe) ───────────────────────────────────────────
 *  - resolveNestAccess clamps it: at most 'write', on its home nest only —
 *    never owner/admin, never through a team, a steward row or visibility,
 *    never on another nest, whatever rows say (shared/access.ts).
 *  - It never approves or rejects a review (stewardship-service
 *    canUserApprove): the gate is a person's.
 *  - It is never added as a collaborator, nor promoted (sharing routes).
 *  - Its key is an ordinary nest-scoped key (nest-scope-guard), so it can't
 *    reach /auth/*, mint keys, or touch another nest; it is not a headless
 *    reader (isHeadlessIdentity).
 *  - A person who registers the principal's address first is just a person:
 *    only is_service rows count, and the hire refuses to adopt the address.
 *
 * A conversation or private channel counts it as a member when the container
 * carries its `agent:<handle>` tag (chat/containers.ts) — the existing agent
 * member mechanism, now resolvable to an identity.
 *
 * This file is a leaf (the db client only): access.ts and containers.ts
 * import it on hot paths.
 */
import { getDb } from "../db/client.js";

export const AGENT_PRINCIPAL_DOMAIN = "agent.contextnest.invalid";
const HANDLE = "[a-z0-9][a-z0-9._-]{0,62}";
const UUIDISH = "[0-9a-z][0-9a-z-]{7,63}";
const EMAIL_RE = new RegExp(`^(${HANDLE})\\.(${UUIDISH})@agent\\.contextnest\\.invalid$`);

/** The principal's address for (nest, handle). Deterministic, so a re-hire finds it. */
export function agentPrincipalEmail(nestId: string, handle: string): string {
  return `${handle}.${nestId}@${AGENT_PRINCIPAL_DOMAIN}`.toLowerCase();
}

/** Handle and home nest from a principal address; null for any other address.
 *  The nest id never holds a dot, so the LAST dot before the @ splits them. */
export function parseAgentPrincipalEmail(email: string | null | undefined): { handle: string; nestId: string } | null {
  if (!email) return null;
  const m = EMAIL_RE.exec(String(email).trim().toLowerCase());
  return m ? { handle: m[1], nestId: m[2] } : null;
}

export interface AgentPrincipal {
  id: string;
  email: string;
  handle: string;
  /** Its home nest: the only nest it ever reaches. */
  nestId: string;
  name: string;
}

/** The agent principal behind this user id, or null for a person or any
 *  other service identity. Only an is_service row with a principal address. */
export async function agentPrincipalOf(userId: string | null | undefined): Promise<AgentPrincipal | null> {
  if (!userId) return null;
  const row = (await getDb().get("SELECT id, email, name, is_service FROM users WHERE id = ?", [userId])) as
    | { id: string; email: string; name: string | null; is_service: number | null }
    | undefined;
  return principalFromRow(row);
}

/** By address (an approver's email, a message author). */
export async function agentPrincipalByEmail(email: string | null | undefined): Promise<AgentPrincipal | null> {
  if (!parseAgentPrincipalEmail(email)) return null;
  const row = (await getDb().get("SELECT id, email, name, is_service FROM users WHERE LOWER(email) = LOWER(?)", [String(email)])) as
    | { id: string; email: string; name: string | null; is_service: number | null }
    | undefined;
  return principalFromRow(row);
}

export async function agentPrincipalFor(nestId: string, handle: string): Promise<AgentPrincipal | null> {
  return agentPrincipalByEmail(agentPrincipalEmail(nestId, handle));
}

function principalFromRow(row: { id: string; email: string; name: string | null; is_service: number | null } | undefined): AgentPrincipal | null {
  if (!row || !Number(row.is_service)) return null;
  const parsed = parseAgentPrincipalEmail(row.email);
  if (!parsed) return null;
  return { id: row.id, email: row.email.toLowerCase(), handle: parsed.handle, nestId: parsed.nestId, name: row.name?.trim() || parsed.handle };
}

/** Is this address an agent principal's? Pure: the reserved domain is only
 *  ever written by the hire, and is_service is checked where it matters. */
export function isAgentPrincipalEmail(email: string | null | undefined): boolean {
  return parseAgentPrincipalEmail(email) !== null;
}

/** The hired handles of a nest that have a principal (active key agents). */
export async function hiredAgentHandles(nestId: string): Promise<string[]> {
  const rows = (await getDb().all("SELECT handle FROM hired_agents WHERE nest_id = ? AND kind = 'key'", [nestId])) as Array<{ handle: string }>;
  return rows.map((r) => r.handle);
}
