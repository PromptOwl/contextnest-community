/**
 * §1.12 view serving — the I/O behind `ViewDeps`, wired to the access layer
 * and the table resolver this server already has. Nothing here re-implements
 * an ACL: visibility IS `filterAccessible`, intersected over the principals;
 * table rows ARE `queryTableNode`; selectors ARE the engine's evaluator; the
 * layout schema IS the engine's `viewMetaSchema`.
 */
import {
  parseDocument,
  parseSelector,
  evaluate,
  Resolver,
  isPublished,
  isForgotten,
  isRejected,
  viewMetaSchema,
} from "@promptowl/contextnest-engine";
import type { ContextNode, ViewMeta } from "@promptowl/contextnest-engine";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { engineCache } from "../nodes/engine.js";
import { bodyOnly } from "../nodes/service.js";
import { filterAccessible, resolveCallerEmail } from "../governance/access-guard.js";
import { getApprovedVersion, getApprovedVersions, getVersion } from "../governance/version-service.js";
import { isPublicReader, resolveNestPermission } from "../shared/access.js";
import { assertSafeNodeId } from "../shared/node-id.js";
import { queryTableNode } from "../tables/query.js";
import { summarizeNodes } from "./summary.js";
import { NotFoundError, ForbiddenError, ValidationError } from "../shared/errors.js";
import type { AuthorInfo, ErrorCode, NodeSummary, Principal, TableRows, ViewDeps } from "./core.js";

/** Version rows that were releases when they were cut. */
const SEALED = new Set(["published", "approved"]);

export async function isSealedVersion(nestId: string, nodeId: string, version: number): Promise<boolean> {
  const row = await getVersion(nestId, nodeId, version);
  return !!row && SEALED.has(String(row.status));
}

/** Env kill switch (S1): `CN_VIEW_DATA=off` withholds every frame's data. */
export function viewDataKillSwitch(): boolean {
  return config.CN_VIEW_DATA_OFF;
}

/** A ref/binding → node id: a path or contextnest:// URI. Never a title. */
function refToId(ref: string): string {
  let id = ref.startsWith("contextnest://") ? ref.slice("contextnest://".length) : ref;
  id = id.replace(/^\/+/, "");
  return id.endsWith(".md") ? id.slice(0, -3) : id;
}

/** The ids every principal may read: filterAccessible, intersected. */
async function visibleTo(nestId: string, ids: string[], p: Principal[]): Promise<Set<string>> {
  let left = [...new Set(ids)];
  for (const principal of p) {
    if (left.length === 0) break;
    const kept = await filterAccessible(
      nestId,
      principal.userId,
      principal.email,
      left.map((id) => ({ id })),
    );
    left = kept.map((n) => n.id);
  }
  return new Set(left);
}

