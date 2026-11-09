import { getDb } from "../db/client.js";
import { getCurrentLicense, getEntitlement } from "./license.js";
import { getAccessConfig, isSuperAdmin } from "../governance/access-service.js";
import { teamRoleToPermission } from "../governance/roles.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { ANON_USER_ID } from "../shared/constants.js";
import { BillingConfirmError, PlanLimitError } from "../shared/errors.js";

/** Per request: whether the caller confirmed a billed-class raise (X-Confirm-Billing). */
export const billingConfirmed = new AsyncLocalStorage<boolean>();

/** The MCP counterpart of X-Confirm-Billing, offered on BILLING_CONFIRM_TOOLS. */
export const confirmBillingToolField = {
  confirm_billing: z
    .boolean()
    .optional()
    .describe("Set true only after the user agreed to a change that raises what someone is billed."),
};

/**
 * The MCP tools that can raise what someone is billed, and so take
 * `confirm_billing`. A tool's definition lists only the inputs it uses: a read
 * tool that mentions billing misdescribes itself to the agent and to anyone
 * reviewing the definitions. A new tool that reaches assertCanGrant goes here,
 * or the agent has no way to confirm the raise.
 */
export const BILLING_CONFIRM_TOOLS: ReadonlySet<string> = new Set([
  "context_assign_steward",
  "context_grant",
  "context_nest_teams",
  "context_resolve_access_request",
  "context_share_nest",
]);

/**
 * Billing per person (pricing spec §3.3): each person bills once, at their
 * highest role on any nest. Owner, admin, reviewer or server admin = user;
 * editor = subscriber; everyone else = viewer (free).
 */
export type BillingClass = "user" | "subscriber" | "viewer";

const RANK: Record<BillingClass, number> = { viewer: 0, subscriber: 1, user: 2 };
const CLASSES: BillingClass[] = ["viewer", "subscriber", "user"];

/** A nest permission (collaborator, team or grant) as a billing class. */
export function permissionClass(permission: string | null | undefined): BillingClass {
  if (permission === "admin" || permission === "owner") return "user";
  return permission === "write" ? "subscriber" : "viewer";
}

/** A steward role: reviewers and admins approve, so they are users. */
export function stewardClass(role: string | null | undefined): BillingClass {
  if (role === "viewer") return "viewer";
  return role === "editor" ? "subscriber" : "user";
}

/**
 * Every signed-up person's billing class, keyed by user id. The role tables
 * resolve in one union query; shared-team rosters are JSON on the team row,
 * so they (and server admins, who live in config) are merged here.
 */
export async function billingClasses(): Promise<Map<string, BillingClass>> {
  const db = getDb();
  const [rows, nests, users] = await Promise.all([
    db.all(
      `SELECT user_id, 2 AS r FROM nests
       UNION ALL
       SELECT user_id, CASE permission WHEN 'admin' THEN 2 WHEN 'write' THEN 1 ELSE 0 END
         FROM nest_collaborators
       UNION ALL
       SELECT u.id, CASE s.role WHEN 'viewer' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END
         FROM stewards s JOIN users u ON LOWER(u.email) = LOWER(s.user_email)
        WHERE s.is_active = 1
          -- a creator auto-stewarding their own document is not a reviewer grant
          AND LOWER(s.assigned_by) != LOWER(s.user_email)
       UNION ALL
       SELECT user_id, CASE role WHEN 'write' THEN 1 ELSE 0 END FROM grants`,
    ) as Promise<Array<{ user_id: string | null; r: number }>>,
    db.all("SELECT shared_teams FROM nests WHERE shared_teams IS NOT NULL AND shared_teams != '[]'") as Promise<
      Array<{ shared_teams: string }>
    >,
    // People only: access-key service identities are never billed seats.
    db.all("SELECT id, email FROM users WHERE id != ? AND COALESCE(is_service, 0) = 0", [ANON_USER_ID]) as Promise<
      Array<{ id: string; email: string }>
    >,
  ]);

  const people = new Set(users.map((u) => u.id));
  const best = new Map<string, number>();
  const bump = (id: string | null | undefined, r: number) => {
    if (id && people.has(id) && r > (best.get(id) ?? -1)) best.set(id, r);
  };
  for (const row of rows) bump(row.user_id, Number(row.r));

  const teamIds = new Set<string>();
  for (const n of nests) for (const ref of parseJsonArray(n.shared_teams)) if (ref?.teamId) teamIds.add(ref.teamId);
  if (teamIds.size) {
    const ids = [...teamIds];
    const teams = (await db.all(
      `SELECT members FROM teams WHERE id IN (${ids.map(() => "?").join(",")})`,
      ids,
    )) as Array<{ members: string | null }>;
    for (const t of teams) {
      for (const m of parseJsonArray(t.members)) {
        bump(m?.userId, RANK[permissionClass(teamRoleToPermission(m?.role))]);
      }
    }
  }

  const owner = getCurrentLicense()?.ownerEmail?.toLowerCase();
  for (const u of users) {
    const email = (u.email || "").toLowerCase();
    if (email && (email === owner || isSuperAdmin(email))) bump(u.id, RANK.user);
  }

  const out = new Map<string, BillingClass>();
  for (const [id, r] of best) out.set(id, CLASSES[r]);
  return out;
}

