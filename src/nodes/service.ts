/**
 * Node lifecycle service — shared by REST routes and MCP tools so
 * disk + DB stay in lockstep across both surfaces. Handlers stay thin
 * (auth, parse, response shape); this module owns create/update/list.
 */
import {
  serializeDocument,
  parseDocument,
  normalizeStatus,
} from "@promptowl/contextnest-engine";
import type { ContextNode, NestStorage } from "@promptowl/contextnest-engine";
import { rename, mkdir, rm } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { safePublishDocument } from "../governance/safe-publish.js";
import { engineCache } from "./engine.js";
import {
  AppError,
  NotFoundError,
  LockedError,
  ValidationError,
  ConflictError,
} from "../shared/errors.js";
import { trackEvent } from "../telemetry/tracker.js";
import * as versions from "../governance/version-service.js";
import { syncNodeTags, removeNodeFromTagIndex } from "../governance/tag-index-service.js";
import {
  isStewardshipEnabled,
  resolveNestPath,
  nestAllowsSelfApprove,
} from "../nests/service.js";
import { getPendingReview, repointPendingReview } from "../governance/review-service.js";
import { resolveUserRoles } from "../governance/stewardship-service.js";
import {
  resolveCallerEmail,
  filterAccessible,
} from "../governance/access-guard.js";
import { isPublicReader, resolveNestPermission } from "../shared/access.js";
import {
  listUserGrants,
  grantCoversNode,
} from "../governance/grants-service.js";
import { getPendingChange } from "../governance/external-edit-service.js";
import { getDb } from "../db/client.js";
import { ANON_USER_ID } from "../shared/constants.js";
import { withNodeWriteLock, nodeWriteKey } from "../shared/node-write-lock.js";
import { config } from "../config.js";

/** Reverse-lookup the auth userId from a registered email. Anonymous email → ANON. */
async function userIdFromEmail(email: string): Promise<string> {
  const db = getDb();
  const row = (await db.get(
    "SELECT id FROM users WHERE LOWER(email) = LOWER(?)",
    [email]
  )) as { id: string } | undefined;
  return row?.id ?? ANON_USER_ID;
}

const normalizeTag = (t: string) => (t.startsWith("#") ? t : `#${t}`);

/** Max characters in a human-readable title. The id/slug bound (100 per
 *  segment, below) doesn't cover this: a title of emoji or non-latin text
 *  slugifies to almost nothing, so an unbounded title still lands in
 *  frontmatter and stretches every header that renders it. */
const MAX_TITLE_LENGTH = 120;

