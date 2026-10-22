/**
 * Org contributors (CU-wdqcq05rz6) — the one place a person who holds only
 * READ on an org nest may write to it.
 *
 * `resolveNestAccess` decides WHO is an org contributor (`orgContributor`,
 * src/shared/access.ts). This module decides WHAT they may do, and is the only
 * code that acts on that flag:
 *
 *   - create a document, and propose an edit to one they can read — always as
 *     a draft submitted for review (`alwaysDraft`, `creatorReviews: false`),
 *     whatever the nest's self-publish postures say;
 *   - see and revise their own drafts.
 *
 * Nothing here raises the caller's permission. REST (app.ts admits exactly
 * POST /nodes and PATCH /nodes/:id for them, nodes/routes.ts branches here)
 * and MCP (context_create / context_update / context_submit_review) both go
 * through these functions, so the two surfaces can't drift.
 */
import type { Context } from "hono";
import type { AuthEnv } from "../auth/middleware.js";
import { getDb } from "../db/client.js";
import { ANON_USER_ID } from "../shared/constants.js";
import { resolveNestAccess } from "../shared/access.js";
import {
  ConflictError,
  ForbiddenError,
  LockedError,
  NotFoundError,
} from "../shared/errors.js";
import type { ClientMetadata } from "../shared/client-metadata.js";
import { canReadNode } from "./access-guard.js";
import * as versions from "./version-service.js";
import { getPendingReview, submitForReview } from "./review-service.js";
import type { ReviewRequest } from "./types.js";
import { nestRequiresPushConfirmation } from "../nests/service.js";
import { isPushAllowlisted } from "../nests/push-confirmation-service.js";
import { createNode, updateNode, type NodeMutationResult } from "../nodes/service.js";
import { engineCache } from "../nodes/engine.js";

/**
 * Is THIS credential one a person contributes with? The access row can't see
 * the credential, so the routes ask this too. Only a person's own full
 * credential qualifies: a browser session, an unscoped personal API key, or
 * an MCP OAuth grant (the person's own consent). Never a key scoped to one
 * nest, a read-only key, a named system, a headless key, a PromptOwl service
 * ticket, or the anonymous caller — none of them gets reach it didn't have.
 */
export function credentialMayContribute(c: Context<AuthEnv>): boolean {
  const userId = c.get("userId");
  if (!userId || userId === ANON_USER_ID) return false;
  if (c.get("keyCapability") !== "write") return false;
  if (c.get("nestScope")) return false;
  const kind = c.get("principalKind");
  if (kind === "human") return true;
  // An OAuth grant sets no principal kind; it is the person's own consent.
  return kind === undefined && Array.isArray(c.get("oauthScope"));
}

/** Org contributor on this nest, with a credential that may use it. */
export async function isOrgContribution(
  nestId: string,
  userId: string,
  credentialOk: boolean,
): Promise<boolean> {
  if (!credentialOk) return false;
  const access = await resolveNestAccess(nestId, userId);
  return access.orgContributor && access.permission === "read";
}

/** The fields an org contributor may send on a create. Everything else —
 *  prime, status, type other than a plain document, schedules, models, task
 *  and custom fields — is a governance or automation decision, not theirs. */
const CREATE_FIELDS = new Set(["title", "content", "tags", "folder", "client", "type"]);
/** …and on an edit. */
const PATCH_FIELDS = new Set(["content", "append", "title", "description", "tags", "changeNote", "client"]);

function assertOnly(allowed: Set<string>, body: Record<string, unknown>, what: string) {
  const extra = Object.keys(body).filter((k) => body[k] !== undefined && !allowed.has(k));
  if (extra.length > 0) {
    throw new ForbiddenError(
      `As an org contributor you can ${what}, but not set ${extra.join(", ")}. Ask a nest editor for that.`,
    );
  }
}

export function assertContributorCreate(body: Record<string, unknown>): void {
  assertOnly(CREATE_FIELDS, body, "suggest a document's title, content, tags and folder");
  if (body.type !== undefined && body.type !== "document") {
    throw new ForbiddenError("As an org contributor you can suggest documents only, not other node types.");
  }
}

export function assertContributorPatch(body: Record<string, unknown>): void {
  assertOnly(PATCH_FIELDS, body, "suggest changes to a document's text, title, description and tags");
}

/**
 * A nest that holds agent writes for confirmation (the Push Confirmation
 * Gate) refuses contributions over a key or MCP: replaying a held write later
 * would run on the confirmer's authority, not as a draft. People still
 * contribute from the web app (a session isn't held on REST).
 */
