/**
 * Node lifecycle service — shared by REST routes and MCP tools so
 * disk + DB stay in lockstep across both surfaces. Handlers stay thin
 * (auth, parse, response shape); this module owns create/update/list.
 */
import {
  parseDocument,
  normalizeStatus,
  isRejected,
  DocumentNotFoundError,
} from "@promptowl/contextnest-engine";
import type { ContextNode, NestStorage } from "@promptowl/contextnest-engine";
import { rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { safePublishDocument, serializeNodeSafe } from "../governance/safe-publish.js";
import { engineCache, engineApi, opContext } from "./engine.js";
import { inputJsonSchema } from "@promptowl/contextnest-engine/api";
import {
  AppError,
  NotFoundError,
  LockedError,
  ValidationError,
  ConflictError,
  ForbiddenError,
} from "../shared/errors.js";
import { trackEvent } from "../telemetry/tracker.js";
import * as versions from "../governance/version-service.js";
import { syncNodeTags, removeNodeFromTagIndex } from "../governance/tag-index-service.js";
import {
  isStewardshipEnabled,
  resolveNestPath,
  nestAllowsSelfApprove,
  nestReviewsPrimeOnly,
} from "../nests/service.js";
import { isPrimeDocument, documentPrimeFlag } from "../governance/prime-service.js";
import { getPendingReview, repointPendingReview } from "../governance/review-service.js";
import { resolveUserRoles } from "../governance/stewardship-service.js";
import { canApproveWith } from "../governance/roles.js";
import {
  resolveCallerEmail,
  filterAccessible,
  canReadNode,
} from "../governance/access-guard.js";
import { isPublicReader } from "../shared/access.js";
import {
  listUserGrants,
  grantRoleForNode,
} from "../governance/grants-service.js";
import {
  getPendingChange,
  documentsWithSuggestions,
} from "../governance/external-edit-service.js";
import { getDb } from "../db/client.js";
import type { Querier } from "../db/adapter.js";
import { ANON_USER_ID, MAX_FOLDER_DEPTH } from "../shared/constants.js";
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

/** Result shape of the engine's `context_import` operation. A failed entry
 *  carries `id` (ids[] mode) or `title` (documents[] mode), never both. */
type ImportOpResult = {
  published: { id: string; version: number }[];
  failed: { id?: string; title?: string; error: string }[];
  checkpoint: number | null;
};

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

/**
 * The engine refuses a title with no letter or number at all ("###", "...",
 * spaces) — it cannot be read back by search or wiki links. Raise that as a
 * 400 here, at the choke point REST and MCP share, rather than letting it
 * surface as a 500 from deep inside a publish. Letter/number is Unicode-wide:
 * "日本語のみ" is letters, and only the derived id needs ASCII.
 */
function assertTitleReadable(title: string): void {
  if (!/[\p{L}\p{N}]/u.test(title)) {
    throw new ValidationError(
      "the title needs at least one letter or number — it is what search and " +
        "wiki links read back",
    );
  }
}

/**
 * Ids are ASCII path segments, but a title is whatever the author wrote.
 * Decompose first (NFKD) and drop the combining marks, so "Café Résumé"
 * derives `cafe-resume` instead of `caf-r-sum` — the accents are stripped from
 * the letters they sit on rather than taking the letters with them. A script
 * with no ASCII form at all (CJK, Cyrillic, Arabic) still slugifies to "";
 * createNode falls back to a generated id there rather than refusing the title.
 */
const slugify = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * The id for a title that carries no ASCII at all: document-1, document-2, …,
 * the first one free in this folder. The title stays exactly what the author
 * typed; only the path is ASCII.
 *
 * ponytail: linear probe. Fine while such titles are a minority of a folder —
 * if a nest ever fills a folder with thousands, list the folder once instead.
 */
async function generatedSlug(
  storage: { readDocument: (id: string) => Promise<unknown> },
  prefix: string,
): Promise<string> {
  for (let n = 1; n <= 1000; n++) {
    const slug = `document-${n}`;
    try {
      await storage.readDocument(`${prefix}${slug}`);
    } catch (err) {
      if (err instanceof DocumentNotFoundError) return slug;
      throw err;
    }
  }
  throw new ValidationError(
    "too many generated document ids in this folder — give the document a " +
      "title with Latin letters or digits, or file it elsewhere",
  );
}

/**
 * Does this document id live under `folder`? The engine only prefixes ids
 * with "nodes/" in a STRUCTURED vault (one with a top-level nodes/ dir); a
 * nest whose files arrived without one reads as flat layout and its ids
 * carry no prefix. Match both, or every folder op 404s on those nests.
 */
export function isIdUnderFolder(id: string, folder: string): boolean {
  return id.startsWith(`nodes/${folder}/`) || id.startsWith(`${folder}/`);
}

/**
 * The folder a node id sits in ("" for the nest root). The storage root
 * `nodes/` is not a user folder, so it is stripped — the UI's folderOfNode
 * does the same, and the two must agree on what a folder path is.
 */
export function folderOfId(id: string): string {
  const rel = folderPathOf(id);
  const slash = rel.lastIndexOf("/");
  return slash > 0 ? rel.slice(0, slash) : "";
}

/**
 * Refuse a folder path that could climb out of the nest.
 *
 * The WRITE path slugifies every segment (folderToSegments), which collapses
 * a traversal to a harmless `-`. Read paths cannot slugify: they have to
 * match folders that already exist on disk, verbatim. So the check is
 * explicit here instead. `..` never names a real folder, so refusing it
 * costs nothing and does not depend on the engine also catching it.
 */
export function assertSafeFolder(folder: string): void {
  if (folder.split(/[/\\]/).some((seg) => seg === "..")) {
    throw new ValidationError(
      `Invalid folder "${folder}": path traversal ("..") is not allowed.`,
    );
  }
}

/**
 * The id prefix this nest's documents actually carry.
 *
 * A nest created in-app keeps the engine's structured layout, so every id
 * begins `nodes/`. A nest IMPORTED from a folder keeps that folder's own
 * layout and carries no prefix at all — assuming `nodes/` there scopes every
 * read to a directory that does not exist, and the caller sees an empty nest.
 */
export async function storagePrefix(nestId: string): Promise<string> {
  const { storage } = await engineCache.get(nestId);
  return (await storage.detectLayout()) === "structured" ? "nodes" : "";
}

/**
 * Strip the `nodes/` storage root from a folder path — the folder twin of
 * folderOfId. `nodes` itself is the nest root, which is "" to a caller.
 */
export function folderPathOf(path: string): string {
  if (path === "nodes") return "";
  return path.startsWith("nodes/") ? path.slice(6) : path;
}

/**
 * Slugify + validate a folder path into id segments. Shared by create and
 * move so both enforce the same depth/length bounds and the same traversal
 * defense (each segment slugified independently — "../" collapses to "-",
 * empty segments drop).
 */
function folderToSegments(folder: string): string[] {
  const segments = folder.split("/").map(slugify).filter(Boolean);
  // A folder named "!!!" or "..." slugifies away entirely, and an empty segment
  // list means "the nest root" — so the doc lands at nodes/<title> instead, and
  // the next such folder collides with it ("already exists at nodes/overview").
  // An absent folder is still fine; only a name the caller meant is refused.
  // A folder path has no fallback the way a title does (createNode generates
  // an id when a title carries no ASCII) — a folder IS its path, so a name
  // that slugifies away leaves nothing to file under.
  if (folder.trim() && segments.length === 0) {
    throw new ValidationError(
      "the folder path is built from the name using a-z and 0-9, so the " +
        "name needs at least one of those",
    );
  }
  // Callers think in node ids, and every node id starts with "nodes/" — so
  // `folder: "nodes/signals"` is the natural thing to write. Both call sites
  // below prefix "nodes/" themselves, so an unstripped leading segment lands
  // the doc at nodes/nodes/signals/<slug>. Strip it here, once, rather than
  // in create and move separately. Cost: a folder literally named "nodes"
  // under the root is unaddressable — nobody wants nodes/nodes/.
  if (segments[0] === "nodes") segments.shift();
  if (segments.length > MAX_FOLDER_DEPTH) {
    throw new ValidationError(
      `folder may nest at most ${MAX_FOLDER_DEPTH} levels deep`,
    );
  }
  if (segments.some((seg) => seg.length > 100)) {
    throw new ValidationError(
      "each folder or title segment must be at most 100 characters",
    );
  }
  return segments;
}

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
  // The engine refuses to write a document that would stay rejected. That is a
  // state the caller can act on, not an internal fault, so it keeps its meaning
  // instead of being flattened into a generic 500 the user cannot interpret.
  // Matched on the code rather than the class so it survives the error crossing
  // a module boundary.
  if ((err as { code?: string })?.code === "REJECTED_DOCUMENT") {
    console.error(`${context}:`, err);
    return new ConflictError(
      "This document is rejected. Change its status before saving.",
    );
  }
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
  /** Document-scope prime flag, undefined when the doc inherits from tag/nest
   *  scope. Clients resolve the inherited case from `tags` + the nest's
   *  `prime_tags` setting; the server gate is authoritative either way. */
  prime?: boolean;
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
    prime: documentPrimeFlag(fm.metadata),
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

/**
 * Does the installed engine's `context_list` understand a `folder` scope?
 *
 * Asked of the published JSON Schema rather than by sending the key and hoping:
 * zod strips unknown keys, so an older engine would answer a folder request
 * with the WHOLE vault and look like it worked. Memoised — the engine cannot
 * change under a running process.
 */
let folderScopeSupported: boolean | null = null;
function engineScopesFolders(): boolean {
  if (folderScopeSupported === null) {
    const op = engineApi.getOperation("context_list");
    const properties = op
      ? ((inputJsonSchema(op) as { properties?: Record<string, unknown> }).properties ?? {})
      : {};
    folderScopeSupported = "folder" in properties;
  }
  return folderScopeSupported;
}

export interface ListNodesFilters {
  /** One type, or several (e.g. runnable types) to keep. */
  type?: string | readonly string[];
  tag?: string;
  /** Lifecycle status; aliases normalized. Retired nodes stay hidden without it. */
  status?: string;
  /**
   * Return only nodes with an approved version, and serve that version's body
   * rather than the live file — the view a public nest gives a stranger. Public
   * readers get it regardless; this lets any caller ask for it, e.g. to preview
   * what a nest exposes before making it public.
   */
  approvedOnly?: boolean;
  limit?: number;
  /**
   * Keep only documents sitting DIRECTLY in this folder ("" = the nest root).
   * One level, not the subtree: it is what a lazily-expanded folder row asks
   * for, and the point is to not pay for documents nobody has opened yet.
   */
  folder?: string;
}

/**
 * Per-caller node list — applies stewardship gating, public-reader rules,
 * pending-change/status resolution. Single source of truth for REST GET
 * /nests/:id/nodes, MCP context_list, and any future surface.
 */
/**
 * Read ONE node the way every surface should: resolve the selector, gate it,
 * and hand back the document.
 *
 * REST and MCP each grew their own version of this — the only read in the
 * service that had no shared choke point, unlike create/update/list. MCP's
 * loaded and parsed EVERY file in the vault (discoverDocuments) just to find
 * one node by id.
 *
 * Response shaping stays with the caller: REST negotiates raw/markdown/JSON and
 * resolves workflow status, MCP serves the approved body only. This owns the
 * read and the access check, nothing above them.
 */
export async function getNodeForCaller(
  nestId: string,
  selector: { id?: string; title?: string },
  userId: string,
  userEmail: string,
  opts: { verifyChecksum?: boolean } = {},
): Promise<ContextNode> {
  // Gate BEFORE the read whenever the caller named an id. Reading first and
  // gating after answers a question the caller was not entitled to ask: a
  // missing node 404s while an existing-but-restricted one 403s, so probing ids
  // reveals which documents a governed nest holds. Denying an id that does not
  // exist is the point — the two cases have to look identical.
  if (selector.id && !(await canReadNode(nestId, selector.id, userId, userEmail))) {
    throw new ForbiddenError(
      "Access denied — no steward assignment for this node",
    );
  }
  let got: {
    id: string;
    frontmatter: ContextNode["frontmatter"];
    body: string;
    raw?: string;
    pendingChange?: ContextNode["pendingChange"];
  };
  try {
    got = await engineApi.run(
      "context_get",
      {
        ...selector,
        include_raw: true,
        // A retired node stays readable here: its stewards decide whether to
        // revive it, and they cannot do that if the read refuses.
        allow_rejected: true,
        ...(opts.verifyChecksum ? { verify_checksum: true } : {}),
      },
      await opContext(nestId, userEmail),
    );
  } catch (err) {
    // A missing document is the ordinary case and needs no noise. Anything else
    // is a real fault, and reporting it as a 404 with no trace makes an engine
    // bug look like an empty vault — this is now the single read path for both
    // REST and MCP, so a silent one hides everywhere at once.
    if ((err as { code?: string })?.code !== "DOCUMENT_NOT_FOUND") {
      console.error(`getNodeForCaller failed (${nestId}/${selector.id ?? selector.title})`, err);
    }
    throw new NotFoundError(`Node not found: ${selector.id ?? selector.title}`);
  }
  // A title selector cannot be gated up front — it does not name a node until
  // the operation resolves it — so it is gated here instead.
  if (!selector.id && !(await canReadNode(nestId, got.id, userId, userEmail))) {
    throw new ForbiddenError(
      "Access denied — no steward assignment for this node",
    );
  }
  return {
    id: got.id,
    filePath: "",
    rawContent: got.raw ?? "",
    frontmatter: got.frontmatter,
    body: got.body,
    ...(got.pendingChange ? { pendingChange: got.pendingChange } : {}),
  };
}

export async function listNodesForCaller(
  nestId: string,
  userId: string,
  filters: ListNodesFilters = {}
): Promise<NodeResponse[]> {
  if (filters.folder !== undefined) assertSafeFolder(filters.folder);
  const { versions: versionManager } = await engineCache.get(nestId);
  const userEmail = await resolveCallerEmail(userId);

  // Discovery and the cheap on-frontmatter filters go through the engine's
  // canonical browse, so this surface can't drift from the CLI and mcp-server
  // on what `type: document` or a `#`-less tag means — and so a future
  // authorization extension on the operation covers this path too.
  //
  // `full` because the governance work below gates and renders these documents:
  // a summary would force a second read of every file. `limit` is deliberately
  // NOT passed — it applies after access filtering, further down.
  //
  // A `folder` scope goes to the operation when the engine understands it,
  // which narrows the CRAWL — the engine reads only that directory instead of
  // the whole vault. An older engine SILENTLY IGNORES an unknown key (zod
  // strips it) and would hand back everything, so the catalog is checked
  // rather than the parameter simply being sent; the JS filter below is what
  // keeps the result correct either way.
  const scopeInEngine = filters.folder !== undefined && engineScopesFolders();
  const scopePrefix = scopeInEngine ? await storagePrefix(nestId) : "";
  const { documents } = await engineApi.run<{
    documents: Array<{ id: string; frontmatter: ContextNode["frontmatter"]; body: string }>;
  }>(
    "context_list",
    {
      ...(filters.type ? { type: filters.type } : {}),
      ...(filters.tag ? { tag: filters.tag } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(scopeInEngine
        ? {
            folder: [scopePrefix, filters.folder].filter(Boolean).join("/"),
            recursive: false,
          }
        : {}),
      // Unlike the CLI and mcp-server, a retired node stays in this listing:
      // here it is an unpublished document its stewards may still need to act
      // on, not one removed from retrieval. An imported vault carrying
      // `status: rejected` registers exactly that way.
      include_retired: true,
      full: true,
    },
    await opContext(nestId, userEmail),
  );
  // Narrow BEFORE the access gate and enrichment below — that is the whole
  // saving, since both cost per surviving document. Still applied even when
  // the engine already scoped the crawl: it is the correctness guarantee, and
  // on a scoped crawl there is nothing left for it to drop.
  const scoped =
    filters.folder === undefined
      ? documents
      : documents.filter((d) => folderOfId(d.id) === filters.folder);
  const nodes: ContextNode[] = scoped.map((d) => ({
    id: d.id,
    filePath: "",
    rawContent: "",
    frontmatter: d.frontmatter,
    body: d.body,
  }));
  const publicReader = await isPublicReader(nestId, userId);
  // Approved-only view: what a public nest shows a stranger. ONE scan of the
  // nest, shared by the access filter (which decides what a public reader may
  // see) and the enrichment below (which serves each body at its approved
  // version) — those asked the same question separately.
  const approvedOnly = publicReader || filters.approvedOnly === true;
  const approvedVersions = approvedOnly
    ? await versions.getApprovedVersions(nestId)
    : null;

  let accessible = await filterAccessible(
    nestId,
    userId,
    userEmail,
    nodes,
    approvedVersions ?? undefined,
  );

  // Share grants (a caller with NO nest-wide permission sees exactly the
  // documents their grants cover) are narrowed inside filterAccessible, on both
  // the stewardship-on and stewardship-off paths — every read surface routes
  // through it, so this list does not repeat the check.
  //
  // The grants are still read here, for one reason only: stamping each row's
  // `myGrant` below. A grant is access, not stewardship, so it appears in
  // neither the nest permission nor the steward roles, and without it a client
  // cannot tell a write grantee's row from a viewer's. One indexed query for
  // the whole list, not one per node.
  const myGrants = await listUserGrants(nestId, userId);
  // A public reader was already narrowed to approved nodes by filterAccessible;
  // any other caller asking for this view is narrowed here.
  if (approvedVersions && !publicReader) {
    accessible = accessible.filter((d) => approvedVersions.has(d.id));
  }

  // Trim to the requested count BEFORE the per-node work below. Enrichment
  // costs a reconstruct and two governance queries per node, and slicing
  // afterwards paid all of that for every node the caller was never going to
  // see — a 50-node MCP listing did a whole 500-node nest's worth of it. After
  // access filtering, or a node dropped for permissions would come out of the
  // caller's quota.
  if (filters.limit) accessible = accessible.slice(0, filters.limit);

  // Two whole-nest reads instead of per-node ones: display status cost a DB
  // round trip per document and the pending-change probe a directory glob.
  // Skipped on the approved-only path, which reads neither.
  const [displayStatuses, driftedDocs] = approvedVersions
    ? [null, null]
    : await Promise.all([
        versions.getDisplayStatuses(nestId),
        documentsWithSuggestions(nestId),
      ]);

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
      // A grant is access, not stewardship, so it shows up in neither the nest
      // permission nor the steward roles. Without it the client cannot tell a
      // write grantee from a viewer on this row.
      if (myGrants.length) {
        (r as any).myGrant = grantRoleForNode(myGrants, doc.id);
      }

      if (approvedVersions) {
        const approved = approvedVersions.get(doc.id);
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

      // Only documents the walk found a staged suggestion for can have a
      // pending change, so the rest skip the read entirely.
      let pending: Awaited<ReturnType<typeof getPendingChange>> = null;
      if (driftedDocs?.has(doc.id)) {
        try {
          pending = await getPendingChange(nestId, doc.id);
        } catch {
          pending = null;
        }
      }
      if (pending) {
        r.pendingChange = pending;
        r.status = "external_edit_pending";
      } else {
        r.status = displayStatuses?.get(r.id) ?? "draft";
      }
      return r;
    })
  );

  return enriched;
}