function parseJsonArray(json: string | null | undefined): any[] {
  try {
    const v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function tally(classes: Map<string, BillingClass>) {
  let users = 0;
  let subscribers = 0;
  for (const c of classes.values()) {
    if (c === "user") users++;
    else if (c === "subscriber") subscribers++;
  }
  return { users, subscribers };
}

/** Billed users and subscribers on this server — what the license poll reports. */
export async function countBilled(): Promise<{ users: number; subscribers: number }> {
  return tally(await billingClasses());
}

/**
 * Refuse a role change that would take the server past its plan (402), then
 * one that raises someone's billed class without confirmation (409, pricing
 * spec v21). Only a raise is checked, so demotions and viewers always pass.
 * `userId` null = a person with no account yet (e.g. a steward invited by email).
 * ponytail: best-effort — count and write aren't atomic, so two grants at the
 * last seat can both pass; serialise check+write if the cap must be exact.
 */
export async function assertCanGrant(
  changes: Array<{ userId: string | null | undefined; next: BillingClass; email?: string }>,
): Promise<void> {
  const ent = getEntitlement();
  let raises = changes.filter((c) => c.next !== "viewer" && c.userId !== ANON_USER_ID);
  // Service identities (access keys, agent personas) are never billed, so they never take a seat.
  const ids = raises.map((c) => c.userId).filter((id): id is string => !!id);
  if (ids.length) {
    const svc = (await getDb().all(
      `SELECT id FROM users WHERE COALESCE(is_service, 0) = 1 AND id IN (${ids.map(() => "?").join(",")})`,
      ids,
    )) as Array<{ id: string }>;
    const skip = new Set(svc.map((r) => r.id));
    raises = raises.filter((c) => !c.userId || !skip.has(c.userId));
  }
  if (!raises.length) return;

  const classes = await billingClasses();
  const before = tally(classes);
  const after = { ...before };
  const seen = new Set<string>();
  const raised: Array<{ userId: string | null; email?: string; from: BillingClass; to: BillingClass }> = [];
  for (const { userId, next, email } of raises) {
    if (userId) {
      if (seen.has(userId)) continue;
      seen.add(userId);
    }
    const cur = (userId && classes.get(userId)) || "viewer";
    if (RANK[next] <= RANK[cur]) continue;
    raised.push({ userId: userId ?? null, email, from: cur, to: next });
    if (cur === "subscriber") after.subscribers--;
    if (next === "user") after.users++;
    else after.subscribers++;
  }

  if (ent.maxUsers != null && after.users > ent.maxUsers && after.users > before.users) {
    throw new PlanLimitError("users", ent.maxUsers, planLimitMessage("users", ent.maxUsers, true));
  }
  if (
    ent.maxSubscribers != null &&
    after.subscribers > ent.maxSubscribers &&
    after.subscribers > before.subscribers
  ) {
    throw new PlanLimitError(
      "subscribers",
      ent.maxSubscribers,
      planLimitMessage("subscribers", ent.maxSubscribers, true),
    );
  }

  // No store = an internal call (seed, job), not a request: nothing to confirm.
  if (!raised.length || billingConfirmed.getStore() !== false) return;
  const raisedIds = raised.map((r) => r.userId).filter((id): id is string => !!id);
  const emails = new Map<string, string>();
  if (raisedIds.length) {
    const rows = (await getDb().all(
      `SELECT id, email FROM users WHERE id IN (${raisedIds.map(() => "?").join(",")})`,
      raisedIds,
    )) as Array<{ id: string; email: string }>;
    for (const r of rows) emails.set(r.id, r.email);
  }
  throw new BillingConfirmError(
    raised.map((r) => ({ ...r, email: (r.userId && emails.get(r.userId)) || r.email || null })),
  );
}

/**
 * Why a role change was refused, worded for who asked: a server admin can
 * upgrade (Settings → License); anyone else can only ask that admin. The API
 * error handler picks the audience per request.
 */
export function planLimitMessage(
  limit: "users" | "subscribers" | "account_owners",
  max: number,
  forAdmin: boolean,
): string {
  const full =
    limit === "users"
      ? `This server's plan includes ${max} ${max === 1 ? "user" : "users"} (nest owners, admins and reviewers), and all are in use.`
      : limit === "subscribers"
        ? max === 0
          ? "Editors aren't included in this server's plan."
          : `This server's plan includes ${max} ${max === 1 ? "editor" : "editors"}, and all are in use.`
        : `This server's plan includes ${max} account ${max === 1 ? "owner" : "owners"}.`;
  return forAdmin
    ? `${full} Upgrade the plan from Settings → License to add more.`
    : `${full} Ask your server admin to add seats.`;
}

/**
 * Refuse a new server admin (Account Owner) past the plan's cap — Free has one.
 * A server admin is also a billed user, so the user cap applies too.
 */
export async function assertCanAddAccountOwner(email: string): Promise<void> {
  const max = getEntitlement().maxAccountOwners;
  if (max != null) await assertAccountOwnerSlot(email, max);
  const user = (await getDb().get("SELECT id FROM users WHERE LOWER(email) = LOWER(?)", [email])) as
    | { id: string }
    | undefined;
  await assertCanGrant([{ userId: user?.id ?? null, next: "user" }]);
}

async function assertAccountOwnerSlot(email: string, max: number): Promise<void> {
  const owners = new Set<string>();
  const licenseOwner = getCurrentLicense()?.ownerEmail;
  if (licenseOwner) owners.add(licenseOwner.toLowerCase());
  for (const e of getAccessConfig()?.super_admins ?? []) owners.add(e.toLowerCase());
  for (const r of (await getDb().all("SELECT email FROM super_admins")) as Array<{ email: string }>) {
    owners.add(r.email.toLowerCase());
  }
  if (owners.has(email.toLowerCase())) return;
  if (owners.size >= max) {
    throw new PlanLimitError("account_owners", max, planLimitMessage("account_owners", max, true));
  }
}