/** Shared choke point for REST + MCP: both create and rename route here. */
function assertTitleLength(title: string): void {
  if (title.length > MAX_TITLE_LENGTH) {
    throw new ValidationError(
      `title must be at most ${MAX_TITLE_LENGTH} characters`
    );
  }
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Slugify + validate a folder path into id segments. Shared by create and
 * move so both enforce the same depth/length bounds and the same traversal
 * defense (each segment slugified independently — "../" collapses to "-",
 * empty segments drop).
 */
function folderToSegments(folder: string): string[] {
  const segments = folder.split("/").map(slugify).filter(Boolean);
  // Callers think in node ids, and every node id starts with "nodes/" — so
  // `folder: "nodes/signals"` is the natural thing to write. Both call sites
  // below prefix "nodes/" themselves, so an unstripped leading segment lands
  // the doc at nodes/nodes/signals/<slug>. Strip it here, once, rather than
  // in create and move separately. Cost: a folder literally named "nodes"
  // under the root is unaddressable — nobody wants nodes/nodes/.
  if (segments[0] === "nodes") segments.shift();
  if (segments.length > 8) {
    throw new ValidationError("folder may nest at most 8 levels deep");
  }
  if (segments.some((seg) => seg.length > 100)) {
    throw new ValidationError(
      "each folder or title segment must be at most 100 characters",
    );
  }
  return segments;
}

const stripUndefined = <T extends Record<string, any>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * Optional `#dept:<slug>` auto-tag (CU-wdqcpzwf2p). When the superadmin
 * toggle OIDC_DEPARTMENT_TAGGING is on and the creating user has a directory
 * department (captured from the OIDC `department` claim at login — see
 * src/auth/oidc.ts), createNode appends `dept:<slugified-department>`
 * (lowercase, whitespace → dashes) to the new node's tags. CREATE-only by
 * design: updateNode never adds it and existing nodes are never retro-tagged,
 * so the tag records where the document was born, not who touched it last.
 * A missing user row, NULL department, or lookup error is a silent no-op —
 * department tagging must never fail a create.
 */
async function departmentTagFor(userEmail: string): Promise<string | null> {
  if (!config.OIDC_DEPARTMENT_TAGGING) return null;
  try {
    const row = (await getDb().get(
      "SELECT department FROM users WHERE LOWER(email) = LOWER(?)",
      [userEmail],
    )) as { department?: string | null } | undefined;
    const slug = slugify(String(row?.department ?? ""));
    return slug ? normalizeTag(`dept:${slug}`) : null;
  } catch (err) {
    console.error("[dept-tag] department lookup failed (tag skipped):", err);
    return null;
  }
}

// Convert any thrown value into a client-safe error. Domain AppErrors
// (NotFound/Locked/Validation…) carry intentional, user-facing messages and
// pass through untouched. Anything else — engine faults, chain-break/integrity
// errors, filesystem/DB internals — is logged server-side and replaced with a
// generic message, so raw internals (paths, chain hashes, stack traces) never
// reach the API response OR the MCP result (both share this service).
function toSafeError(err: unknown, context: string, message: string): AppError {
  if (err instanceof AppError) return err;
  console.error(`${context}:`, err);
  return new AppError(500, message);
}

/** Strip YAML frontmatter from reconstructed markdown; mirrors node.body shape. */
export function bodyOnly(nodeId: string, raw: string): string {
  try {
    return parseDocument(`${nodeId}.md`, raw, nodeId).body ?? "";
  } catch {
    return raw;
  }
}

export interface NodeResponse {
  id: string;
  title: string;
  type: string;
  tags: string[];
  status: string;
  version: number;
  /** Creator email — frontmatter author when present, else the author of the
   *  node's first version. Null for old imported docs with neither. */
  author?: string | null;
  /** Everyone else with a hand in the doc: distinct node_versions authors
   *  UNION document-scope grant holders, minus the author, sorted. */
  collaborators?: string[];
  description?: string;
  created_at?: string;
  updated_at?: string;
  content: string;
  pendingChange?: any;
  /** Orchestrator hint for runnable nodes (type agent/skill) — free-form
   *  cron/interval string, opaque to the server. */
  schedule?: string;
}

/** Node types an orchestrator can fetch and run; only these carry schedule. */
export const RUNNABLE_NODE_TYPES = ["agent", "skill"] as const;
export function isRunnableType(type: string | undefined): boolean {
  return (RUNNABLE_NODE_TYPES as readonly string[]).includes(type || "");
}

export function toNodeResponse(node: ContextNode): NodeResponse {
  const fm = node.frontmatter;
  // Coerce string-ish fields. YAML parses bare values by type, so a
  // frontmatter line like `title: 123` arrives as a number — clients then
  // call `.trim()`/`.toLowerCase()` on it and crash. Normalize at the API
  // boundary so every surface (editor, list search, MCP) gets strings.
  const title =
    fm.title === undefined || fm.title === null ? "" : String(fm.title);
  const tags = Array.isArray(fm.tags) ? fm.tags.map((t) => String(t)) : [];
  return {
    id: node.id,
    title,
    type: fm.type || "document",
    tags,
    status: (fm.status || "draft") as string,
    version: fm.version || 1,
    author: fm.author,
    description: fm.description,
    created_at: fm.created_at,
    updated_at: fm.updated_at,
    content: node.body || "",
    pendingChange: node.pendingChange ?? undefined,
    // Same YAML-coercion rule as title above: `schedule: 123` parses as a
    // number — normalize to string at the API boundary.
    schedule:
      (fm.metadata as any)?.schedule != null
        ? String((fm.metadata as any).schedule)
        : undefined,
  };
}

export interface NodeAuthorship {
  author: string | null;
  collaborators: string[];
}

/**
 * Batch author + collaborator resolution for a set of nodes.
 *
 * Author = the node's frontmatter author (passed in by the caller) or, when
 * frontmatter lacks it (imports, older docs), the author of the node's first
 * version. Collaborators = distinct node_versions authors UNION document-scope
 * grant holders, MINUS the author, sorted.
 *
 * Exactly two queries regardless of node count (no per-node N+1): one grouped
 * pass over node_versions — per (node, author) the earliest version that
 * author touched, so the overall-earliest author doubles as the creator
 * fallback — and one pass over document grants joined to users for emails.
 * Both are plain GROUP BY / JOIN SQL, portable across SQLite and Postgres.
 * `system:*` version authors (auto-publish bumps, drift scans) mirror
 * machine activity, not a person — they're excluded.
 */
export async function resolveAuthorship(
  nestId: string,
  nodes: Array<{ id: string; frontmatterAuthor?: string | null }>,
): Promise<Map<string, NodeAuthorship>> {
  const result = new Map<string, NodeAuthorship>();
  if (nodes.length === 0) return result;
  const db = getDb();

  // Single-node fast path (the detail endpoint) narrows both scans by id;
  // the list path scans the nest once, grouped.
  const single = nodes.length === 1 ? nodes[0].id : null;
  const versionRows = (await db.all(
    `SELECT node_id, author, MIN(version) AS first_version
       FROM node_versions
      WHERE nest_id = ?${single ? " AND node_id = ?" : ""}
        AND author IS NOT NULL AND author NOT LIKE 'system:%'
      GROUP BY node_id, author`,
    single ? [nestId, single] : [nestId],
  )) as Array<{ node_id: string; author: string; first_version: number }>;
  const grantRows = (await db.all(
    `SELECT g.target AS node_id, u.email AS email
       FROM grants g
       JOIN users u ON u.id = g.user_id
      WHERE g.nest_id = ? AND g.target_type = 'document'${single ? " AND g.target = ?" : ""}`,
    single ? [nestId, single] : [nestId],
  )) as Array<{ node_id: string; email: string }>;

  const editorsByNode = new Map<string, Array<{ author: string; first: number }>>();
  for (const r of versionRows) {
    let list = editorsByNode.get(r.node_id);
    if (!list) editorsByNode.set(r.node_id, (list = []));
    list.push({ author: r.author, first: Number(r.first_version) });
  }
  const granteesByNode = new Map<string, string[]>();
  for (const g of grantRows) {
    let list = granteesByNode.get(g.node_id);
    if (!list) granteesByNode.set(g.node_id, (list = []));
    list.push(g.email);
  }

  for (const n of nodes) {
    const editors = editorsByNode.get(n.id) ?? [];
    const firstAuthor = editors.length
      ? editors.reduce((a, b) => (b.first < a.first ? b : a)).author
      : null;
    const author = n.frontmatterAuthor || firstAuthor;
    const authorKey = author ? author.toLowerCase() : null;
    // Distinct (case-insensitive), author excluded, sorted.
    const seen = new Set<string>();
    const collaborators: string[] = [];
    for (const email of [
      ...editors.map((e) => e.author),
      ...(granteesByNode.get(n.id) ?? []),
    ]) {
      const key = email.toLowerCase();
      if (key === authorKey || seen.has(key)) continue;
      seen.add(key);
      collaborators.push(email);
    }
    collaborators.sort((a, b) => a.localeCompare(b));
    result.set(n.id, { author: author ?? null, collaborators });
  }
  return result;
}

export interface ListNodesFilters {
  /** One type, or several (e.g. runnable types) to keep. */
  type?: string | readonly string[];
  tag?: string;
  limit?: number;
}

/**
 * Per-caller node list — applies stewardship gating, public-reader rules,
 * pending-change/status resolution. Single source of truth for REST GET
 * /nests/:id/nodes, MCP context_list, and any future surface.
 */
export async function listNodesForCaller(
  nestId: string,
  userId: string,
  filters: ListNodesFilters = {}
): Promise<NodeResponse[]> {
  const { storage, versions: versionManager } = await engineCache.get(nestId);
  let documents = await storage.discoverDocuments();

  // Cheap on-frontmatter filters first — narrows what we enrich below, so the
  // per-node governance/version work never runs on docs we'd discard anyway.
  if (filters.type) {
    const wanted = new Set(
      Array.isArray(filters.type) ? filters.type : [filters.type]
    );
    documents = documents.filter((n) => wanted.has(n.frontmatter.type));
  }
  if (filters.tag) {
    const tag = normalizeTag(filters.tag);
    documents = documents.filter((n) =>
      (n.frontmatter.tags || []).includes(tag)
    );
  }

  const userEmail = await resolveCallerEmail(userId);
  let accessible = await filterAccessible(nestId, userId, userEmail, documents);

  // Share grants: a caller with NO nest-wide permission sees exactly the
  // documents their grants cover — never the whole list. filterAccessible's
  // stewardship-OFF path returns the entire nest (open read), which must NOT
  // apply to a non-member, so narrow it to their grant-covered docs. With
  // stewardship ON, filterAccessible already restricted to
  // steward-accessible + grant-covered, so there's nothing to narrow.
  if (
    (await resolveNestPermission(nestId, userId)) === "none" &&
    !(await isStewardshipEnabled(nestId))
  ) {
    const grants = await listUserGrants(nestId, userId);
    accessible = grants.length
      ? documents.filter((d) => grantCoversNode(grants, d.id))
      : accessible;
  }
  const publicReader = await isPublicReader(nestId, userId);

  // Author + collaborators for exactly the post-filter set — two batched
  // queries for the whole list (see resolveAuthorship), never per-node.
  // Withheld from public readers: the roster is the nest's people, not its
  // published content, so it stays behind the same gate as the body. They
  // keep the frontmatter-only `author` toNodeResponse already set.
  const authorship = publicReader
    ? null
    : await resolveAuthorship(
      nestId,
      accessible.map((d) => ({
        id: d.id,
        frontmatterAuthor: d.frontmatter.author ?? null,
      })),
    );

  const enriched = await Promise.all(
    accessible.map(async (doc) => {
      const r = toNodeResponse(doc);
      const people = authorship?.get(doc.id);
      if (people) {
        r.author = people.author;
        r.collaborators = people.collaborators;
      }

      if (publicReader) {
        const approved = await versions.getApprovedVersion(nestId, doc.id);
        if (approved != null) {
          try {
            const raw = await versionManager.reconstructVersion(
              doc.id,
              approved
            );
            r.content = bodyOnly(doc.id, raw);
          } catch (err) {
            console.error(
              "reconstructVersion failed (list)",
              doc.id,
              approved,
              err
            );
            r.content = "";
          }
          r.version = approved;
          r.status = "published";
        }
        return r;
      }

      let pending: Awaited<ReturnType<typeof getPendingChange>> = null;
      try {
        pending = await getPendingChange(nestId, doc.id);
      } catch {
        pending = null;
      }
      if (pending) {
        r.pendingChange = pending;
        r.status = "external_edit_pending";
      } else {
        r.status = await versions.getDisplayStatus(nestId, r.id);
      }
      return r;
    })
  );

  return filters.limit ? enriched.slice(0, filters.limit) : enriched;
}

/** Email-keyed wrapper for callers that don't have userId in hand (MCP tools). */
export async function listNodesForCallerByEmail(
  nestId: string,
  userEmail: string,
  filters: ListNodesFilters = {}
): Promise<NodeResponse[]> {
  return listNodesForCaller(nestId, await userIdFromEmail(userEmail), filters);
}

export interface CreateNodeInput {
  title: string;
  content: string;
  type?: string;
  tags?: string[];
  scope?: string;
  status?: string;
  /** Explicit node id (e.g. "nodes/foo"). When omitted the id is derived from
   *  the title slug. Used by derived/system nodes that need a deterministic,
   *  collision-free id independent of the human-readable title. */
  id?: string;
  /** Orchestrator schedule (cron/interval string, opaque to the server).
   *  Only valid for runnable types (agent/skill). */
  schedule?: string;
  /** Folder path under nodes/ (e.g. "gtm/deals"). Each segment is slugified;
   *  storage and read/update/delete already handle nested ids, only creation
   *  was flat. Ignored when an explicit id is given. */
  folder?: string;
}

export interface UpdateNodePatch {
  content?: string;
  append?: string;
  tags?: string[];
  title?: string;
  status?: string;
  changeNote?: string;
  /** Orchestrator schedule — runnable types only; empty string clears it. */
  schedule?: string;
}

export interface NodeMutationResult {
  node: ContextNode;
  version: number;
}

/**
 * Owner/admin edits skip the review queue when the nest opts into self-approve:
 * their create/update publishes immediately instead of landing as a draft that
 * needs submit-review + approval. This is the meaning of the "Allow self-approve"
 * nest flag — a governance bypass for the two roles that already hold approval
 * rights, NOT a change to the editor/reviewer flow (they still draft → review →
 * approve regardless of the flag). Reviewer/editor callers return false here.
 */
async function actorAutoPublishes(
  nestId: string,
  userEmail: string
): Promise<boolean> {
  if (!(await nestAllowsSelfApprove(nestId))) return false;
  const roles = await resolveUserRoles(nestId, userEmail);
  return roles.includes("owner") || roles.includes("admin");
}

export async function createNode(
  nestId: string,
  input: CreateNodeInput,
  userEmail: string
): Promise<NodeMutationResult> {
  const { storage, versions: versionManager } = await engineCache.get(nestId);

  assertTitleLength(input.title);
  // The id slug is derived, not user-facing: a title within MAX_TITLE_LENGTH
  // can still slugify past the 100-char path-segment bound, so truncate rather
  // than reject. Keeps storage.writeDocument off ENAMETOOLONG without making
  // a legal title a 400. (Two titles sharing their first 100 slug chars
  // collide on id — same as two identical titles already do.)
  // Order matters: slice THEN strip. A cut can land right after a run of
  // dashes, so stripping first would leave a trailing "-" on the id.
  const slug = slugify(input.title).slice(0, 100).replace(/-+$/, "");
  // Slugifying per segment means "../x" or absolute paths can never escape
  // the vault — traversal characters collapse to "-" and empty segments drop.
  // An explicit id wins outright: folder is documented as ignored then, so
  // it isn't derived or validated either.
  let id = input.id;
  if (!id) {
    const folderSegments = folderToSegments(input.folder ?? "");
    id =
      folderSegments.length > 0
        ? `nodes/${folderSegments.join("/")}/${slug}`
        : `nodes/${slug}`;
  }
  const now = new Date().toISOString();
  const tags = (input.tags || []).map(normalizeTag);

  // Content-type toggles: creation of a disabled type is refused here — the
  // shared choke point for REST + MCP — so every surface gates identically.
  // Soft-disable only: existing nodes of a disabled type still read/render/
  // version untouched. Runnable types (agent/skill/tool) are gated by
  // FEATURE_WORKFLOW_PLANE at the plane routes, not here.
  const requestedType = input.type || "document";
  if (requestedType === "artifact" && !config.TYPE_ARTIFACT_ENABLED) {
    throw new ValidationError("Artifact nodes are disabled on this server");
  }
  if (requestedType === "table" && !config.TYPE_TABLE_ENABLED) {
    throw new ValidationError("Table nodes are disabled on this server");
  }

  if (input.schedule !== undefined && !isRunnableType(input.type)) {
    throw new ValidationError(
      `schedule is only valid for runnable node types (${RUNNABLE_NODE_TYPES.join(
        ", "
      )})`
    );
  }

  // A create must never land on an id that is already taken. writeDocument
  // overwrites, so a second create at the same folder+title silently replaced
  // the first document's body and restarted its version history — the caller
  // got a 201 and no hint anything was lost (CU-wdqcpzxcg8). moveNode already
  // refuses an occupied destination; create now agrees. Reading the id
  // directly costs one file read, not a vault scan.
  let occupied = false;
  try {
    await storage.readDocument(id);
    occupied = true;
  } catch {
    // Nothing there — the id is free.
  }
  if (occupied) {
    throw new ConflictError(
      `A document already exists at ${id}. Update it, or create this one under a different folder or title.`,
    );
  }

  // Optional dept:<slug> auto-tag — after the validations above so a request
  // that fails them never pays the DB lookup. Deduped case-insensitively
  // against the user-supplied tags (normalizeTag keeps the user's casing, so
  // "#Dept:Engineering" must still match the all-lowercase auto tag).
  const deptTag = await departmentTagFor(userEmail);
  if (deptTag && !tags.some((t) => t.toLowerCase() === deptTag)) {
    tags.push(deptTag);
  }

  const hasStewards = await isStewardshipEnabled(nestId);
  // Ungoverned always publishes; a governed nest publishes too when an
  // owner/admin creates it under self-approve (their work bypasses review).
  const autoPublish = !hasStewards || (await actorAutoPublishes(nestId, userEmail));
  const initialStatus = autoPublish ? "published" : "draft";
  // Publish path starts at v=0 so the engine publish bump lands at v=1.
  const initialVersion = autoPublish ? 0 : 1;

  let node: ContextNode = {
    id,
    filePath: "",
    frontmatter: {
      title: input.title,
      type: requestedType as any,
      tags,
      status: (input.status as any) || (initialStatus as any),
      version: initialVersion,
      created_at: now,
      updated_at: now,
      metadata: {
        owners: ["*"],
        scope: input.scope || "team",
        ...(input.schedule ? { schedule: input.schedule } : {}),
      } as any,
    },
    body: input.content,
    rawContent: "",
  };
  await storage.writeDocument(id, serializeDocument(node));
  await syncNodeTags(nestId, id, tags);

  let savedVersion = 1;
  if (!autoPublish) {
    try {
      await versionManager.createVersion(node, userEmail);
    } catch (err) {
      console.error("VersionManager.createVersion failed (node create)", err);
    }
    await versions.createVersion({
      nestId,
      nodeId: id,
      version: 1,
      content: input.content,
      author: userEmail,
      status: "draft",
      tags,
    });
  } else {
    try {
      const result = await safePublishDocument(storage, id, {
        editedBy: userEmail,
        note: hasStewards
          ? "Auto-published on create (owner/admin self-approve)"
          : "Auto-published on create (no stewards configured)",
      });
      savedVersion = result.node.frontmatter.version || 1;
      await versions.createVersion({
        nestId,
        nodeId: id,
        version: savedVersion,
        content: result.node.body || "",
        author: userEmail,
        status: "published",
        tags,
      });
      await versions.setApprovedVersion(nestId, id, savedVersion, userEmail);
      node = result.node;
    } catch (err) {
      console.error("publishDocument failed (node create auto-publish)", err);
      await versions.createVersion({
        nestId,
        nodeId: id,
        version: 1,
        content: input.content,
        author: userEmail,
        status: "draft",
        tags,
      });
    }
  }

  await trackEvent("node.create", { nestId, nodeId: id });
  return { node, version: savedVersion };
}

/**
 * The EXPLICIT lifecycle status the source author gave a doc, canonicalized via
 * the engine's `normalizeStatus`, or null if the frontmatter carried no
 * `status:` at all.
 *
 * The engine's parser defaults a missing status to "draft", so
 * `node.frontmatter.status` can't tell an explicit draft from a status-less
 * Obsidian file — we scan the raw source instead. Normalizing means aliases
 * (`review`, `submitted`, `in_review`, …) collapse to their canonical status
 * (e.g. `pending_review`), so an import can't smuggle a not-yet-approved doc
 * past the keep-unpublished gate by spelling its status differently.
 */
function explicitFrontmatterStatus(raw: string): string | null {
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const m = fm[1].match(/^status:[ \t]*["']?([A-Za-z_-]+)["']?[ \t]*$/m);
  return m ? normalizeStatus(m[1]) : null;
}

/**
 * Reset a single imported doc to a clean, publishable base.
 *
 * An imported folder can be a previously-exported (or half-migrated)
 * ContextNest vault carrying an engine version chain — a keyframe plus diffs
 * under `<dir>/.versions/<name>/` — that no longer reconstructs (e.g. the diff
 * for an intermediate version won't apply). Publishing then throws
 * "Failed to apply diff for version N". This drops the stale per-doc history
 * and strips the frontmatter `version`/`checksum` so the next publish starts a
 * fresh v1 keyframe. Only called on docs whose as-is publish already failed,
 * so valid chains are left untouched (preserve-when-valid).
 *
 * NOTE: reaching into the engine's `.versions/` layout is engine-internal
 * territory (see CLAUDE.md Engine Logic Boundary). It lives here as a stopgap;
 * the durable fix is an engine-side `resetVersionChain()` API to consume,
 * bundled with the pending `deferCheckpoint` upstream work.
 */
async function resetImportedDocForPublish(
  storage: NestStorage,
  nestId: string,
  nodeId: string
): Promise<void> {
  // Engine history layout: `<root>/<docDir>/.versions/<docName>/`.
  const versionsDir = join(
    resolveNestPath(nestId),
    dirname(nodeId),
    ".versions",
    basename(nodeId)
  );
  await rm(versionsDir, { recursive: true, force: true });

  const node = await storage.readDocument(nodeId);
  const fm = { ...node.frontmatter };
  delete (fm as Record<string, unknown>).version;
  delete (fm as Record<string, unknown>).checksum;
  await storage.writeDocument(nodeId, serializeDocument({ ...node, frontmatter: fm }));
}

/**
 * Register the documents already present in an imported folder.
 *
 * On import the nest row exists but the governance DB is empty, so the
 * existing on-disk documents have no version/approved/tag rows. Without
 * them the docs still list (discovery is disk-based) but show as "draft"
 * and editing wouldn't continue from their real version.
 *
 * This walks the folder's documents once. Docs the source marked not-yet-
 * approved (draft/rejected/superseded) are registered in a draft state and NOT
 * force-published — they become AI-visible only after review in the new nest
 * (and the engine hard-refuses to publish a rejected doc anyway). Every other
 * doc is run through the engine's publish (safePublishDocument) so it gains a
 * published checksum + a version-chain keyframe and context.yaml is regenerated
 * — exactly the no-stewards auto-publish path createNode uses. That is what
 * makes an imported doc usable by AI: GraphQueryEngine/Resolver only return
 * *published* documents, and public/shared readers reconstruct the approved
 * body from the keyframe. A valid .versions chain copied on import is preserved
 * (publish appends to it); an inconsistent chain that won't reconstruct is
 * reset to a fresh v1 and retried once, so a broken chain never drops the doc.
 * Each published doc is then seeded with a published+approved governance row at
 * its published version, plus its tag index. Idempotent: docs that already
 * carry a version row are skipped, so re-running is safe.
 *
 * Returns the number of documents newly registered.
 */
export async function registerImportedDocuments(
  nestId: string,
  userEmail: string,
  onProgress?: (done: number, total: number) => void | Promise<void>
): Promise<number> {
  const { storage } = await engineCache.get(nestId);
  let docs: ContextNode[];
  try {
    docs = await storage.discoverDocuments();
  } catch (err) {
    console.error("registerImportedDocuments: discovery failed", nestId, err);
    return 0;
  }

  const startedAt = Date.now();
  console.log(`[import] register: discovered=${docs.length} nest=${nestId}`);
  await onProgress?.(0, docs.length);
  let registered = 0;
  let alreadyTracked = 0;
  let publishFailed = 0;
  let publishRecovered = 0;
  let keptUnpublished = 0;
  let processed = 0;
  for (let doc of docs) {
    const nodeId = doc.id;
    await onProgress?.(++processed, docs.length);
    if ((await versions.getCurrentVersion(nestId, nodeId)) > 0) {
      alreadyTracked++;
      continue; // already tracked
    }

    // Normalize ownership + title on import, persisted BEFORE publish so both
    // stick on disk:
    //  - Author/owner is ALWAYS the importer. The vault's own `author:` names
    //    someone who isn't a user on this instance (e.g. stacey@…) — showing
    //    them as creator is wrong, and because the doc's version author is the
    //    importer, an author≠importer mismatch also fabricates a phantom
    //    "1 collaborator". Overwriting author fixes both.
    //  - A title-less doc falls back to its filename (leaf of the node id).
    const title = doc.frontmatter?.title ?? (nodeId.split("/").pop() || nodeId);
    doc = { ...doc, frontmatter: { ...doc.frontmatter, title, author: userEmail } };
    try {
      await storage.writeDocument(nodeId, serializeDocument(doc));
    } catch (err) {
      console.error("import: failed to persist import metadata", nodeId, err);
    }

    const rawTags = Array.isArray(doc.frontmatter?.tags)
      ? doc.frontmatter.tags
      : [];
    const tags = rawTags.map((t) => normalizeTag(String(t)));

    // Only trust an integer > 0 as the incoming version; junk like "3.011"
    // falls back to 1 (the fresh-publish path replaces it anyway).
    const fmVersion = Number(doc.frontmatter?.version);
    let version = Number.isInteger(fmVersion) && fmVersion > 0 ? fmVersion : 1;
    let content = doc.body || "";

    // Docs the source EXPLICITLY marked not-yet-approved are registered as
    // draft and NOT force-published — honors the imported governance state
    // (and the engine refuses to publish a rejected doc regardless). Anything
    // that isn't published/approved (draft, pending_review, rejected,
    // superseded, or an unknown status) is kept unpublished; a status-less doc
    // still takes the publish path below.
    const status = explicitFrontmatterStatus(doc.rawContent);
    if (status && status !== "published" && status !== "approved") {
      await versions.createVersion({
        nestId,
        nodeId,
        version,
        content,
        author: userEmail,
        status: "draft",
        changeNote: "Imported from existing folder (kept unpublished)",
        tags,
      });
      await syncNodeTags(nestId, nodeId, tags);
      keptUnpublished++;
      registered++;
      continue;
    }

    // Publish in the engine so the doc is AI-visible (published status +
    // checksum + keyframe). If the imported version chain is inconsistent and
    // publish throws, reset the doc to a fresh base and retry once; if it
    // still fails, register as draft rather than fake a published row.
    let published = false;
    try {
      const result = await safePublishDocument(storage, nodeId, {
        editedBy: userEmail,
        note: "Imported from existing folder",
      });
      version = result.node.frontmatter.version || version;
      content = result.node.body || content;
      published = true;
    } catch (err) {
      // Expected for docs carrying an inconsistent imported chain — the reset
      // below recovers them. Log a quiet one-liner, not the full stack, so a
      // handled failure doesn't read as a broken import.
      console.warn(
        `[import] publish retry needed for ${nodeId}: ${(err as Error)?.message ?? err}`,
      );
      try {
        await resetImportedDocForPublish(storage, nestId, nodeId);
        const result = await safePublishDocument(storage, nodeId, {
          editedBy: userEmail,
          note: "Imported from existing folder (reset chain)",
        });
        version = result.node.frontmatter.version || 1;
        content = result.node.body || content;
        published = true;
        publishRecovered++;
      } catch (err2) {
        publishFailed++;
        console.error(
          "reset+republish failed (import register)",
          nodeId,
          err2
        );
      }
    }

    await versions.createVersion({
      nestId,
      nodeId,
      version,
      content,
      author: userEmail,
      status: published ? "published" : "draft",
      changeNote: "Imported from existing folder",
      tags,
    });
    if (published) {
      await versions.setApprovedVersion(nestId, nodeId, version, userEmail);
    }
    await syncNodeTags(nestId, nodeId, tags);
    registered++;
  }

  console.log(
    `[import] register done: registered=${registered} alreadyTracked=${alreadyTracked} keptUnpublished=${keptUnpublished} publishRecovered=${publishRecovered} publishFailed=${publishFailed} tookMs=${Date.now() - startedAt}`,
  );
  await trackEvent("nest.import.documents", { nestId, registered });
  return registered;
}

export async function updateNode(
  nestId: string,
  nodeId: string,
  patch: UpdateNodePatch,
  userEmail: string
): Promise<NodeMutationResult> {
  return withNodeWriteLock(nodeWriteKey(nestId, nodeId), async () => {
    try {
      const { storage, versions: versionManager } = await engineCache.get(
        nestId
      );

      let node: ContextNode;
      try {
        node = await storage.readDocument(nodeId);
      } catch {
        throw new NotFoundError(`Node not found: ${nodeId}`);
      }

      if (patch.content !== undefined) {
        node = { ...node, body: patch.content };
      }
      if (patch.append) {
        node = { ...node, body: (node.body || "") + "\n\n" + patch.append };
      }
      if (patch.tags) {
        const newTags = patch.tags.map(normalizeTag);
        const merged = [
          ...new Set([...(node.frontmatter.tags || []), ...newTags]),
        ];
        node = { ...node, frontmatter: { ...node.frontmatter, tags: merged } };
      }
      if (patch.status) {
        node = {
          ...node,
          frontmatter: { ...node.frontmatter, status: patch.status as any },
        };
      }
      if (patch.title) {
        // Grandfathered: docs saved before this bound existed keep their long
        // title. The editor sends `title` on EVERY save, so a flat check would
        // make those docs unsavable — enforce only on an actual rename.
        if (patch.title !== node.frontmatter.title) {
          assertTitleLength(patch.title);
        }
        node = {
          ...node,
          frontmatter: { ...node.frontmatter, title: patch.title },
        };
      }
      if (patch.schedule !== undefined) {
        if (!isRunnableType(node.frontmatter.type)) {
          throw new ValidationError(
            `schedule is only valid for runnable node types (${RUNNABLE_NODE_TYPES.join(
              ", "
            )})`
          );
        }
        const metadata = { ...(node.frontmatter.metadata as any) };
        if (patch.schedule === "") delete metadata.schedule;
        else metadata.schedule = patch.schedule;
        node = { ...node, frontmatter: { ...node.frontmatter, metadata } };
      }

      const hasStewards = await isStewardshipEnabled(nestId);
      // Owner/admin edits publish straight through when the nest opts into
      // self-approve; editors/reviewers still draft → review → approve.
      const autoPublish =
        !hasStewards || (await actorAutoPublishes(nestId, userEmail));
      const currentTags = (node.frontmatter.tags || []) as string[];

      // Stewardship lock: a node with an open review request is frozen for
      // everyone EXCEPT its own author. A teammate's pending review is what
      // the steward is evaluating, so their edits are rejected (423) until it
      // resolves. The author, though, may keep revising their own submission —
      // the edit lands as a new draft version and the open review repoints to
      // it (see repointPendingReview below), so the steward reviews the final
      // edited version without the author having to withdraw and resubmit.
      const pendingReview = hasStewards
        ? await getPendingReview(nestId, nodeId)
        : null;
      const isAuthorEditingOwnReview =
        !!pendingReview &&
        pendingReview.requestedBy.toLowerCase() === userEmail.toLowerCase();
      if (pendingReview && !isAuthorEditingOwnReview) {
        throw new LockedError(
          "This document is awaiting steward review and is locked. Approve or reject the pending review before editing."
        );
      }

      let responseVersion: number;
      // Author editing their own pending review always drafts a new version
      // (never auto-publishes past the reviewer), then repoints the review.
      if (!autoPublish || isAuthorEditingOwnReview) {
        const currentVersion = await versions.getCurrentVersion(nestId, nodeId);
        const newVersion = currentVersion + 1;
        node = {
          ...node,
          frontmatter: {
            ...node.frontmatter,
            version: newVersion,
            updated_at: new Date().toISOString(),
            // Drop stale published-state checksum so the next verified read
            // doesn't flag this write as external drift.
            checksum: undefined,
          },
        };
        node = { ...node, frontmatter: stripUndefined(node.frontmatter) };
        await storage.writeDocument(nodeId, serializeDocument(node));
        await syncNodeTags(nestId, nodeId, currentTags);

        // Persist to the engine history FIRST, then mirror into the DB. If the
        // engine append fails (e.g. a broken diff chain), rethrow so we DON'T
        // record a DB version the engine never stored — that silent swallow is
        // what let node_versions drift ahead of history.yaml (DB v19 vs v15).
        try {
          await versionManager.createVersion(node, userEmail, {
            note: patch.changeNote,
          });
        } catch (err) {
          console.error(
            "VersionManager.createVersion failed (node patch)",
            err
          );
          throw err;
        }
        await versions.createVersion({
          nestId,
          nodeId,
          version: newVersion,
          content: node.body || "",
          author: userEmail,
          status: "draft",
          tags: currentTags,
          changeNote: patch.changeNote,
        });
        // Author revised their own pending submission: move the open review
        // onto this fresh version so the steward approves the edited content.
        if (isAuthorEditingOwnReview) {
          await repointPendingReview({ nestId, nodeId, newVersion });
        }
        responseVersion = newVersion;
      } else {
        node = {
          ...node,
          frontmatter: {
            ...node.frontmatter,
            updated_at: new Date().toISOString(),
            checksum: undefined,
          },
        };
        node = { ...node, frontmatter: stripUndefined(node.frontmatter) };
        await storage.writeDocument(nodeId, serializeDocument(node));
        await syncNodeTags(nestId, nodeId, currentTags);

        let publishedVersion = (node.frontmatter.version || 0) + 1;
        // Publish through the engine FIRST; only mirror into the DB once it
        // actually landed. Rethrow on failure — swallowing here is what let
        // node_versions climb past what history.yaml stored (DB v19 vs v15).
        try {
          const result = await safePublishDocument(storage, nodeId, {
            editedBy: userEmail,
            note:
              patch.changeNote ||
              (hasStewards
                ? "Auto-published on edit (owner/admin self-approve)"
                : "Auto-published on edit (no stewards)"),
          });
          publishedVersion =
            result.node.frontmatter.version || publishedVersion;
          node = result.node;
        } catch (err) {
          console.error(
            "publishDocument failed (node patch auto-publish)",
            err
          );
          throw err;
        }
        // upsert, not insert: the engine publishes a draft in place (draft N →
        // published N, no version bump), so a governance row may already exist
        // at this version (e.g. an imported draft). A plain insert here hit
        // UNIQUE(nest_id, node_id, version) when editing such a draft.
        await versions.upsertVersion({
          nestId,
          nodeId,
          version: publishedVersion,
          content: node.body || "",
          author: userEmail,
          status: "published",
          tags: currentTags,
          changeNote: patch.changeNote,
        });
        await versions.setApprovedVersion(
          nestId,
          nodeId,
          publishedVersion,
          userEmail
        );
        responseVersion = publishedVersion;
      }

      return { node, version: responseVersion };
    } catch (err) {
      // One boundary: domain errors (NotFound/Locked/Validation) pass through
      // with their intended messages; engine/internal faults become a generic
      // safe message. Same result for REST and MCP callers — neither leaks
      // internals.
      throw toSafeError(
        err,
        `updateNode failed (${nestId}/${nodeId})`,
        "Couldn't save your changes. Please reload the document and try again."
      );
    }
  });
}

/** Mirror of annotations/service.ts derivedAnnotationsId — duplicated here
 *  because importing it would close the annotations→nodes import cycle. */
function derivedIdOf(sourceNodeId: string): string {
  return `nodes/${sourceNodeId.replace(/^nodes\//, "")}--annotations`;
}

export interface MoveNodeResult {
  node: ContextNode;
  previousId: string;
}

/**
 * Move a node to another folder, preserving everything keyed to its id:
 * version history (DB rows + on-disk .versions chain), review state,
 * approved-version pin, annotations, comments, workflow edges, document
 * grants, document-scoped stewards, and run traces. The id changes
 * (nodes/<folder…>/<leaf>); the leaf slug and title do not, so [[Title]]
 * wiki-links keep resolving.
 *
 * Folder grants intentionally do NOT follow the doc — they cover a path
 * prefix, so a doc moved out of a shared folder leaves that share and a
 * doc moved into one joins it. That asymmetry is the feature.
 */
export async function moveNode(
  nestId: string,
  nodeId: string,
  folder: string,
  userEmail: string,
): Promise<MoveNodeResult> {
  const { storage } = await engineCache.get(nestId);

  let node: ContextNode;
  try {
    node = await storage.readDocument(nodeId);
  } catch {
    throw new NotFoundError(`Node not found: ${nodeId}`);
  }

  // Same freeze as edit/delete: a node under open review is what the
  // reviewer is looking at — its identity can't change mid-review.
  if ((await isStewardshipEnabled(nestId)) && (await getPendingReview(nestId, nodeId))) {
    throw new LockedError(
      "This document is awaiting steward review and is locked. Approve or reject the pending review before moving.",
    );
  }

  const leaf = nodeId.split("/").pop()!;
  const segments = folderToSegments(folder);
  const newId =
    segments.length > 0 ? `nodes/${segments.join("/")}/${leaf}` : `nodes/${leaf}`;
  if (newId === nodeId) return { node, previousId: nodeId };

  try {
    await storage.readDocument(newId);
    throw new ConflictError(
      `A document already exists at that location: ${newId}`,
    );
  } catch (err) {
    if (err instanceof ConflictError) throw err;
    /* target free — proceed */
  }

  const moved: ContextNode = {
    ...node,
    id: newId,
    frontmatter: {
      ...node.frontmatter,
      updated_at: new Date().toISOString(),
    },
  };
  await storage.writeDocument(newId, serializeDocument(moved));

  // Carry the engine's on-disk version chain (.versions/<leaf>/ next to the
  // doc) so reconstructVersion keeps working for pre-move versions. Layout is
  // engine-owned, so this is best-effort: if the chain isn't where the
  // structured layout puts it (e.g. flat imported nests), history still
  // serves from the governance DB rows migrated below.
  try {
    const nestPath = resolveNestPath(nestId);
    const oldChain = join(nestPath, dirname(nodeId), ".versions", leaf);
    const newChain = join(nestPath, dirname(newId), ".versions", leaf);
    if (oldChain !== newChain) {
      await mkdir(dirname(newChain), { recursive: true });
      await rename(oldChain, newChain);
    }
  } catch {
    /* no on-disk chain to carry */
  }

  await storage.deleteDocument(nodeId);

  // Rewrite every table that keys on the node id — the same reference set
  // DELETE purges, plus workflow edges, grants, and run traces. One
  // transaction: a half-moved node would be worse than a failed move.
  const oldDerived = derivedIdOf(nodeId);
  const newDerived = derivedIdOf(newId);
  const db = getDb();
  await db.transaction(async (tx) => {
    for (const [table, column] of [
      ["node_versions", "node_id"],
      ["review_requests", "node_id"],
      ["approved_versions", "node_id"],
      ["annotation_threads", "node_id"],
      ["comments", "node_id"],
      ["node_tag_index", "node_id"],
    ] as const) {
      await tx.run(
        `UPDATE ${table} SET ${column} = ? WHERE nest_id = ? AND ${column} = ?`,
        [newId, nestId, nodeId],
      );
      await tx.run(
        `UPDATE ${table} SET ${column} = ? WHERE nest_id = ? AND ${column} = ?`,
        [newDerived, nestId, oldDerived],
      );
    }
    await tx.run(
      `UPDATE stewards SET node_pattern = ?
       WHERE nest_id = ? AND scope = 'document' AND node_pattern = ?`,
      [newId, nestId, nodeId],
    );
    await tx.run(
      `UPDATE grants SET target = ?
       WHERE nest_id = ? AND target_type = 'document' AND target = ?`,
      [newId, nestId, nodeId],
    );
    await tx.run(
      "UPDATE edges SET from_node = ? WHERE nest_id = ? AND from_node = ?",
      [newId, nestId, nodeId],
    );
    await tx.run(
      "UPDATE edges SET to_node = ? WHERE nest_id = ? AND to_node = ?",
      [newId, nestId, nodeId],
    );
    await tx.run(
      "UPDATE runs SET agent_node = ? WHERE nest_id = ? AND agent_node = ?",
      [newId, nestId, nodeId],
    );
    await tx.run(
      `UPDATE run_steps SET node_id = ?
       WHERE node_id = ? AND run_id IN (SELECT id FROM runs WHERE nest_id = ?)`,
      [newId, nodeId, nestId],
    );
  });

  // The derived annotations node (if any) lives beside its source — move its
  // storage doc too. Best-effort, same as delete's handling of it.
  try {
    const derivedDoc = await storage.readDocument(oldDerived);
    await storage.writeDocument(
      newDerived,
      serializeDocument({ ...derivedDoc, id: newDerived }),
    );
    await storage.deleteDocument(oldDerived);
  } catch {
    /* no derived annotations node */
  }

  await trackEvent("node.move", { nestId, nodeId, newId });
  return { node: moved, previousId: nodeId };
}

/**
 * Delete a node and every row keyed to its id. Lives here rather than in the
 * DELETE handler because MCP's context_delete needs the identical purge — a
 * second copy would drift the moment a new node-scoped table lands.
 *
 * Permission is the CALLER's job (REST: the nest permission middleware in
 * app.ts; MCP: the per-tool canUserEdit check). This function enforces only
 * the stewardship lock and does the cleanup.
 */
export async function deleteNode(
  nestId: string,
  nodeId: string,
  userEmail: string,
): Promise<void> {
  const { storage } = await engineCache.get(nestId);

  // Stewardship lock: a node under open review can't be deleted out from
  // under the reviewer (423). Mirrors the edit lock in updateNode.
  if ((await isStewardshipEnabled(nestId)) && (await getPendingReview(nestId, nodeId))) {
    throw new LockedError(
      "This document is awaiting steward review and is locked. Approve or reject the pending review before deleting.",
    );
  }

  try {
    await storage.deleteDocument(nodeId);
  } catch {
    throw new NotFoundError(`Node not found: ${nodeId}`);
  }

  await removeNodeFromTagIndex(nestId, nodeId);

  // A node's review comments and its derived annotations node are tied to the
  // node id, not FK'd to it — so deleting the node would otherwise orphan both.
  // Remove the derived `— Annotations` node's storage doc (best-effort: plain
  // documents and never-commented artifacts have none) here; its DB rows and
  // the annotation threads themselves are purged in the transaction below.
  const derivedId = derivedIdOf(nodeId);
  try {
    await storage.deleteDocument(derivedId);
    await removeNodeFromTagIndex(nestId, derivedId);
  } catch {
    /* no derived annotations node — nothing to remove */
  }

  // Purge governance rows tied to this node id. Without this, recreating
  // a doc with the same title (→ same slug → same node id) hits a UNIQUE
  // constraint on node_versions(nest_id, node_id, version) because the
  // old version rows still exist. We also drop pending/historic review
  // requests and the approved-version pin so the recreated doc starts
  // from a clean slate.
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx.run(
      "DELETE FROM node_versions WHERE nest_id = ? AND node_id = ?",
      [nestId, nodeId],
    );
    await tx.run(
      "DELETE FROM review_requests WHERE nest_id = ? AND node_id = ?",
      [nestId, nodeId],
    );
    await tx.run(
      "DELETE FROM approved_versions WHERE nest_id = ? AND node_id = ?",
      [nestId, nodeId],
    );
    // Document-scoped steward rows pin to this exact node_pattern. Tag
    // and nest-scoped stewards stay — they govern the whole nest, not
    // this single doc. Without this purge, recreating a doc with the
    // same slug silently inherits the prior doc's reviewer assignments.
    await tx.run(
      `DELETE FROM stewards
       WHERE nest_id = ? AND scope = 'document' AND node_pattern = ?`,
      [nestId, nodeId],
    );
    // Annotation threads for this node — comments cascade via the thread FK.
    await tx.run(
      "DELETE FROM annotation_threads WHERE nest_id = ? AND node_id = ?",
      [nestId, nodeId],
    );
    // The derived annotations node's own rows (version history it accrued, plus
    // any stray threads if someone commented on it before this cleanup existed).
    await tx.run(
      "DELETE FROM node_versions WHERE nest_id = ? AND node_id = ?",
      [nestId, derivedId],
    );
    await tx.run(
      "DELETE FROM review_requests WHERE nest_id = ? AND node_id = ?",
      [nestId, derivedId],
    );
    await tx.run(
      "DELETE FROM approved_versions WHERE nest_id = ? AND node_id = ?",
      [nestId, derivedId],
    );
    await tx.run(
      "DELETE FROM annotation_threads WHERE nest_id = ? AND node_id = ?",
      [nestId, derivedId],
    );
    // Deletion tombstone — the one record that survives the purge above, so
    // GET /changes can tell external mirrors a doc was removed. Upsert:
    // delete → recreate → delete again just refreshes the timestamp.
    await tx.run(
      `INSERT INTO node_deletions (nest_id, node_id, deleted_by, deleted_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(nest_id, node_id) DO UPDATE
         SET deleted_by = excluded.deleted_by, deleted_at = excluded.deleted_at`,
      [nestId, nodeId, userEmail, new Date().toISOString()],
    );
  });

  await trackEvent("node.delete", { nestId, nodeId });
}