export async function assertNotPushGated(params: {
  nestId: string;
  userId: string;
  keyId: string | null;
  agentSurface: boolean;
}): Promise<void> {
  if (!params.keyId && !params.agentSurface) return;
  if (!(await nestRequiresPushConfirmation(params.nestId))) return;
  if (await isPushAllowlisted(params.nestId, params.userId, params.keyId)) return;
  throw new ForbiddenError(
    "This nest holds agent writes for confirmation, so it doesn't take org contributions from keys or agents. Suggest the change from the web app instead.",
  );
}

/** The newest version row is an unreviewed one (draft, pending or rejected)
 *  written by this person — i.e. the working copy is theirs. */
export async function ownsWorkingDraft(
  nestId: string,
  nodeId: string,
  email: string,
): Promise<boolean> {
  const row = (await getDb().get(
    `SELECT status, author FROM node_versions
      WHERE nest_id = ? AND node_id = ?
      ORDER BY version DESC LIMIT 1`,
    [nestId, nodeId],
  )) as { status: string; author: string | null } | undefined;
  if (!row || !row.author) return false;
  return (
    ["draft", "pending_review", "rejected"].includes(row.status) &&
    row.author.toLowerCase() === email.toLowerCase()
  );
}

export interface ContributionResult extends NodeMutationResult {
  /** The review this write is waiting on (new, or the contributor's own
   *  open one that it was folded into). */
  review: ReviewRequest | null;
}

/** Create a document as a draft and send it to review. */
export async function contributeDocument(
  nestId: string,
  input: {
    title: string;
    content: string;
    tags?: string[];
    folder?: string;
    client?: ClientMetadata;
  },
  userEmail: string,
  opts: { baseUrl?: string; note?: string } = {},
): Promise<ContributionResult> {
  let made: NodeMutationResult;
  try {
    made = await createNode(
      nestId,
      {
        title: input.title,
        content: input.content,
        tags: input.tags,
        folder: input.folder,
        client: input.client,
      },
      userEmail,
      // Never published, never stewarded: creator-reviews would make the
      // contributor this document's reviewer, and v1 would publish on that.
      // No mention fan-out from an unreviewed suggestion by someone outside
      // the roster (inbox rows and channel posts naming a draft); the reviewer
      // sees the text in review.
      { alwaysDraft: true, creatorReviews: false, notifyMentions: false },
    );
  } catch (err) {
    // The stock message names the occupying document's id, which may be
    // someone else's draft this contributor can't see. Say only that the
    // title is taken.
    if (err instanceof ConflictError) {
      throw new ConflictError("That title is already used in this nest. Choose a different title.");
    }
    throw err;
  }
  const review = await submitForReview({
    nestId,
    nodeId: made.node.id,
    version: made.version,
    requestedBy: userEmail,
    note: opts.note ?? "Suggested by an org contributor",
    baseUrl: opts.baseUrl,
    client: input.client,
  });
  return { ...made, review };
}

/**
 * Propose an edit as a draft for review. Refused — before anything is
 * written — when the contributor can't read the document, when someone
 * else's change is already under review (423, as for everyone), or when the
 * working copy holds someone else's unreviewed draft (409): a contributor
 * sees the approved text, so a save over another person's draft would
 * silently replace work they never saw.
 */
export async function proposeEdit(
  nestId: string,
  nodeId: string,
  userId: string,
  patch: {
    content?: string;
    append?: string;
    title?: string;
    description?: string;
    tags?: string[];
    changeNote?: string;
    client?: ClientMetadata;
  },
  userEmail: string,
  opts: { baseUrl?: string } = {},
): Promise<ContributionResult> {
  // The head the checks below are made against. updateNode re-checks it inside
  // the node's write lock, so a change landing between these checks and the
  // write (another contributor's proposal, a collaborator's save) is refused
  // with 409 instead of overwritten.
  const head = await versions.getCurrentVersion(nestId, nodeId);
  const own = await ownsWorkingDraft(nestId, nodeId, userEmail);
  if (!own && !(await canReadNode(nestId, nodeId, userId, userEmail))) {
    // Same answer as a missing document: an unapproved draft is invisible.
    throw new NotFoundError(`Node not found: ${nodeId}`);
  }
  const pending = await getPendingReview(nestId, nodeId);
  if (pending && pending.requestedBy.toLowerCase() !== userEmail.toLowerCase()) {
    throw new LockedError(
      "This document already has a change waiting for review. Try again once it is decided.",
    );
  }
  if (!own && (await versions.hasUnsealedDraft(nestId, nodeId))) {
    throw new ConflictError(
      "Someone is working on a draft of this document. Try again once it is published, or leave a comment instead.",
    );
  }
  // No mention fan-out, as for a contributed create (see contributeDocument).
  const res = await updateNode(nestId, nodeId, patch, userEmail, {
    alwaysDraft: true,
    notifyMentions: false,
    expectHead: head,
  });
  // Revising their own open submission repoints that review (updateNode);
  // anything else goes to review now.
  const review = pending
    ? await getPendingReview(nestId, nodeId)
    : await submitForReview({
        nestId,
        nodeId,
        version: res.version,
        requestedBy: userEmail,
        note: patch.changeNote || "Suggested by an org contributor",
        baseUrl: opts.baseUrl,
        client: patch.client,
      });
  return { ...res, review };
}

