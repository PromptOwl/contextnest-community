import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { isServerAdminUserId } from "../shared/access.js";
import { isNestHeadless } from "../auth/headless.js";
import { invalidateSiteNests } from "../site/invalidate.js";
import { claimSiteKeyIfLive } from "../site/settings.js";
import type { NestVisibility } from "../shared/types.js";

/**
 * Changing a nest's visibility — the service behind REST PATCH
 * /nests/:id/visibility (sharing-routes.ts), kept out of the route so an MCP
 * twin can reuse it once the engine defines the op. Callers have already
 * checked the nest "admin" tier.
 */

const RANK: Record<NestVisibility, number> = { private: 0, org: 1, public: 2 };

export type VisibilityResult =
  | { ok: true; visibility: NestVisibility }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409;
      error: string;
      code?: "visibility_restricted";
      requires_acknowledgement?: true;
      warning?: string;
    };

/**
 * NEST_PUBLIC_VISIBILITY / NEST_ORG_VISIBILITY = admins: only a server admin
 * may WIDEN a nest to that tier. Narrowing (or re-sending the current tier)
 * is never refused — it can only reach fewer people. Returns the refusal, or
 * null when allowed.
 */
export async function visibilityRestriction(
  userId: string,
  current: NestVisibility,
  target: NestVisibility,
): Promise<string | null> {
  if (RANK[target] <= RANK[current]) return null;
  const setting =
    target === "public" ? config.NEST_PUBLIC_VISIBILITY : config.NEST_ORG_VISIBILITY;
  if (setting !== "admins") return null;
  if (config.AUTH_MODE === "open" || (await isServerAdminUserId(userId))) return null;
  return target === "public"
    ? 'Only a server admin can make nests public on this server (Server settings → "Who can make nests public"). Ask a server admin to publish it.'
    : 'Only a server admin can make nests organization-wide on this server (Server settings → "Who can make nests organization-wide"). Ask a server admin to open it to the organization.';
}

export async function setNestVisibility(
  nestId: string,
  userId: string,
  visibility: unknown,
  acknowledged: boolean,
): Promise<VisibilityResult> {
  if (visibility !== "private" && visibility !== "org" && visibility !== "public") {
    return { ok: false, status: 400, error: "visibility must be private, org or public" };
  }
  const db = getDb();
  const nest = (await db.get("SELECT visibility FROM nests WHERE id = ?", [nestId])) as
    | { visibility: NestVisibility }
    | undefined;
  if (!nest) return { ok: false, status: 404, error: "Nest not found" };

  // The server's own cap comes before the acknowledgement: asking someone to
  // confirm a change they aren't allowed to make would only mislead them.
  const restricted = await visibilityRestriction(userId, nest.visibility, visibility);
  if (restricted) {
    return { ok: false, status: 403, error: restricted, code: "visibility_restricted" };
  }

  // Outside-org publish guardrail: flipping a nest to public makes it readable
  // by anyone on the internet, outside your organization. Require an explicit
  // acknowledgement so this can never happen on a stray click. Going back to
  // private needs no acknowledgement. 'org' stays inside the deployment — on
  // a single-company server that crosses no organizational boundary, but on
  // a SHARED deployment (the PromptOwl-hosted server) the deployment is many
  // customers, so 'org' needs the same acknowledgement there. Enforced here,
  // not only in the UI, so a client that bypasses the UI can't skip it.
  const shared = config.SHARED_DEPLOYMENT;
  if (visibility === "public" && !acknowledged) {
    return {
      ok: false,
      status: 409,
      error: "Publishing this nest requires acknowledgement.",
      requires_acknowledgement: true,
      warning: shared
        ? "This makes the nest readable by anyone on the internet — including every account on this server, which belongs to other organizations too."
        : "This makes the nest readable by anyone on the internet, outside your organization.",
    };
  }
  if (visibility === "org" && shared && !acknowledged) {
    return {
      ok: false,
      status: 409,
      error: "Opening this nest to the organization requires acknowledgement.",
      requires_acknowledgement: true,
      warning:
        "This server is shared: 'Organization' makes the nest readable by every account on this server, including other organizations — not just yours.",
    };
  }

  // A nest published headless (API-only, CU-wdqcq0314u) stays private: org or
  // public would let people read it without a key.
  const headlessRefusal =
    "This nest is published API-only (headless), so it stays private. Stop headless publishing first to make it org or public.";
  if (visibility !== "private" && (await isNestHeadless(nestId))) {
    return { ok: false, status: 409, error: headlessRefusal };
  }
  // Widening is conditional on the nest not being headless (CU-wdqcq0314u), so
  // a headless toggle racing this request can't leave it both public and
  // headless — and on the tier the cap was checked against, so a concurrent
  // narrowing can't turn an allowed "narrow to org" into an uncapped widening.
  // A zero-row result is then told apart from "no such nest" below.
  const result = await db.run(
    visibility === "private"
      ? "UPDATE nests SET visibility = ? WHERE id = ?"
      : "UPDATE nests SET visibility = ? WHERE id = ? AND COALESCE(headless, 0) = 0 AND visibility = ?",
    visibility === "private" ? [visibility, nestId] : [visibility, nestId, nest.visibility],
  );
  invalidateSiteNests();
  if (result.changes > 0) await claimSiteKeyIfLive(nestId);
  if (result.changes === 0 && visibility !== "private" && (await isNestHeadless(nestId))) {
    return { ok: false, status: 409, error: headlessRefusal };
  }
  if (result.changes === 0 && visibility !== "private") {
    const now = await db.get("SELECT 1 FROM nests WHERE id = ?", [nestId]);
    if (now) {
      return {
        ok: false,
        status: 409,
        error: "This nest's visibility changed while you were saving. Reload and try again.",
      };
    }
  }
  // A zero-row update means the nest id didn't resolve — report it instead of
  // echoing success, which previously let the UI flip to a state the DB never
  // took (the "made it private but it still shows public" symptom).
  if (result.changes === 0) return { ok: false, status: 404, error: "Nest not found" };
  // Re-read the persisted value so the client reconciles against the DB truth,
  // not the value it sent.
  const row = (await db.get("SELECT visibility FROM nests WHERE id = ?", [nestId])) as {
    visibility: NestVisibility;
  };
  return { ok: true, visibility: row.visibility };
}