export function createViewDeps(): ViewDeps {
  return {
    async resolveRef(nestId, ref) {
      const id = assertSafeNodeId(refToId(ref));
      const { storage } = await engineCache.get(nestId);
      let doc: ContextNode;
      try {
        doc = await storage.readDocument(id);
      } catch {
        return null;
      }
      if (isForgotten(doc)) return null;
      return { id: doc.id, type: String(doc.frontmatter.type || "document") };
    },

    visible: visibleTo,

    async readMd(nestId, id, version) {
      const { storage, versions: versionManager } = await engineCache.get(nestId);
      let live: ContextNode;
      try {
        live = await storage.readDocument(id);
      } catch {
        return { ok: false, error: "not_found" };
      }
      if (isForgotten(live)) return { ok: false, error: "not_found" };
      // Retracted (rejected) or never released: nothing published to serve.
      if (isRejected(live)) return { ok: false, error: "not_published" };
      const approved = await getApprovedVersion(nestId, id);
      if (approved == null) return { ok: false, error: "not_published" };
      let target = approved;
      if (version !== undefined) {
        if (!(await isSealedVersion(nestId, id, version))) return { ok: false, error: "not_published" };
        target = version;
      }
      let raw: string;
      try {
        raw = await versionManager.reconstructVersion(id, target);
      } catch {
        return { ok: false, error: "history_error" };
      }
      return { ok: true, text: bodyOnly(id, raw), version: target };
    },

    async selectNodes(nestId, selector, p) {
      const { storage, versions: versionManager } = await engineCache.get(nestId);
      const all = await storage.discoverDocuments();
      let docs = all.filter((d) => isPublished(d) && !isForgotten(d));
      // An approved-only principal is entitled to approved VALUES, not just
      // approved ids: a live copy's `status: published` is a claim, not a
      // review. Evaluate and project over each node's approved version.
      if (p.some((x) => x.approvedOnly)) {
        const approved = await getApprovedVersions(nestId);
        const live = all.filter((d) => !isForgotten(d) && !isRejected(d));
        const rebuilt: ContextNode[] = [];
        for (const d of live) {
          const v = approved.get(d.id);
          if (v == null) continue;
          try {
            const raw = await versionManager.reconstructVersion(d.id, v);
            const past = parseDocument(`${d.id}.md`, raw, d.id);
            rebuilt.push({ ...past, id: d.id, frontmatter: { ...past.frontmatter, status: "published" as any } });
          } catch {
            /* an unreadable approved version is simply not listed */
          }
        }
        docs = rebuilt;
      }
      const seen = await visibleTo(nestId, docs.map((d) => d.id), p);
      const documents = docs.filter((d) => seen.has(d.id));
      // The engine evaluates the selector over the reader's own scope, as it
      // asks: a node nobody in `p` may read cannot even steer the result.
      const matched = await evaluate(parseSelector(selector), {
        resolver: new Resolver({ documents }),
      });
      return matched
        .filter((d) => seen.has(d.id) && isPublished(d))
        .map(
          (d): NodeSummary => ({
            id: d.id,
            title: String(d.frontmatter.title ?? d.id),
            ...(typeof d.frontmatter.version === "number" ? { version: d.frontmatter.version } : {}),
            ...(d.frontmatter.status ? { status: String(d.frontmatter.status) } : {}),
            tags: (d.frontmatter.tags ?? []) as string[],
          }),
        );
    },

    async tableRows(nestId, id, approvedOnly, p): Promise<TableRows | { error: ErrorCode }> {
      if (!config.TYPE_TABLE_ENABLED) return { error: "feature_disabled" };
      const viewer = p[0];
      if (!viewer) return { error: "not_found" };
      // A working copy that is not itself published (a draft over the
      // approved table) serves the approved rows: what a member would see as
      // released, and what queryTableNode's published-only read cannot give.
      let readApproved = approvedOnly;
      if (!readApproved) {
        const { storage } = await engineCache.get(nestId);
        try {
          readApproved = !isPublished(await storage.readDocument(id));
        } catch {
          return { error: "not_found" };
        }
      }
      try {
        const result = await queryTableNode(nestId, id, "", false, {
          userId: viewer.userId,
          userEmail: viewer.email,
          approvedOnly: readApproved,
        });
        return {
          columns: result.columns,
          rows: result.rows.map((r) =>
            Object.fromEntries(result.columns.map((c, i) => [c, r[i] ?? ""])),
          ),
        };
      } catch (err) {
        if (err instanceof NotFoundError || err instanceof ForbiddenError) return { error: "not_found" };
        if (err instanceof ValidationError) return { error: "unsupported_binding" };
        return { error: "query_failed" };
      }
    },

    summarize(nestId, input) {
      return summarizeNodes(nestId, input, this.readMd);
    },
  };
}

/**
 * Distinct `node_versions.author` of versions 1..upto — the server-stamped
 * record of who wrote each version (never the frontmatter `author`) — or
 * `null` when that record is incomplete and the chain's authors therefore
 * cannot all be named. Complete means: every version sealed in the engine's
 * history up to `upto`, and `upto` itself, has a row with an author. A draft
 * number that was never sealed (its row superseded) carries no content of
 * its own and is not required. An unreadable history is incomplete.
 */