/** One of the caller's own unpublished contributions in this nest. */
export interface MyContribution {
  node_id: string;
  title: string | null;
  version: number;
  status: string;
  created_at: string;
  review_id: string | null;
  /** The draft text — theirs, so theirs to read back. */
  content: string;
}

/**
 * Every document in this nest whose newest version is an unreviewed one the
 * caller wrote. Only the caller's own rows, by construction: the author is in
 * the WHERE clause, so nobody else's draft can appear here.
 */
export async function listMyContributions(
  nestId: string,
  email: string,
): Promise<MyContribution[]> {
  const rows = (await getDb().all(
    `SELECT v.node_id, v.version, v.status, v.created_at,
            (SELECT r.id FROM review_requests r
              WHERE r.nest_id = v.nest_id AND r.node_id = v.node_id
                AND r.status = 'pending' LIMIT 1) AS review_id
       FROM node_versions v
      WHERE v.nest_id = ? AND v.author = ?
        AND v.status IN ('draft', 'pending_review', 'rejected')
        AND v.version = (SELECT MAX(v2.version) FROM node_versions v2
                          WHERE v2.nest_id = v.nest_id AND v2.node_id = v.node_id)
      ORDER BY v.created_at DESC
      LIMIT 200`,
    [nestId, email.toLowerCase()],
  )) as Array<{
    node_id: string;
    version: number;
    status: string;
    created_at: string;
    review_id: string | null;
  }>;
  if (rows.length === 0) return [];
  // The newest version is theirs and unreviewed, so the working file IS their
  // draft (a draft lives in the file, not the version row — see updateNode).
  const { storage } = await engineCache.get(nestId);
  const read = await Promise.all(
    rows.map(async (r) => {
      try {
        const doc = await storage.readDocument(r.node_id);
        return {
          node_id: r.node_id,
          title: (doc.frontmatter.title as string | undefined) ?? null,
          version: Number(r.version),
          status: r.status,
          created_at: r.created_at,
          review_id: r.review_id,
          content: doc.body ?? "",
        } satisfies MyContribution;
      } catch {
        return null; // gone from disk: nothing to show or revise
      }
    }),
  );
  return read.filter((c): c is MyContribution => c !== null);
}

/**
 * Of these review requesters, which reach the nest only as org contributors
 * (not collaborators, stewards or team members)? For the review queue's
 * "org contributor (not a collaborator)" label. One access resolution per
 * distinct requester.
 */
export async function orgContributorRequesters(
  nestId: string,
  emails: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const distinct = [...new Set(emails.map((e) => e.toLowerCase()))];
  if (distinct.length === 0) return out;
  const users = (await getDb().all(
    // A service identity is never a person in the org (resolveNestAccess
    // refuses it too); filtered here so it isn't even resolved.
    `SELECT id, email FROM users
      WHERE LOWER(email) IN (${distinct.map(() => "?").join(",")}) AND is_service = 0`,
    distinct,
  )) as Array<{ id: string; email: string }>;
  for (const u of users) {
    const access = await resolveNestAccess(nestId, u.id);
    if (access.orgContributor && access.isPublicReader) out.add(u.email.toLowerCase());
  }
  return out;
}

/**
 * Boot-time guard for the access gate's contributor admission (app.ts): it
 * admits an org contributor's PATCH anywhere under /nests/:nestId/nodes/, on
 * the strength of the node update being the ONLY PATCH there. If another
 * PATCH route ever appears, a read-tier contributor would reach it — so the
 * app refuses to start instead of relying on someone heeding a test.
 */
export function assertSoleNodePatchRoute(routes: Array<{ method: string; path: string }>): void {
  const patches = new Set(
    routes
      .filter((r) => r.method === "PATCH" && r.path.startsWith("/nests/:nestId/nodes"))
      .map((r) => r.path),
  );
  const extra = [...patches].filter((p) => p !== "/nests/:nestId/nodes/:nodeId{.+}");
  if (extra.length > 0) {
    throw new Error(
      `PATCH ${extra.join(", ")} is under /nests/:nestId/nodes, where the access gate admits org contributors (CU-wdqcq05rz6) for the node update only. Narrow isContributionRoute in app.ts before adding it.`,
    );
  }
}