/** A folder of documents, with direct and subtree counts. */
export interface FolderNode {
  path: string;
  count: number;
  total: number;
}

/** Roll subtree totals up from per-folder direct counts. */
function withSubtreeTotals(
  direct: Array<{ path: string; count: number }>,
): FolderNode[] {
  return direct
    .map(({ path, count }) => ({
      path,
      count,
      total: direct.reduce(
        (sum, f) =>
          f.path === path || f.path.startsWith(`${path}/`) ? sum + f.count : sum,
        0,
      ),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The nest's folders, WITHOUT reading any document.
 *
 * A navigable tree only needs directory names, and `context_folders` answers
 * that from directory entries alone. The fallback derives the same shape from
 * the document ids, which costs a full crawl — it exists only for an engine
 * that predates the operation, and drops away once the pin is bumped.
 *
 * `folder` is a community folder path ("" = nest root), NOT an id prefix; the
 * `nodes/` storage root is added here so callers keep speaking one dialect.
 *
 * No per-caller narrowing: this is a whole-nest view, and the nest middleware
 * already withholds those from a share grantee (same rule as /overview), so
 * everyone who reaches this handler may see the whole tree.
 */
export async function listNestFolders(
  nestId: string,
  opts: { folder?: string; recursive?: boolean } = {},
): Promise<FolderNode[]> {
  if (opts.folder !== undefined) assertSafeFolder(opts.folder);
  const { storage } = await engineCache.get(nestId);
  const prefix = await storagePrefix(nestId);
  const base = [prefix, opts.folder].filter(Boolean).join("/");

  let direct: Array<{ path: string; count: number }>;
  // Catalog lookup, not a method probe: this runs the same operation the CLI
  // and mcp-server do, and an older engine simply doesn't publish it.
  if (engineApi.getOperation("context_folders")) {
    const { folders } = await engineApi.run<{
      folders: Array<{ path: string; count: number }>;
    }>(
      "context_folders",
      {
        folder: base,
        ...(opts.recursive === false ? { recursive: false } : {}),
      },
      await opContext(nestId, ""),
    );
    direct = folders.map((f) => ({ path: folderPathOf(f.path), count: f.count }));
  } else {
    const docs = await storage.discoverDocuments({ includeRetired: true });
    const counts = new Map<string, number>();
    for (const d of docs) {
      const f = folderOfId(d.id);
      if (!f) continue;
      counts.set(f, (counts.get(f) ?? 0) + 1);
      // Ancestors with no document of their own still need a row.
      let parent = f;
      while (parent.includes("/")) {
        parent = parent.slice(0, parent.lastIndexOf("/"));
        if (!counts.has(parent)) counts.set(parent, 0);
      }
    }
    direct = [...counts].map(([path, count]) => ({ path, count }));
  }

  const scope = opts.folder ?? "";
  const inScope = direct.filter((f) => {
    if (scope && !f.path.startsWith(`${scope}/`)) return false;
    if (opts.recursive === false) {
      const rel = scope ? f.path.slice(scope.length + 1) : f.path;
      return !rel.includes("/");
    }
    return true;
  });
  return withSubtreeTotals(inScope);
}

/**
 * Everything the document list needs to describe the WHOLE nest without
 * listing it: folder tree, counts, tags, types, authors, statuses.
 *
 * A folder-scoped listing only returns one level, so without this the tag bar,
 * filter dropdowns and stat tiles would silently describe the handful of
 * documents the user happened to expand. Costs no extra I/O — discovery is
 * already cached, and statuses/authorship are batched nest-wide reads.
 */
export interface NestCensus {
  total: number;
  /** Every folder in the nest, with direct and subtree document counts. */
  folders: Array<{ path: string; count: number; total: number }>;
  tags: Record<string, number>;
  types: Record<string, number>;
  statuses: Record<string, number>;
  authors: string[];
  /** Documents edited in the last 7 days — the Overview stat tile. */
  editedLast7d: number;
  /** Newest-first, capped: the "Recently edited" strip. */
  recent: Array<{ id: string; title: string; type: string; updated_at?: string }>;
}

const RECENT_LIMIT = 3;

export async function nestCensus(
  nestId: string,
  userId: string,
): Promise<NestCensus> {
  const userEmail = await resolveCallerEmail(userId);
  const { documents } = await engineApi.run<{
    documents: Array<{ id: string; frontmatter: ContextNode["frontmatter"] }>;
  }>(
    "context_list",
    { include_retired: true, full: true },
    await opContext(nestId, userEmail),
  );

  // Same gate as the listing, so the counts describe what this caller can
  // actually reach rather than what is on disk.
  const visible = await filterAccessible(nestId, userId, userEmail, documents);

  const tags: Record<string, number> = {};
  const types: Record<string, number> = {};
  const direct = new Map<string, number>();
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let editedLast7d = 0;

  for (const d of visible) {
    const fm = d.frontmatter;
    types[fm.type || "document"] = (types[fm.type || "document"] || 0) + 1;
    for (const t of fm.tags || []) tags[String(t)] = (tags[String(t)] || 0) + 1;
    const folder = folderOfId(d.id);
    if (folder) direct.set(folder, (direct.get(folder) || 0) + 1);
    const edited = Date.parse(String(fm.updated_at || ""));
    if (!Number.isNaN(edited) && edited >= cutoff) editedLast7d++;
  }

  // Every folder, including containers holding only subfolders — a level with
  // no document of its own still has to be expandable.
  const paths = new Set<string>();
  for (const folder of direct.keys()) {
    const segs = folder.split("/");
    for (let i = 1; i <= segs.length; i++) paths.add(segs.slice(0, i).join("/"));
  }
  // Same roll-up the folders endpoint uses — the two describe the same tree
  // and must not drift.
  const folders = withSubtreeTotals(
    [...paths].map((path) => ({ path, count: direct.get(path) ?? 0 })),
  );

  const statusMap = await versions.getDisplayStatuses(nestId);
  const statuses: Record<string, number> = {};
  for (const d of visible) {
    const st = statusMap.get(d.id) ?? "draft";
    statuses[st] = (statuses[st] || 0) + 1;
  }

  const authorship = await resolveAuthorship(
    nestId,
    visible.map((d) => ({
      id: d.id,
      frontmatterAuthor: d.frontmatter.author ?? null,
    })),
  );
  const authors = [
    ...new Set(
      [...authorship.values()]
        .map((a) => a.author)
        .filter((a): a is string => !!a),
    ),
  ].sort((a, b) => a.localeCompare(b));

  const recent = visible
    .filter((d) => d.frontmatter.updated_at)
    .sort((a, b) =>
      String(b.frontmatter.updated_at).localeCompare(
        String(a.frontmatter.updated_at),
      ),
    )
    .slice(0, RECENT_LIMIT)
    .map((d) => ({
      id: d.id,
      title: String(d.frontmatter.title ?? ""),
      type: d.frontmatter.type || "document",
      updated_at: d.frontmatter.updated_at,
    }));

  return {
    total: visible.length,
    folders,
    tags,
    types,
    statuses,
    authors,
    editedLast7d,
    recent,
  };
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
  /** Document-scope prime flag — see `isPrimeDocument`. Omit to inherit from
   *  the nest's prime tags; `false` exempts this doc from an otherwise-prime
   *  tag. */
  prime?: boolean;
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
  /** Document-scope prime flag. `null` clears it back to tag/nest inheritance. */
  prime?: boolean | null;
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

/**
 * Flagging a document prime (or un-flagging it) is a governance action, not an
 * authoring one — otherwise any editor could set `prime: false` on the sales
 * playbook and walk their own edit straight past the review gate.
 */
async function assertMayFlagPrime(
  nestId: string,
  userEmail: string
): Promise<void> {
  const roles = await resolveUserRoles(nestId, userEmail);
  if (!roles.includes("owner") && !roles.includes("admin")) {
    throw new ForbiddenError(
      "Only the nest owner or an admin can change a document's prime flag."
    );
  }
}

/**
 * Single decision point for "does this write publish immediately, or land as a
 * draft?" — both createNode and updateNode route through here so the gate can
 * never disagree between the two paths.
 *
 * Order matters: prime is checked BEFORE any bypass, because a prime document
 * always requires approval — that is the whole point of flagging it. An owner
 * with self-approve on still drafts when the doc is prime.
 *
 * Returns WHY the write publishes, or null when it must land as a draft. The
 * reason is not decoration: it goes into the published version's audit note,
 * and there are now three distinct ways to skip review — inferring which one
 * applied after the fact would mislabel an editor's prime-only publish as an
 * "owner/admin self-approve" they never had.
 */
async function autoPublishReason(
  nestId: string,
  userEmail: string,
  doc: { tags?: readonly unknown[]; metadata?: unknown }
): Promise<string | null> {
  // Ungoverned nest: nothing to review, nobody to review it.
  if (!(await isStewardshipEnabled(nestId))) return "no stewards configured";
  if (await isPrimeDocument(nestId, doc.tags, doc.metadata)) return null;
  // Prime-only posture: everything that isn't prime self-publishes.
  if (await nestReviewsPrimeOnly(nestId)) {
    return "prime-only review, document is not prime";
  }
  return (await actorAutoPublishes(nestId, userEmail))
    ? "owner/admin self-approve"
    : null;
}

/**
 * Create a node, retrying a generated id that lost a race.
 *
 * A title with no Latin characters gets its id by probing for the first free
 * `document-N`, and that probe runs before the per-id write lock is taken — so
 * two concurrent such creates in one folder can pick the same id and the loser
 * gets a conflict on an id it never chose. Probe again and take the next one:
 * the fallback exists to hand out a free id, so failing there defeats it. Only
 * that case retries; every other conflict is the caller's own id and stands.
 */
export async function createNode(
  nestId: string,
  input: CreateNodeInput,
  userEmail: string,
): Promise<NodeMutationResult> {
  const generatedId = !input.id && !slugify(input.title);
  for (let attempt = 0; ; attempt++) {
    try {
      return await createNodeOnce(nestId, input, userEmail);
    } catch (err) {
      if (!generatedId || attempt >= 3 || !(err instanceof ConflictError)) {
        throw err;
      }
    }
  }
}

async function createNodeOnce(
  nestId: string,
  input: CreateNodeInput,
  userEmail: string
): Promise<NodeMutationResult> {
  const { storage, versions: versionManager } = await engineCache.get(nestId);

  assertTitleLength(input.title);
  assertTitleReadable(input.title);
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
    const prefix =
      folderSegments.length > 0
        ? `nodes/${folderSegments.join("/")}/`
        : "nodes/";
    // "###" or an all-CJK/Cyrillic/Arabic title slugifies to nothing, and a
    // bare `nodes/` id is a ghost at nodes/.md that no list shows and no id
    // addresses. Generate one instead of refusing the title.
    id = `${prefix}${slug || (await generatedSlug(storage, prefix))}`;
  }
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

  // Check-then-write must be atomic per node id, or two concurrent creates
  // (two tabs, REST + MCP, an agent retry) both see a free id and the second
  // overwrites the first. Same lock updateNode and the governance writes take.
  return withNodeWriteLock(nodeWriteKey(nestId, id), async () => {
    // writeDocument overwrites, so a create onto an occupied id silently
    // replaced that document and restarted its history (CU-wdqcpzxcg8).
    // moveNode already refuses an occupied destination; create now agrees.
    let occupied = false;
    try {
      await storage.readDocument(id);
      occupied = true;
    } catch (err) {
      // Fail closed: only a missing document means the id is free. Any other
      // failure could be hiding a real one, so rethrow rather than overwrite.
      if (!(err instanceof DocumentNotFoundError)) throw err;
    }
    if (occupied) {
      throw new ConflictError(
        `A document already exists at ${id}. Update it, or create this one under a different folder or title.`,
      );
    }

    // Rows can outlive their document when a file goes missing outside the app
    // — deleteNode's purge never runs because the delete 404s first. Those rows
    // crashed the create on node_versions' unique constraint; clear them all so
    // the new document starts clean instead of inheriting a stranger's history.
    const db = getDb();
    const orphan = await db.get(
      "SELECT 1 AS present FROM node_versions WHERE nest_id = ? AND node_id = ? LIMIT 1",
      [nestId, id],
    );
    if (orphan) {
      console.warn(
        `[nodes] clearing orphaned rows for ${id} — version history exists but no document does`,
      );
      await db.transaction(async (tx) => {
        await purgeNodeKeyedRows(tx, nestId, id);
      });
    }

    // Optional dept:<slug> auto-tag — after the validations above so a request
    // that fails them never pays the DB lookup. Deduped case-insensitively
    // against the user-supplied tags (normalizeTag keeps the user's casing, so
    // "#Dept:Engineering" must still match the all-lowercase auto tag).
    const deptTag = await departmentTagFor(userEmail);
    if (deptTag && !tags.some((t) => t.toLowerCase() === deptTag)) {
      tags.push(deptTag);
    }

    if (input.prime !== undefined) await assertMayFlagPrime(nestId, userEmail);
    const metadata = {
      owners: ["*"],
      scope: input.scope || "team",
      ...(input.schedule ? { schedule: input.schedule } : {}),
      ...(input.prime === undefined ? {} : { prime: input.prime }),
    };
    const publishReason = await autoPublishReason(nestId, userEmail, {
      tags,
      metadata,
    });
    // Same note in the engine history and the governance row: the version
    // history an admin reads in the UI comes from node_versions, so leaving the
    // reason only in history.yaml hides it from the audit that matters.
    const publishNote =
      publishReason === null ? undefined : `Auto-published on create (${publishReason})`;

    // Write — and publish, when the gate allows — through the engine's canonical
    // create. Governance stays here; the engine owns frontmatter assembly,
    // validation, version assignment and the index regen, so a document created
    // here is identical to one created by the CLI or mcp-server.
    let published = publishReason !== null;
    try {
      await engineApi.run(
        "context_create",
        {
          id,
          title: input.title,
          content: input.content,
          type: requestedType,
          // A skill node is invalid without a skill block, and this surface has
          // no field for one — default the trigger from the title, same as the
          // CLI and mcp-server do.
          ...(requestedType === "skill"
            ? { trigger: `when asked to ${input.title.toLowerCase()}` }
            : {}),
          ...(tags.length ? { tags } : {}),
          ...(input.status ? { status: input.status } : {}),
          metadata,
          publish: published,
          ...(publishNote ? { note: publishNote } : {}),
        },
        await opContext(nestId, userEmail),
      );
    } catch (err) {
      // The op writes the node before publishing it. If the write landed and
      // only the publish failed, register the document as a draft instead of
      // throwing and stranding a file that has no governance rows.
      let onDisk = true;
      try {
        await storage.readDocument(id);
      } catch {
        onDisk = false;
      }
      if (!onDisk) throw err;
      console.error("publishDocument failed (node create auto-publish)", err);
      published = false;
    }

    const node = await storage.readDocument(id);
    await syncNodeTags(nestId, id, tags);

    let savedVersion = 1;
    if (published) {
      savedVersion = node.frontmatter.version || 1;
      await versions.createVersion({
        nestId,
        nodeId: id,
        version: savedVersion,
        content: node.body || "",
        author: userEmail,
        status: "published",
        tags,
        changeNote: publishNote,
      });
      await versions.setApprovedVersion(nestId, id, savedVersion, userEmail);
    } else {
      // Seed the engine history only for a genuine draft. A publish that failed
      // above already wrote history entries; re-seeding would graft a second
      // chain onto them.
      if (publishReason === null) {
        try {
          await versionManager.createVersion(node, userEmail);
        } catch (err) {
          console.error("VersionManager.createVersion failed (node create)", err);
        }
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
    }

    await trackEvent("node.create", { nestId, nodeId: id });
    return { node, version: savedVersion };
  });
}

/** One document the engine's discover-mode import took responsibility for. */
type ImportedDocRecord = {
  id: string;
  title: string;
  version: number;
  status: "published" | "draft";
  tags: string[];
  content: string;
};

/**
 * Hand a batch of uploaded files to the engine, which writes them into the
 * nest's storage verbatim — frontmatter, folder layout and `.versions/` history
 * all intact — without publishing anything.
 *
 * Staging and publishing are split because a browser upload arrives in several
 * chunks: publishing per chunk would seal a checkpoint per chunk, and every
 * checkpoint re-scans the whole vault (the O(N²) shape this import exists to
 * avoid). Each chunk stages; one `registerImportedDocuments` call afterwards
 * publishes the lot under a single checkpoint.
 *
 * Returns what landed and what did not. A file the engine refuses (an unsafe
 * path) does not fail the import, but the caller has to be able to say so — a
 * silently dropped file is the same "the failure had nowhere to surface"
 * problem as a silently failed import, just one file at a time.
 */
export async function stageImportedFiles(
  nestId: string,
  files: Array<{ path: string; content: string }>,
  userEmail: string
): Promise<{ written: number; rejected: string[] }> {
  // `_suggestions` is a vault's OWN staged-suggestion store — derived
  // governance state, not content. Carried in, another vault's copy surfaces as
  // phantom external edits against doc ids that don't resolve here. Dropped
  // server-side, not in the browser: the endpoint can't trust its caller.
  // Everything else travels verbatim, `.versions/` history included.
  const carried = files.filter(
    (f) => !String(f?.path || "").split(/[\\/]/).includes("_suggestions")
  );
  if (!carried.length) return { written: 0, rejected: [] };
  const result = await engineApi.run<{
    written?: number;
    failed: Array<{ id?: string; error: string }>;
  }>(
    "context_import",
    { files: carried, publish: false },
    await opContext(nestId, userEmail)
  );
  // A rejected path (traversal, empty) comes back per-file rather than throwing:
  // one bad path shouldn't cost the whole import. It must not pass silently.
  const rejected = (result.failed ?? []).map((f) => f.id ?? "(unnamed)");
  if (rejected.length) {
    console.warn(
      `[import] ${rejected.length} file(s) rejected:`,
      (result.failed ?? []).map((f) => `${f.id}: ${f.error}`).join(", ")
    );
  }
  return { written: result.written ?? 0, rejected };
}

/**
 * Register the documents an imported folder brought in.
 *
 * On import the nest row exists but the governance DB is empty, so the on-disk
 * documents carry no version/approved/tag rows. They would still list
 * (discovery is disk-based) but show as "draft" and edit from scratch instead
 * of from their real version.
 *
 * ONE `context_import({ discover })` call does every bit of vault work: the
 * scan, the author/title stamp, the publish-vs-hold decision, the batch publish
 * and its single checkpoint. What is left here is the governance rows, which
 * are none of the engine's business. This used to run its own discovery and a
 * full metadata-rewrite pass first — a second network round trip per document
 * before publishing had even started.
 *
 * Idempotent: docs that already carry a version row are excluded. Returns the
 * number newly registered.
 */
/**
 * Make a copied-in file's frontmatter agree with the status we just recorded
 * for it.
 *
 * A document the engine could not publish registers as a draft, but the file
 * carries whatever status its source vault had. One that says `published` on
 * disk then displays as Draft forever — the badge reads the governance DB
 * (getDisplayStatus), which never consults frontmatter — with nothing on either
 * side explaining the contradiction.
 *
 * Frontmatter-only, and the checksum covers the body alone, so rewriting this
 * cannot make the drift scanner see an external edit. Best-effort: the row is
 * already written, and failing the whole import over a cosmetic mismatch would
 * be the worse trade.
 */
export async function alignOnDiskStatus(
  nestId: string,
  documentId: string,
  status: string,
): Promise<void> {
  try {
    const { storage } = await engineCache.get(nestId);
    const node = await storage.readDocument(documentId);
    if (node.frontmatter.status === status) return;
    await storage.writeDocument(
      documentId,
      serializeNodeSafe({
        ...node,
        frontmatter: { ...node.frontmatter, status: status as any },
      }),
    );
  } catch (err) {
    console.warn(
      `[import] could not align on-disk status for ${nestId}/${documentId}:`,
      err,
    );
  }
}

export async function registerImportedDocuments(
  nestId: string,
  userEmail: string
): Promise<number> {
  const startedAt = Date.now();
  const tracked = await versions.getTrackedNodeIds(nestId);
  // Registration reconciles the governance DB against what is on disk, and the
  // files it is registering usually landed there without going through this
  // process (a folder sync, the CLI, another instance). Read past the cache.
  (await engineCache.get(nestId)).invalidateDiscovery();

  let result: ImportOpResult & { documents?: ImportedDocRecord[] };
  try {
    result = await engineApi.run<ImportOpResult & { documents?: ImportedDocRecord[] }>(
      "context_import",
      { discover: true, author: userEmail, exclude_ids: [...tracked] },
      await opContext(nestId, userEmail)
    );
  } catch (err) {
    // The engine seals its checkpoint OUTSIDE the per-document guard, so a
    // corrupt context_history.yaml throws for the whole batch. Surfacing beats
    // swallowing: this used to return 0, which reported a broken vault as a
    // successful import of an empty folder with the cause only in the log.
    console.error("[import] register failed", nestId, err);
    throw new Error(
      `Failed to import documents: ${(err as Error)?.message ?? String(err)}`
    );
  }

  const docs = result.documents ?? [];
  const engineMs = Date.now() - startedAt;
  const dbStartedAt = Date.now();

  // A document the engine could not publish (an imported version chain that no
  // longer reconstructs) still registers — as a draft, at its own version, with
  // its history left untouched on disk. Losing the doc would be the worse loss.
  for (const d of docs) {
    const tags = d.tags.map((t) => normalizeTag(String(t)));
    await versions.createVersion({
      nestId,
      nodeId: d.id,
      version: d.version,
      content: d.content,
      author: userEmail,
      status: d.status,
      changeNote:
        d.status === "published"
          ? "Imported from existing folder"
          : "Imported from existing folder — could not be published, kept as a draft",
      tags,
    });
    if (d.status === "published") {
      await versions.setApprovedVersion(nestId, d.id, d.version, userEmail);
    } else {
      await alignOnDiskStatus(nestId, d.id, d.status);
    }
    await syncNodeTags(nestId, d.id, tags);
  }

  const published = docs.filter((d) => d.status === "published").length;
  // Phase split — a slow import is almost always one phase, and the total alone
  // doesn't say which.
  console.log(
    `[import] register done: registered=${docs.length} published=${published} kept=${
      docs.length - published
    } failed=${result.failed.length} alreadyTracked=${tracked.size}` +
      ` engineMs=${engineMs} dbMs=${Date.now() - dbStartedAt}`
  );
  if (result.failed.length) {
    console.warn(
      "[import] documents that would not publish:",
      result.failed.map((f) => `${f.id}: ${f.error}`).join(", ")
    );
  }
  await trackEvent("nest.import.documents", { nestId, registered: docs.length });
  return docs.length;
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

      // Assemble the op's input alongside a local projection of the patched
      // node. The projection is what governance reads (auto-publish gate, tag
      // index) BEFORE the write happens; the engine performs the actual write.
      const opInput: Record<string, unknown> = {};
      if (patch.content !== undefined) {
        node = { ...node, body: patch.content };
        opInput.content = patch.content;
      }
      if (patch.append) {
        node = { ...node, body: (node.body || "") + "\n\n" + patch.append };
        opInput.append = "\n" + patch.append;
      }
      if (patch.tags) {
        // Replace, don't merge: the editor sends the full tag set on every
        // save, so a union made removals impossible (CU: removed tag returns
        // after reopen). Callers wanting additive semantics (MCP
        // context_update) merge against the current tags themselves.
        const nextTags = [...new Set(patch.tags.map(normalizeTag))];
        node = { ...node, frontmatter: { ...node.frontmatter, tags: nextTags } };
        // The engine performs the write, so the new set has to reach it — the
        // projection above only feeds the governance decisions below. It
        // replaces too, so this is a straight hand-off.
        opInput.tags = nextTags;
      }
      if (patch.status) {
        node = {
          ...node,
          frontmatter: { ...node.frontmatter, status: patch.status as any },
        };
        opInput.status = normalizeStatus(patch.status);
      } else if (isRejected(node)) {
        // The engine refuses an update that would leave a document rejected —
        // otherwise a client echoing the current status back would rewrite the
        // body of a document that stays out of retrieval. Moving it to any
        // other status is allowed, and opening a rejected document and saving
        // it IS the intent to revive it. Without this, every save of a rejected
        // document failed: the editor sends content and tags but no status, so
        // the guard saw `status: undefined` and threw. Imported vaults carrying
        // `status: rejected` in frontmatter land here on their first edit.
        node = {
          ...node,
          frontmatter: { ...node.frontmatter, status: "draft" },
        };
        opInput.status = "draft";
      }
      if (patch.title) {
        // Grandfathered: docs saved before this bound existed keep their long
        // title. The editor sends `title` on EVERY save, so a flat check would
        // make those docs unsavable — enforce only on an actual rename.
        if (patch.title !== node.frontmatter.title) {
          // A rename keeps the id, so the new title never has to be sluggable
          // — it only has to be bounded and readable.
          assertTitleLength(patch.title);
          assertTitleReadable(patch.title);
        }
        node = {
          ...node,
          frontmatter: { ...node.frontmatter, title: patch.title },
        };
        opInput.title = patch.title;
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
        // The op merges metadata and reads null as "clear this key" — an empty
        // schedule means remove it, not store "".
        opInput.metadata = {
          ...(opInput.metadata as object),
          schedule: patch.schedule === "" ? null : patch.schedule,
        };
      }
      if (patch.prime !== undefined) {
        await assertMayFlagPrime(nestId, userEmail);
        const metadata = { ...(node.frontmatter.metadata as any) };
        if (patch.prime === null) delete metadata.prime;
        else metadata.prime = patch.prime;
        node = { ...node, frontmatter: { ...node.frontmatter, metadata } };
        opInput.metadata = { ...(opInput.metadata as object), prime: patch.prime };
      }

      const hasStewards = await isStewardshipEnabled(nestId);
      const currentTags = (node.frontmatter.tags || []) as string[];
      // Resolved from the POST-patch tags and metadata — so an edit that adds
      // a prime tag gates itself, and one that clears the doc flag can't
      // un-gate a prime-tagged doc.
      const publishReason = await autoPublishReason(nestId, userEmail, {
        tags: currentTags,
        metadata: node.frontmatter.metadata,
      });

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
      if (publishReason === null || isAuthorEditingOwnReview) {
        const currentVersion = await versions.getCurrentVersion(nestId, nodeId);
        // Number past the engine's history.yaml too, not just the DB row. When
        // the DB lags the on-disk chain (imported nest, a mirrored append that
        // failed) `currentVersion + 1` reuses a version number, which grafts a
        // second chain onto the first and breaks reconstruction from there on.
        const newVersion = await versionManager.nextVersion(nodeId, currentVersion);
        // The engine owns the write: it applies the patch, validates, stamps the
        // version we assigned and drops the stale published-state checksum, then
        // regenerates the index. `publish: false` because this revision has not
        // cleared review — governance below records it as a draft.
        await engineApi.run(
          "context_update",
          { id: nodeId, ...opInput, publish: false, version: newVersion },
          await opContext(nestId, userEmail),
        );
        node = await storage.readDocument(nodeId);
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
        // Publish through the engine FIRST; only mirror into the DB once it
        // actually landed. Rethrow on failure — swallowing here is what let
        // node_versions climb past what history.yaml stored (DB v19 vs v15).
        const publishNote =
          patch.changeNote || `Auto-published on edit (${publishReason})`;
        let publishedVersion: number;
        try {
          const result = await engineApi.run<{ version: number }>(
            "context_update",
            { id: nodeId, ...opInput, publish: true, note: publishNote },
            await opContext(nestId, userEmail),
          );
          publishedVersion = result.version;
        } catch (err) {
          console.error(
            "publishDocument failed (node patch auto-publish)",
            err
          );
          throw err;
        }
        node = await storage.readDocument(nodeId);
        await syncNodeTags(nestId, nodeId, currentTags);
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
          changeNote: publishNote,
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

/**
 * A node under open review is frozen so it can't move or vanish while a
 * reviewer is looking at it. Approvers (owner/admin/reviewer) are exempt —
 * they can reject the review and then act, so the lock only cost them a round
 * trip and left admins unable to clean up superseded docs at all.
 */
async function assertNotReviewLocked(
  nestId: string,
  nodeId: string,
  userEmail: string,
  action: "moving" | "deleting",
): Promise<void> {
  if (!(await isStewardshipEnabled(nestId))) return;
  if (!(await getPendingReview(nestId, nodeId))) return;
  if (canApproveWith(await resolveUserRoles(nestId, userEmail, { nodeId }))) return;
  throw new LockedError(
    `This document is awaiting steward review and is locked. Approve or reject the pending review before ${action}, or ask a reviewer to.`,
  );
}

/** Mirror of annotations/service.ts derivedAnnotationsId — duplicated here
 *  because importing it would close the annotations→nodes import cycle. */
function derivedIdOf(sourceNodeId: string): string {
  return `nodes/${sourceNodeId.replace(/^nodes\//, "")}--annotations`;
}

/**
 * Every nest-scoped table keying rows to a node id, as [table, column]. ONE
 * list so delete (purge) and move (repoint) can't drift — a node id derives
 * from its title, so leftovers get inherited by the next doc to take that id.
 *
 * Predicated references (document-scoped stewards, document grants) sit beside
 * the loop in both helpers. `runs`/`run_steps` are absent deliberately: a trace
 * records what happened, so move retargets it but delete keeps it.
 */
export const NODE_KEYED_TABLES = [
  ["node_versions", "node_id"],
  ["review_requests", "node_id"],
  ["deletion_requests", "node_id"],
  ["approved_versions", "node_id"],
  ["annotation_threads", "node_id"],
  ["comments", "node_id"],
  ["node_tag_index", "node_id"],
  ["watchers", "node_id"],
  ["schedules", "agent_node"],
  // A live capability token bound to one agent node — deleting the agent must
  // revoke it, or a later node at that id answers the old webhook.
  ["trigger_hooks", "agent_node"],
  ["edges", "from_node"],
  ["edges", "to_node"],
] as const;

/** Drop every row keyed to a node id. Caller supplies the transaction. */
async function purgeNodeKeyedRows(
  tx: Querier,
  nestId: string,
  nodeId: string,
): Promise<void> {
  for (const [table, column] of NODE_KEYED_TABLES) {
    await tx.run(`DELETE FROM ${table} WHERE nest_id = ? AND ${column} = ?`, [
      nestId,
      nodeId,
    ]);
  }
  // Document-scoped stewards and grants pin to this exact id. Tag- and
  // nest-scoped stewards, and folder grants, govern more than this document
  // and stay.
  await tx.run(
    `DELETE FROM stewards
     WHERE nest_id = ? AND scope = 'document' AND node_pattern = ?`,
    [nestId, nodeId],
  );
  await tx.run(
    `DELETE FROM grants
     WHERE nest_id = ? AND target_type = 'document' AND target = ?`,
    [nestId, nodeId],
  );
}

/** Repoint every row keyed to `oldId` at `newId`. Caller supplies the transaction. */
async function rewriteNodeKeyedRows(
  tx: Querier,
  nestId: string,
  oldId: string,
  newId: string,
): Promise<void> {
  for (const [table, column] of NODE_KEYED_TABLES) {
    await tx.run(
      `UPDATE ${table} SET ${column} = ? WHERE nest_id = ? AND ${column} = ?`,
      [newId, nestId, oldId],
    );
  }
  await tx.run(
    `UPDATE stewards SET node_pattern = ?
     WHERE nest_id = ? AND scope = 'document' AND node_pattern = ?`,
    [newId, nestId, oldId],
  );
  await tx.run(
    `UPDATE grants SET target = ?
     WHERE nest_id = ? AND target_type = 'document' AND target = ?`,
    [newId, nestId, oldId],
  );
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
  await assertNotReviewLocked(nestId, nodeId, userEmail, "moving");

  const leaf = nodeId.split("/").pop()!;
  const segments = folderToSegments(folder);
  const newId =
    segments.length > 0 ? `nodes/${segments.join("/")}/${leaf}` : `nodes/${leaf}`;
  if (newId === nodeId) return { node, previousId: nodeId };

  // Destination check through write under the destination's lock — same
  // check-then-write race create takes it for, and the same key, so a
  // concurrent create at that id can't slip in between either.
  return withNodeWriteLock(nodeWriteKey(nestId, newId), async () => {
    try {
      await storage.readDocument(newId);
      throw new ConflictError(
        `A document already exists at that location: ${newId}`,
      );
    } catch (err) {
      if (err instanceof ConflictError) throw err;
      // Fail closed: only a missing document leaves the destination free.
      if (!(err instanceof DocumentNotFoundError)) throw err;
    }

    const moved: ContextNode = {
      ...node,
      id: newId,
      frontmatter: {
        ...node.frontmatter,
        updated_at: new Date().toISOString(),
      },
    };
    // serializeNodeSafe, not serializeDocument: `moved` came from
    // readDocument, so an empty `tags: []` on disk is back as
    // `tags: undefined` and the YAML dumper throws on it. Only published docs
    // are already clean (approve rewrites them through safePublishDocument),
    // which is why drafts and pending-review docs were the ones failing.
    await storage.writeDocument(newId, serializeNodeSafe(moved));

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

    // Repoint every node-keyed table for the source doc and its derived
    // annotations node, plus the run traces delete keeps. One transaction: a
    // half-moved node would be worse than a failed move.
    const oldDerived = derivedIdOf(nodeId);
    const newDerived = derivedIdOf(newId);
    const db = getDb();
    await db.transaction(async (tx) => {
      await rewriteNodeKeyedRows(tx, nestId, nodeId, newId);
      await rewriteNodeKeyedRows(tx, nestId, oldDerived, newDerived);
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
        serializeNodeSafe({ ...derivedDoc, id: newDerived }),
      );
      await storage.deleteDocument(oldDerived);
    } catch {
      /* no derived annotations node */
    }

    await trackEvent("node.move", { nestId, nodeId, newId });
    return { node: moved, previousId: nodeId };
  });
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
  await assertNotReviewLocked(nestId, nodeId, userEmail, "deleting");

  // Through the operation, which also regenerates the index — deleting the file
  // alone left context.yaml still listing the node, so graph-mode reads kept
  // resolving a document that was gone.
  try {
    await engineApi.run(
      "context_delete",
      { id: nodeId },
      await opContext(nestId, userEmail),
    );
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
    await engineApi.run(
      "context_delete",
      { id: derivedId },
      await opContext(nestId, userEmail),
    );
    await removeNodeFromTagIndex(nestId, derivedId);
  } catch {
    /* no derived annotations node — nothing to remove */
  }

  // Purge every row tied to this node id and its derived annotations node, so
  // a later doc landing on the same id inherits no history, readers, watchers
  // or comments. Annotation comments cascade via their thread FK.
  const db = getDb();
  await db.transaction(async (tx) => {
    await purgeNodeKeyedRows(tx, nestId, nodeId);
    await purgeNodeKeyedRows(tx, nestId, derivedId);
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

/**
 * Delete every document under a folder prefix, sub-folders included.
 *
 * A folder isn't a stored thing — it exists only as a segment of the node ids
 * beneath it (`nodes/<folder>/<slug>`), so deleting one IS deleting its
 * documents. Each goes through deleteNode, which keeps the per-node contract
 * intact: review lock, purge of node-keyed rows, and a tombstone for external
 * mirrors. Returns the ids removed.
 */
export async function deleteFolder(
  nestId: string,
  folder: string,
  userEmail: string,
): Promise<string[]> {
  const segments = folderToSegments(folder);
  if (segments.length === 0) {
    throw new ValidationError("folder is required");
  }
  const rel = segments.join("/");

  const { storage } = await engineCache.get(nestId);
  const docs = await storage.discoverDocuments();
  const targets = docs.map((d) => d.id).filter((id) => isIdUnderFolder(id, rel));
  if (targets.length === 0) {
    throw new NotFoundError(`No documents found under folder: ${folder}`);
  }

  // Sequential, not Promise.all: deleteNode takes a per-node write lock and
  // writes the shared tag index, and a partial failure must leave a coherent
  // vault — the error names how far it got.
  const deleted: string[] = [];
  for (const id of targets) {
    try {
      await deleteNode(nestId, id, userEmail);
      deleted.push(id);
    } catch (err) {
      const detail =
        deleted.length > 0
          ? ` (${deleted.length} of ${targets.length} already deleted)`
          : "";
      throw new Error(
        `Failed to delete "${id}"${detail}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return deleted;
}