export async function listVersionAuthors(
  nestId: string,
  nodeId: string,
  uptoVersion: number,
): Promise<string[] | null> {
  const rows = (await getDb().all(
    "SELECT version, author FROM node_versions WHERE nest_id = ? AND node_id = ? AND version <= ?",
    [nestId, nodeId, uptoVersion],
  )) as Array<{ version: number; author: string | null }>;
  const byVersion = new Map(rows.map((r) => [Number(r.version), r.author]));
  let sealed: number[];
  try {
    const { versions: versionManager } = await engineCache.get(nestId);
    const history = await versionManager.getHistory(nodeId);
    sealed = (history?.versions ?? []).map((v) => v.version).filter((v) => v <= uptoVersion);
  } catch {
    return null;
  }
  for (const v of new Set([...sealed, uptoVersion])) {
    const author = byVersion.get(v);
    if (author === undefined || author === null) return null;
  }
  return [...new Set(rows.map((r) => r.author ?? ""))];
}

/** Look authors up WITHOUT the anonymous-user fallback: an email that names
 *  nobody here stays `userId: null`, and decideDataTrust withholds on it. */
export async function authorInfos(nestId: string, emails: string[]): Promise<AuthorInfo[]> {
  const out: AuthorInfo[] = [];
  for (const email of [...new Set(emails)]) {
    const isSystem = email.startsWith("system:");
    if (!email || isSystem) {
      out.push({ email, userId: null, isSystem, nestPermission: "none" });
      continue;
    }
    const row = (await getDb().get(
      `SELECT u.id, u.is_service,
              (SELECT 1 FROM system_accounts sa WHERE sa.user_id = u.id) AS is_system
         FROM users u WHERE LOWER(u.email) = LOWER(?)`,
      [email],
    )) as { id: string; is_service: number | null; is_system: number | null } | undefined;
    if (!row) {
      out.push({ email, userId: null, isSystem: false, nestPermission: "none" });
      continue;
    }
    // Access-key, persona and named-system identities are not people who can
    // vouch for code: agent-written versions are the likeliest to carry
    // injected content, and such accounts often hold broad access.
    if (row.is_service || row.is_system) {
      out.push({ email, userId: row.id, isSystem: true, nestPermission: "none" });
      continue;
    }
    out.push({
      email,
      userId: row.id,
      isSystem: false,
      nestPermission: await resolveNestPermission(nestId, row.id),
      approvedOnly: await isPublicReader(nestId, row.id),
    });
  }
  return out;
}

export async function viewerPrincipal(nestId: string, userId: string): Promise<Principal> {
  return {
    userId,
    email: await resolveCallerEmail(userId),
    approvedOnly: await isPublicReader(nestId, userId),
  };
}

export interface ViewVersion {
  title: string;
  body: string;
  /** The parsed layout, or null when the stored block fails the engine schema. */
  meta: ViewMeta | null;
}

function viewVersionOf(nodeId: string, doc: { frontmatter: Record<string, unknown>; body?: string }): ViewVersion {
  const parsed = viewMetaSchema.safeParse(doc.frontmatter.view);
  return {
    title: String(doc.frontmatter.title || nodeId),
    body: doc.body ?? "",
    meta: parsed.success ? parsed.data : null,
  };
}

/** One version of a view as stored in its chain (throws when unreadable). */
export async function readViewVersion(nestId: string, viewId: string, version: number): Promise<ViewVersion> {
  const { versions: versionManager } = await engineCache.get(nestId);
  const raw = await versionManager.reconstructVersion(viewId, version);
  return viewVersionOf(viewId, parseDocument(`${viewId}.md`, raw, viewId) as any);
}

/** The live working copy of a view. */
export function liveViewVersion(viewId: string, doc: ContextNode): ViewVersion {
  return viewVersionOf(viewId, doc as any);
}
