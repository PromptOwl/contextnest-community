/**
 * Node lifecycle service — shared by REST routes and MCP tools so
 * disk + DB stay in lockstep across both surfaces. Handlers stay thin
 * (auth, parse, response shape); this module owns create/update/list.
 */
import { assertFolderCreatable, assertFolderMovable, assertMovable, folderDeleteOrder, ruleRefusal, scaffold } from "../structure/writes.js";
import {
  parseDocument,
  normalizeStatus,
  isRejected,
  filterDocuments,
  DocumentNotFoundError,
  NODE_TYPES,
  TAG_PATTERN,
  generateIndexMd,
  readPdfBinary,
  pdfSidecarPath,
  viewMetaSchema,
  TITLE_MAX_LENGTH,
} from "@promptowl/contextnest-engine";
import type { ContextNode, NestStorage, PdfMeta } from "@promptowl/contextnest-engine";
import { rename, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { serializeNodeSafe } from "../governance/safe-publish.js";
import { assertNoViewCollision, batchViewCollisions } from "../views/collision.js";
import { engineCache, engineApi, opContext } from "./engine.js";
import { withIoStats } from "./io-stats.js";
import { inputJsonSchema } from "@promptowl/contextnest-engine/api";
import {
  AppError,
  NotFoundError,
  LockedError,
  ValidationError,
  ConflictError,
  ForbiddenError,
  ReviewRequiredError,
  VaultBusyError,
  isVaultLockTimeout,
} from "../shared/errors.js";
import { serializeClient, type ClientMetadata } from "../shared/client-metadata.js";
import { trackEvent } from "../telemetry/tracker.js";
import * as versions from "../governance/version-service.js";
import { reconstructApproved } from "../governance/approved-body.js";
import {
  syncNodeTags,
  syncNodeTagsMany,
  removeNodeFromTagIndex,
} from "../governance/tag-index-service.js";
import {
  isStewardshipEnabled,
  resolveNestPath,
  nestAllowsSelfApprove,
  nestReviewsPrimeOnly,
  nestCreatorIsReviewer,
} from "../nests/service.js";
import {
  isPrimeDocument,
  documentPrimeFlag,
  documentAlwaysIncludeFlag,
} from "../governance/prime-service.js";
import { getPendingReview, repointPendingReview } from "../governance/review-service.js";
import { notifyMentions } from "../governance/mention-notify.js";
import {
  resolveUserRoles,
  stewardDocumentCreator,
  removeSteward,
} from "../governance/stewardship-service.js";
import { canApproveWith } from "../governance/roles.js";
import {
  resolveCallerEmail,
  filterAccessible,
  canReadNode,
  readsWholeNest,
} from "../governance/access-guard.js";
import { isPublicReader } from "../shared/access.js";
import {
  listUserGrants,
  grantRoleForNode,
} from "../governance/grants-service.js";
import { getPendingChange } from "../governance/external-edit-service.js";
import { getDb } from "../db/client.js";
import type { Querier } from "../db/adapter.js";
import { ANON_USER_ID, MAX_FOLDER_DEPTH } from "../shared/constants.js";
import { withNodeWriteLock, nodeWriteKey } from "../shared/node-write-lock.js";
import { folderOfId, folderPathOf } from "../shared/node-id.js";
import {
  ensureNodeIndex,
  readIndexedNodes,
  indexedFolderCounts,
  nodesWithSuggestions,
} from "./node-index.js";
import { config } from "../config.js";
import { listNestPeople } from "../nests/people-service.js";
import { nestDoneTags } from "../nests/service.js";
import { notifyAssigned } from "../governance/assign-notify.js";
import {
  TASK_NODE_TYPE,
  applyTaskFields,
  hasTaskFieldsFilter,
  hasTaskFieldsPatch,
  matchesTaskFieldsFilter,
  type TaskFieldsFilter,
  taskFieldsOf,
  type TaskFields,
  type TaskFieldsPatch,
} from "./task-fields.js";
import { openBlockerCounts } from "./relations.js";
import {
  addComputedFields,
  appliesTo,
  applyFieldsPatch,
  assertFilterKeys,
  listFieldDefinitions,
  matchesFieldFilter,
  statusSince,
  storedFieldsOf,
  type FieldDefinition,
  type FieldsPatch,
} from "./custom-fields.js";

/** Reverse-lookup the auth userId from a registered email. Anonymous email → ANON. */
async function userIdFromEmail(email: string): Promise<string> {
  const db = getDb();
  const row = (await db.get(
    "SELECT id FROM users WHERE LOWER(email) = LOWER(?)",
    [email]
  )) as { id: string } | undefined;
  return row?.id ?? ANON_USER_ID;
}

/** Tag as stored: "#" + bare + lowercased. Casing is folded here so the tag a
 *  document carries keys the same as the one the tag index, facets and steward
 *  scopes resolve by — "GTM" and "gtm" are one tag, not two. Named apart from
 *  the tag index's `normalizeTag` (which yields the bare key) because the two
 *  differ by exactly that "#" and a shared name invites the wrong one. */
const storedTag = (t: string) =>
  `#${String(t).trim().replace(/^#+/, "").toLowerCase()}`;

/**
 * The same, for caller-supplied tags: anything the ENGINE's TAG_PATTERN
 * refuses is a 400 here. Otherwise it fails deep inside the engine write and
 * reaches the user as "Something went wrong on the server", losing the
 * unsaved document with it (a `café` tag did exactly that).
 */
function requireTag(raw: string): string {
  const tag = storedTag(raw);
  if (!TAG_PATTERN.test(tag)) {
    throw new ValidationError(
      `"${String(raw).trim()}" isn't a usable tag — a tag starts with a letter ` +
        `and is built from letters a-z, digits, "_", ":" and "-".`,
    );
  }
  return tag;
}

/** Caller-supplied tag list: blanks dropped, each validated, deduped. */
function requireTags(raw: readonly unknown[] | undefined): string[] {
  const tags = (raw || [])
    .map((t) => String(t).trim())
    .filter(Boolean)
    .map(requireTag);
  return [...new Set(tags)];
}

/** Result shape of the engine's `context_import` operation. A failed entry
 *  carries `id` (ids[] mode) or `title` (documents[] mode), never both. */
type ImportOpResult = {
  published: { id: string; version: number }[];
  failed: { id?: string; title?: string; error: string }[];
  checkpoint: number | null;
  warnings?: string[];
};

/** Max characters in a human-readable title. The id/slug bound (100 per
 *  segment, below) doesn't cover this: a title of emoji or non-latin text
 *  slugifies to almost nothing, so an unbounded title still lands in
 *  frontmatter and stretches every header that renders it. The engine owns the
 *  number, so a title a local vault accepts is never refused on push. */
const MAX_TITLE_LENGTH = TITLE_MAX_LENGTH;

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
 * The id `createNode` will derive for a title in `folder` (the nest root by
 * default), or null when the title slugifies to nothing (createNode generates
 * an id at write time, so it cannot be known in advance). Preview-only — the
 * confirm modal labels a staged document New vs Update with it, and the
 * structure check names the file a title will be saved as.
 */
export function derivedNodeId(title: string, folder = ""): string | null {
  const slug = slugify(title).slice(0, 100).replace(/-+$/, "");
  return slug ? `nodes/${[...folderToSegments(folder), slug].join("/")}` : null;
}

/** The first name a title with no a-z letters or digits gets (`document-N`, below). */
export const FIRST_GENERATED_NAME = "document-1";

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

// folderOfId / folderPathOf moved to shared/node-id.ts so the node index can
// derive a row's folder without importing this service. Re-exported here so
// every existing caller keeps its import.
export { folderOfId, folderPathOf };

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
 * Slugify + validate a folder path into id segments. Shared by create and
 * move so both enforce the same depth/length bounds and the same traversal
 * defense (each segment slugified independently — "../" collapses to "-",
 * empty segments drop).
 */
export function folderToSegments(folder: string): string[] {
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
    return slug ? storedTag(`dept:${slug}`) : null;
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
  // A structure rule (or another engine validation) refusing the write: the
  // caller can fix it, and "reload and try again" never would.
  const refusal = ruleRefusal(err);
  if (refusal) return refusal;
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
  // Vault write-lock timeout is retryable state, not an internal fault —
  // keep it as a 503 the caller can act on instead of a generic 500.
  if (isVaultLockTimeout(err)) {
    console.error(`${context}:`, err);
    return new VaultBusyError();
  }
  console.error(`${context}:`, err);
  return new AppError(500, message);
}

/** Reconstructed markdown split into its frontmatter and body. Unparseable →
 *  the raw text as body and no frontmatter (fail closed on metadata). */
export function parseVersionRaw(
  nodeId: string,
  raw: string,
): { body: string; frontmatter: Record<string, unknown> } {
  try {
    const doc = parseDocument(`${nodeId}.md`, raw, nodeId);
    return { body: doc.body ?? "", frontmatter: (doc.frontmatter ?? {}) as unknown as Record<string, unknown> };
  } catch {
    return { body: raw, frontmatter: {} };
  }
}

/** Strip YAML frontmatter from reconstructed markdown; mirrors node.body shape. */
export function bodyOnly(nodeId: string, raw: string): string {
  try {
    return parseDocument(`${nodeId}.md`, raw, nodeId).body ?? "";
  } catch {
    return raw;
  }
}

/**
 * Custom field values stored in a reconstructed version's frontmatter. A read
 * that serves an approved version takes its fields from HERE: the live file
 * may hold an unapproved draft's values. Unparseable → no values (fail closed).
 */
export function fieldsOfRaw(nodeId: string, raw: string): Record<string, unknown> {
  try {
    return storedFieldsOf(parseDocument(`${nodeId}.md`, raw, nodeId).frontmatter.metadata);
  } catch (err) {
    console.error("[custom-fields] approved frontmatter unreadable", nodeId, err);
    return {};
  }
}

/** Replace a response's stored field values (computed ones are added later). */
export function setStoredFields(r: { fields?: Record<string, unknown> }, fields: Record<string, unknown>): void {
  if (Object.keys(fields).length > 0) r.fields = fields;
  else delete r.fields;
}

export interface NodeResponse extends TaskFields {
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
  /** The published version agents are served, null if none. Lists only. */
  approvedVersion?: number | null;
  /** Orchestrator hint for runnable nodes (type agent/skill) — free-form
   *  cron/interval string, opaque to the server. */
  schedule?: string;
  /** Model the runner should use for this runnable node (agent/skill) —
   *  free-form model id, opaque to the server. */
  model?: string;
  /** Document-scope prime flag, undefined when the doc inherits from tag/nest
   *  scope. Clients resolve the inherited case from `tags` + the nest's
   *  `prime_tags` setting; the server gate is authoritative either way. */
  prime?: boolean;
  /** Document-scope always-include flag (CU-wdqcq05rn0), undefined when the
   *  doc inherits from the nest's `always_include_tags`. */
  always_include?: boolean;
  /** The `pdf:` block of a pdf node (sidecar path, sha256, size, pages,
   *  text_layer, extractor) — absent on every other type. */
  pdf?: PdfMeta;
  /** The Office file a document was extracted from (`metadata.original`):
   *  served at /nests/:nestId/originals/:file. Absent on every other node. */
  original?: OriginalFile;
  /** Blocking relations from nodes that aren't done yet (src/nodes/
   *  relations.ts). Absent when nothing open blocks this node. */
  open_blockers?: number;
  /** Custom field values (src/nodes/custom-fields.ts): the stored
   *  `metadata.fields` map plus, on list/get responses, computed fields such
   *  as time-in-status (whole seconds). Keys are the nest's field keys. */
  fields?: Record<string, unknown>;
  /** When the node entered its current board column — `moved_at`, else
   *  `created_at`. What time-in-status counts from. Tasks only. */
  status_since?: string;
}

/** Node types an orchestrator can fetch and run; only these carry schedule. */
export const RUNNABLE_NODE_TYPES = ["agent", "skill"] as const;
export function isRunnableType(type: string | undefined): boolean {
  return (RUNNABLE_NODE_TYPES as readonly string[]).includes(type || "");
}

/** A runner model id goes to an external runner as-is, so allow only plain
 *  id characters ("" means clear and is valid). */
const MODEL_ID_RE = /^[A-Za-z0-9._:\/@-]{1,128}$/;
function assertModelId(model: unknown): void {
  if (model === undefined || model === "") return;
  if (typeof model !== "string" || !MODEL_ID_RE.test(model)) {
    throw new ValidationError(
      "model must be a model id: 1-128 characters of letters, digits and . _ : / @ -"
    );
  }
}

/**
 * Node types this server accepts on create: the engine's core NODE_TYPES plus
 * the community extensions (agent/skill runnables, artifact, table). Anything
 * outside this set is rejected with a 400 at the create choke point below —
 * previously an unknown type slipped past here and surfaced as an opaque 500
 * from deeper in the write path.
 */
export const ACCEPTED_NODE_TYPES: ReadonlySet<string> = new Set<string>([
  ...NODE_TYPES,
  ...RUNNABLE_NODE_TYPES,
  "artifact",
  "table",
  "pdf",
  // Board work item (see task-fields.ts). Only once the engine knows the type:
  // the engine validates frontmatter.type against its own NODE_TYPES on every
  // write, so offering it ahead of that engine would turn every task create
  // into a 500. Board fields themselves work on any type regardless.
  ...((NODE_TYPES as readonly string[]).includes(TASK_NODE_TYPE)
    ? [TASK_NODE_TYPE]
    : []),
]);

/**
 * An uploaded Office file kept beside the nest (`<nest>/.originals/<file>`)
 * and bound to the document extracted from it. `file` is the server-minted
 * `<uuid>.<kind>` name; `sha256` is checked before the file is served.
 */
export interface OriginalFile {
  file: string;
  filename: string;
  kind: "pptx" | "docx" | "xlsx";
  bytes: number;
  sha256: string;
  /** Hash of the body this file produced, to tell hand edits apart on re-upload. */
  body_sha256?: string;
}

/** Server-minted original names only — the traversal defense for the route. */
export const ORIGINAL_FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pptx|docx|xlsx)$/;

export function isOriginalFile(v: unknown): v is OriginalFile {
  const o = v as OriginalFile | null | undefined;
  return (
    !!o &&
    typeof o === "object" &&
    typeof o.file === "string" &&
    ORIGINAL_FILE_NAME.test(o.file) &&
    typeof o.sha256 === "string"
  );
}

/** A pdf node's body is the text extracted from its binary (engine §1.11). */
export const PDF_NODE_TYPE = "pdf";

/** Where a pdf node comes from — the one way to create or re-version one. */
export const PDF_UPLOAD_HINT =
  "upload the file to POST /nests/:nestId/nodes/pdf (the Upload PDF action)";

/**
 * A PDF being written as a pdf node: the raw bytes and, optionally, the file
 * name it arrived under. Size and magic bytes are the caller's to check (the
 * route answers 413/400 before any governance work); the engine re-checks both.
 */
export interface PdfUpload {
  bytes: Uint8Array;
  filename?: string;
}

/**
 * Engine refusals on the PDF path are caller-actionable — not a PDF, an
 * encrypted or unreadable one, an id already taken, a node that is not a pdf.
 * Keep them as 4xx with the engine's own message instead of a generic 500.
 */
function pdfEngineError(err: unknown): unknown {
  const code = (err as { code?: string })?.code;
  const message = (err as Error)?.message || "The PDF could not be imported.";
  if (code === "VALIDATION_FAILED" || code === "INVALID_DOCUMENT_ID") {
    return new ValidationError(message);
  }
  if (code === "DOCUMENT_ALREADY_EXISTS") return new ConflictError(message);
  return err;
}

/** The type gate shared by create and convert: the feature flags for the
 *  artifact/table kinds, then the accepted set. Unknown types must fail as a
 *  clean 400 here — otherwise they slip through and throw an opaque 500 from
 *  deeper in the write path (the message gave a caller no idea the real
 *  problem was the `type` field). */
export function assertAcceptedType(type: string): void {
  if (type === "artifact" && !config.TYPE_ARTIFACT_ENABLED) {
    throw new ValidationError("Artifact nodes are disabled on this server");
  }
  if (type === "table" && !config.TYPE_TABLE_ENABLED) {
    throw new ValidationError("Table nodes are disabled on this server");
  }
  if (!ACCEPTED_NODE_TYPES.has(type)) {
    throw new ValidationError(
      `unknown node type "${type}"; allowed: ${[...ACCEPTED_NODE_TYPES]
        .sort()
        .join(", ")}`,
    );
  }
}

/**
 * The update-side counterpart of the create gate, for nodes that predate it.
 *
 * A node written before `assertAcceptedType` existed (or imported from a vault
 * with its own vocabulary) can carry a `type` this server never accepts, e.g.
 * `policy`. The engine re-validates the WHOLE frontmatter on every write, so
 * every update of such a node — even a no-op PATCH echoing its current body —
 * died inside the engine (`Document validation failed: Invalid enum value …
 * received 'policy'`) and reached the caller as the generic 500 from
 * toSafeError, with no hint that the stored type was the problem.
 *
 * Refuse the write here instead, as a 400 that names the type and the way
 * out: re-type the node in the same PATCH. A patch that carries a `type` is
 * left to assertAcceptedType (the engine accepts a re-type from an unknown
 * type: it sets `frontmatter.type` before validating). Read paths are not
 * touched — existing legacy nodes still list, render and version as before.
 */
function assertUpdatableType(storedType: string | undefined): void {
  const type = storedType || "document";
  // The soft-disable of artifact/table is create-only by design (see
  // createNode): existing nodes of a disabled type still save. Only a type
  // outside the accepted set can never reach the engine.
  if (ACCEPTED_NODE_TYPES.has(type)) return;
  throw new ValidationError(
    `node has legacy type "${type}" which this server no longer accepts; ` +
      `include "type": "<accepted type>" in the same PATCH to migrate it ` +
      `(allowed: ${[...ACCEPTED_NODE_TYPES].sort().join(", ")})`,
  );
}

export function toNodeResponse(node: ContextNode): NodeResponse {
  const fm = node.frontmatter;
  const taskFields = taskFieldsOf(fm.metadata);
  const fields = storedFieldsOf(fm.metadata);
  const since = statusSince({
    moved_at: taskFields.moved_at,
    created_at: fm.created_at == null ? undefined : String(fm.created_at),
  });
  // Coerce string-ish fields. YAML parses bare values by type, so a
  // frontmatter line like `title: 123` arrives as a number — clients then
  // call `.trim()`/`.toLowerCase()` on it and crash. Normalize at the API
  // boundary so every surface (editor, list search, MCP) gets strings.
  const title =
    fm.title === undefined || fm.title === null ? "" : String(fm.title);
  // Normalized and deduped on the way out, so every surface sees one tag set:
  // a card showing "#GTM" and "#gtm" while the editor (which keys tags
  // case-insensitively) showed a single "gtm" was the same document described
  // two ways.
  const tags = Array.isArray(fm.tags)
    ? [
        ...new Set(
          fm.tags
            .map((t) => String(t).trim())
            .filter(Boolean)
            .map(storedTag),
        ),
      ]
    : [];
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
    model:
      (fm.metadata as any)?.model != null ? String((fm.metadata as any).model) : undefined,
    prime: documentPrimeFlag(fm.metadata),
    always_include: documentAlwaysIncludeFlag(fm.metadata),
    ...(fm.type === "pdf" && fm.pdf ? { pdf: fm.pdf } : {}),
    ...(isOriginalFile((fm.metadata as any)?.original)
      ? { original: (fm.metadata as any).original as OriginalFile }
      : {}),
    ...taskFields,
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
    ...(fm.type === TASK_NODE_TYPE && since ? { status_since: since } : {}),
  };
}

/**
 * Responses with their computed field values filled in (time-in-status), for
 * the read surfaces that serve single nodes outside listNodesForCaller.
 */
export async function withComputedFields<T extends NodeResponse>(
  nestId: string,
  nodes: T[],
): Promise<T[]> {
  return addComputedFields(nodes, await listFieldDefinitions(nestId));
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

/**
 * A node the annotations projection maintains on the artifact's behalf, not one
 * a user authored. It stays a real vault node (that is how an agent picks the
 * feedback up on the next iteration), but every user-facing surface — listings,
 * counts, board, graph, search, tag facets — leaves it out, so commenting on an
 * artifact doesn't silently grow the nest's document count.
 *
 * Mirrors `derivedAnnotationsId` in annotations/service.ts; importing it would
 * close the annotations→nodes import cycle.
 *
 * The guarantee is convention, not structure: each surface filters for itself,
 * so a NEW listing or count can forget to. test/document-count-parity.test.ts
 * is what catches that — it pins every "how many documents" answer against the
 * document list, so a surface that starts counting these nodes fails there
 * rather than in someone's dashboard.
 */
export const DERIVED_ANNOTATIONS_SUFFIX = "--annotations";

export function isDerivedAnnotationsNode(id: string): boolean {
  return id.endsWith(DERIVED_ANNOTATIONS_SUFFIX);
}

export interface ListNodesFilters {
  /** One type, or several (e.g. runnable types) to keep. */
  type?: string | readonly string[];
  tag?: string;
  /** Keep the derived `— Annotations` nodes in the result. Off for the UI,
   *  which never asked for them; on for MCP, whose agents read them. */
  includeDerived?: boolean;
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
  /**
   * Serve each row's body as well as its metadata.
   *
   * OFF by default, which is what makes a listing cheap: the document set comes
   * from the DB mirror, and a body is the one field only the file has. Nothing
   * that renders a list shows one — the document tree doesn't, and MCP's
   * `context_list` deliberately drops it. Ask for it and the listing falls back
   * to crawling the vault, which is the honest price.
   */
  withContent?: boolean;
  /** Board-field filters (assignee / priority / due_before), applied before
   *  the access gate and `limit` so a filtered page is a full page. */
  task?: TaskFieldsFilter;
  /**
   * Custom-field filters, field key → wanted value (see matchesFieldFilter).
   * Every entry must match. An unknown key is a 400.
   */
  fields?: Record<string, unknown>;
  /**
   * Take custom field values (and filter on them) from each node's APPROVED
   * version, never the live file — for callers who may only see approved
   * content (MCP under stewardship). Implied by approvedOnly / public readers.
   */
  approvedFields?: boolean;
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
  // The cheap on-frontmatter filters go through the engine's own
  // `filterDocuments` on BOTH paths below, so this surface can't drift from the
  // CLI and mcp-server on what `type: document`, a `#`-less tag or a status
  // alias means. `includeRetired` because — unlike the CLI and mcp-server — a
  // retired node stays in this listing: here it is an unpublished document its
  // stewards may still need to act on, not one removed from retrieval. An
  // imported vault carrying `status: rejected` registers exactly that way.
  //
  // Split in two because the operation and `filterDocuments` spell the same
  // flag differently: the op takes `include_retired`, the function takes
  // `includeRetired`. Sending both used to be harmless (zod stripped the
  // stranger); since engine 2.4.0 an unrecognized parameter is a hard error,
  // so only `listFilters` may reach the op.
  const listFilters = {
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.tag ? { tag: filters.tag } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };
  const frontmatterFilters = { ...listFilters, includeRetired: true };

  let documents: Array<{
    id: string;
    frontmatter: ContextNode["frontmatter"];
    body?: string;
  }>;
  if (filters.withContent) {
    // Bodies only the files have, so this path still crawls. A `folder` scope
    // goes to the operation when the engine understands it, which narrows the
    // crawl to one directory. An older engine SILENTLY IGNORES an unknown key
    // (zod strips it) and would hand back everything, so the catalog is checked
    // rather than the parameter simply being sent; the JS narrowing below is
    // what keeps the result correct either way.
    const scopeInEngine = filters.folder !== undefined && engineScopesFolders();
    const scopePrefix = scopeInEngine ? await storagePrefix(nestId) : "";
    ({ documents } = await engineApi.run<{
      documents: Array<{
        id: string;
        frontmatter: ContextNode["frontmatter"];
        body: string;
      }>;
    }>(
      "context_list",
      {
        ...listFilters,
        include_retired: true,
        ...(scopeInEngine
          ? {
              folder: [scopePrefix, filters.folder].filter(Boolean).join("/"),
              recursive: false,
            }
          : {}),
        full: true,
      },
      await opContext(nestId, userEmail),
    ));
  } else {
    // From the DB mirror: no vault crawl, no file reads. `folder` narrows in
    // SQL, which is the narrowing that actually matters.
    await ensureNodeIndex(nestId);
    const indexed = await readIndexedNodes(
      nestId,
      filters.folder !== undefined ? { folder: filters.folder } : {},
    );
    documents = filterDocuments(indexed, {
      ...frontmatterFilters,
      includeRetired: true,
    });
  }
  // Derived annotation projections are machine-maintained, not documents the
  // caller wrote — keep them out of every listing that isn't MCP's.
  if (!filters.includeDerived) {
    documents = documents.filter((d) => !isDerivedAnnotationsNode(d.id));
  }
  // Narrow BEFORE the access gate and enrichment below — that is the whole
  // saving, since both cost per surviving document. Still applied even when
  // the engine already scoped the crawl: it is the correctness guarantee, and
  // on a scoped crawl there is nothing left for it to drop.
  const folderDocs =
    filters.folder === undefined
      ? documents
      : documents.filter((d) => folderOfId(d.id) === filters.folder);
  const folderScoped = hasTaskFieldsFilter(filters.task)
    ? folderDocs.filter((d) => matchesTaskFieldsFilter(d.frontmatter.metadata, filters.task!))
    : folderDocs;
  // Custom-field definitions: one query, for the filters here and the
  // computed values (time-in-status) added to every row at the end.
  const fieldDefs = await listFieldDefinitions(nestId);
  const fieldFilters = filters.fields ?? {};
  const hasFieldFilters = Object.keys(fieldFilters).length > 0;
  if (hasFieldFilters) assertFilterKeys(fieldFilters, fieldDefs);
  const matchesFields = (type: string | undefined, stored: Record<string, unknown>) =>
    Object.entries(fieldFilters).every(([key, wanted]) => {
      const def = fieldDefs.find((f) => f.key === key)!;
      // A field that doesn't apply to this node's type can't match.
      if (!appliesTo(def, type)) return false;
      return matchesFieldFilter(def, stored[key], wanted);
    });
  const publicReader = await isPublicReader(nestId, userId);
  // Approved-only view: what a public nest shows a stranger.
  const approvedOnly = publicReader || filters.approvedOnly === true;
  // A caller limited to approved content filters on APPROVED values (after
  // the access gate, below) — filtering on the live file here would let them
  // probe an unapproved draft's values.
  const approvedFields = approvedOnly || filters.approvedFields === true;
  const scoped = !hasFieldFilters || approvedFields
    ? folderScoped
    : folderScoped.filter((d) => matchesFields(d.frontmatter.type, storedFieldsOf(d.frontmatter.metadata)));
  const nodes: ContextNode[] = scoped.map((d) => ({
    id: d.id,
    filePath: "",
    rawContent: "",
    frontmatter: d.frontmatter,
    // Empty on the indexed path: no listing renders a body, and the
    // approved-only branch below serves its own from the version store.
    body: d.body ?? "",
  }));
  // ONE scan of the nest for the approved-only view, shared by the access
  // filter (which decides what a public reader may see) and the enrichment
  // below (which serves each body at its approved version) — those asked the
  // same question separately.
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

  // Approved versions, reconstructed at most once per node and shared by the
  // approved field filter and the enrichment below. null = none / unreadable.
  const approvedMap = approvedVersions ?? (approvedFields ? await versions.getApprovedVersions(nestId) : null);
  const approvedRaw = new Map<string, Promise<{ raw: string; version: number } | null>>();
  const loadApproved = (id: string) => {
    let p = approvedRaw.get(id);
    if (!p) {
      const v = approvedMap?.get(id);
      p = v == null
        ? Promise.resolve(null)
        : reconstructApproved(versionManager, nestId, id, v).catch((err) => {
            console.error("reconstructVersion failed (list)", id, v, err);
            return null;
          });
      approvedRaw.set(id, p);
    }
    return p;
  };
  if (approvedFields && hasFieldFilters) {
    // ponytail: reconstructs every accessible node's approved version to
    // filter — an approved-values index if governed nests grow large.
    const keep = await Promise.all(
      accessible.map(async (d) => {
        const a = await loadApproved(d.id);
        return !!a && matchesFields(d.frontmatter.type, fieldsOfRaw(d.id, a.raw));
      }),
    );
    accessible = accessible.filter((_, i) => keep[i]);
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
  const [displayState, driftedDocs] = approvedVersions
    ? [null, null]
    : await Promise.all([
        versions.getDisplayState(nestId),
        // From the DB, not a vault walk. The disk truth behind it is
        // reconciled by the index rebuild and kept current by the stage /
        // approve / reject paths.
        nodesWithSuggestions(nestId),
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

      // Field values from the approved version, never the live draft.
      const approved = approvedFields ? await loadApproved(doc.id) : null;
      if (approvedFields) setStoredFields(r, approved ? fieldsOfRaw(doc.id, approved.raw) : {});

      if (approvedVersions) {
        const wanted = approvedVersions.get(doc.id);
        if (wanted != null) {
          r.content = approved ? bodyOnly(doc.id, approved.raw) : "";
          r.version = approved?.version ?? wanted;
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
        r.status = displayState?.statuses.get(r.id) ?? "draft";
      }
      r.approvedVersion = displayState?.approved.get(r.id) ?? null;
      return r;
    })
  );

  // Task relations: stamp how many open blockers each listed node has, so the
  // board can badge blocked cards. One edges query for the nest (none when the
  // nest has no blocking relations at all).
  if (enriched.length) {
    const blockers = await openBlockerCounts(nestId, enriched.map((r) => r.id));
    if (blockers.size) {
      for (const r of enriched) {
        const n = blockers.get(r.id);
        if (n) r.open_blockers = n;
      }
    }
  }

  return addComputedFields(enriched, fieldDefs);
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
 * Create a folder with nothing in it.
 *
 * A folder is a real directory in the vault, so making one means creating that
 * directory — not seeding a placeholder document, which is what "New folder"
 * used to do and which then counted as content everywhere (CU-wdqcpzzzut).
 *
 * The directory is created by writing the folder's INDEX.md, the same derived
 * summary `regenerateIndex` maintains for every other folder: it mkdir -p's on
 * the way in, discovery skips it (DERIVED_VAULT_FILES), and a regeneration
 * only ever rewrites index files — it never prunes one. Returns the slugified
 * path actually created.
 */
export async function createEmptyFolder(
  nestId: string,
  folder: string,
): Promise<string> {
  const segments = folderToSegments(folder);
  if (segments.length === 0) {
    throw new ValidationError("folder is required");
  }
  const path = segments.join("/");
  const prefix = await storagePrefix(nestId);
  const vaultPath = prefix ? `${prefix}/${path}` : path;
  // Already a folder: writing the index again would replace a real summary
  // with an empty one until the next regeneration. Creating what exists is a
  // no-op, not an error — a retry of the same name should be harmless.
  if (await vaultFolderExists(nestId, path)) return path;
  const title = segments[segments.length - 1]!
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  const { storage } = await engineCache.get(nestId);
  // Under enforced rules: a folder they allow, named as they say, created
  // with its required subfolders and files.
  const plan = await assertFolderCreatable(storage, path, vaultPath);
  await storage.writeIndexMd(vaultPath, generateIndexMd(vaultPath, title, []));
  await scaffold(storage, plan);
  return path;
}

/**
 * Folder paths that exist in the vault as directories, community-dialect
 * (no `nodes/` prefix). Directory entries only — no document is opened.
 *
 * The DB mirror derives folders from the documents in them, so a folder
 * holding nothing is invisible to it. This is how an empty one is still a
 * folder (CU-wdqcpzzzut): it is a real directory on disk either way.
 */
async function vaultFolderPaths(
  nestId: string,
  opts: { folder?: string; recursive?: boolean } = {},
): Promise<string[]> {
  const prefix = await storagePrefix(nestId);
  const scope = [prefix, opts.folder].filter(Boolean).join("/");
  const { storage } = await engineCache.get(nestId);
  const entries = await storage.listFolders({
    ...(scope ? { folder: scope } : {}),
    ...(opts.recursive === false ? { recursive: false } : {}),
  });
  return entries
    .map((e) =>
      prefix && e.path.startsWith(`${prefix}/`)
        ? e.path.slice(prefix.length + 1)
        : e.path,
    )
    // A flat nest shares its root with the uploads dir (<nest>/assets) — not a document folder.
    .filter((p) => p && !(!prefix && (p === "assets" || p.startsWith("assets/"))));
}

/**
 * Direct document counts per folder over only the documents this caller can
 * read — the narrowed counterpart of `indexedFolderCounts`. Same document set
 * and exclusions as the census, so the two trees agree for every caller.
 */
async function readableFolderCounts(
  nestId: string,
  userId: string,
  userEmail: string,
): Promise<Array<{ path: string; count: number }>> {
  const documents = (await readIndexedNodes(nestId)).filter(
    (d) => !isDerivedAnnotationsNode(d.id),
  );
  const visible = await filterAccessible(nestId, userId, userEmail, documents);
  const direct = new Map<string, number>();
  for (const d of visible) {
    const folder = folderOfId(d.id);
    if (folder) direct.set(folder, (direct.get(folder) || 0) + 1);
  }
  return [...direct].map(([path, count]) => ({ path, count }));
}

/**
 * The nest's folders, from the DB mirror plus the vault's directory shape.
 *
 * Document counts come from the mirror, which stores each document's folder as
 * a column — one GROUP BY rather than a full crawl (the id-derived fallback it
 * used before), correct on a nest this process has never opened. Folders with
 * no document of their own can only come from the vault, so a paths-only walk
 * (no file is opened) fills those in at count 0.
 *
 * `folder` is a community folder path ("" = nest root), NOT an id prefix; the
 * `nodes/` storage root is added here so callers keep speaking one dialect.
 *
 * Pass `caller` from any request path. A caller who reads every document gets
 * the whole tree as above. A narrowed caller (a public reader of a governed
 * nest, a tag- or document-scoped steward) gets only folders holding at least
 * one document they can read, counted over those documents — the directory
 * walk would otherwise name folders that hold nothing they may open, and the
 * mirror's counts would include documents they cannot see.
 */
export async function listNestFolders(
  nestId: string,
  opts: {
    folder?: string;
    recursive?: boolean;
    caller?: { userId: string; userEmail: string };
  } = {},
): Promise<FolderNode[]> {
  if (opts.folder !== undefined) assertSafeFolder(opts.folder);
  await ensureNodeIndex(nestId);
  const counts = new Map<string, number>();
  const narrowed =
    opts.caller !== undefined &&
    !(await readsWholeNest(nestId, opts.caller.userId, opts.caller.userEmail));
  const folderCounts = narrowed
    ? await readableFolderCounts(nestId, opts.caller!.userId, opts.caller!.userEmail)
    : await indexedFolderCounts(nestId);
  // Directories first, so a folder holding nothing is still a folder; the
  // mirror's counts below win wherever it knows the folder. Not for a narrowed
  // caller: an empty or wholly-restricted folder says nothing they may read.
  if (!narrowed) {
    for (const path of await vaultFolderPaths(nestId, opts)) counts.set(path, 0);
  }
  for (const { path, count } of folderCounts) {
    counts.set(path, count);
    // Ancestors with no document of their own still need a row — a level that
    // only holds subfolders still has to be expandable.
    let parent = path;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      if (!counts.has(parent)) counts.set(parent, 0);
    }
  }
  const direct = [...counts].map(([path, count]) => ({ path, count }));

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
  /** Documents with a published version agents are served, whatever the
   *  status of their latest version. */
  aiReady: number;
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
  // From the DB mirror, not the vault. This describes the WHOLE nest whatever
  // folder is open, so on disk it meant reading and parsing every file in the
  // nest on every mount — the single most expensive thing the page did, and
  // the one the lazy per-folder loading could not avoid.
  await ensureNodeIndex(nestId);
  // Same exclusion as the listing — the counts must describe the documents the
  // Documents tab shows, not those plus the annotation projections.
  const documents = (await readIndexedNodes(nestId)).filter(
    (d) => !isDerivedAnnotationsNode(d.id),
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
    // Keyed by the normalized tag, because the filter a facet chip applies
    // matches case-insensitively: counting "#GTM" and "#gtm" apart put a "2"
    // on a chip that then returned 3 documents.
    for (const t of new Set((fm.tags || []).map((t) => storedTag(String(t)))))
      tags[t] = (tags[t] || 0) + 1;
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
  // Folders holding no document — same vault walk listNestFolders merges —
  // only for a caller who reads every document. For anyone narrowed (a public
  // reader, a scoped steward) the walk would name folders that hold only what
  // they cannot open, so their tree is the folders of `visible` alone; same
  // rule as listNestFolders, and the same readsWholeNest predicate, so a
  // narrowed caller who happens to reach every existing document still gets the
  // same tree here as from /folders.
  if (await readsWholeNest(nestId, userId, userEmail)) {
    for (const path of await vaultFolderPaths(nestId)) paths.add(path);
  }
  // Same roll-up the folders endpoint uses — the two describe the same tree
  // and must not drift.
  const folders = withSubtreeTotals(
    [...paths].map((path) => ({ path, count: direct.get(path) ?? 0 })),
  );

  const { statuses: statusMap, approved } = await versions.getDisplayState(nestId);
  const statuses: Record<string, number> = {};
  let aiReady = 0;
  for (const d of visible) {
    const st = statusMap.get(d.id) ?? "draft";
    statuses[st] = (statuses[st] || 0) + 1;
    if (approved.has(d.id)) aiReady++;
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
    aiReady,
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
  // MCP is the agent surface the annotation projection exists for, so it keeps
  // seeing those nodes unless a caller says otherwise.
  return listNodesForCaller(nestId, await userIdFromEmail(userEmail), {
    includeDerived: true,
    ...filters,
  });
}

export interface CreateNodeInput extends TaskFieldsPatch {
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
  /** Runner model for this agent/skill (opaque id). Runnable types only. */
  model?: string;
  /** Folder path under nodes/ (e.g. "gtm/deals"). Each segment is slugified;
   *  storage and read/update/delete already handle nested ids, only creation
   *  was flat. Ignored when an explicit id is given. */
  folder?: string;
  /** Document-scope prime flag — see `isPrimeDocument`. Omit to inherit from
   *  the nest's prime tags; `false` exempts this doc from an otherwise-prime
   *  tag. */
  prime?: boolean;
  /** Document-scope always-include flag — see `isAlwaysIncludeDocument`.
   *  Owner/admin only, like `prime`. */
  alwaysInclude?: boolean;
  /** Caller attribution recorded on the version this create seals (§9.4).
   *  Optional everywhere — an unattributed write is a valid write. */
  client?: ClientMetadata;
  /** Create a `pdf` node from these bytes (engine `context_import_pdf`) instead
   *  of a markdown body. `content` is ignored — the body is the extracted text.
   *  Requires `type: "pdf"` (or no type). */
  pdf?: PdfUpload;
  /** The uploaded Office file this document's text was extracted from
   *  (office-service.ts). Stored as `metadata.original`, so the binding is
   *  part of every version's hash. */
  original?: OriginalFile;
  /** Custom field values, field key → value (see custom-fields.ts). Defaults
   *  fill what's left out; required fields must end up set. */
  fields?: FieldsPatch;
  /** The `view:` block of a type: view node (§1.12) — validated against the
   *  engine's view schema, refused on any other type. */
  view?: unknown;
}

export interface UpdateNodePatch extends TaskFieldsPatch {
  content?: string;
  append?: string;
  tags?: string[];
  title?: string;
  /** Frontmatter one-line summary (the docs site's meta description). An
   *  empty string removes it. */
  description?: string;
  status?: string;
  changeNote?: string;
  /** Orchestrator schedule — runnable types only; empty string clears it. */
  schedule?: string;
  /** Runner model — runnable types only; empty string clears it. */
  model?: string;
  /** Document-scope prime flag. `null` clears it back to tag/nest inheritance. */
  prime?: boolean | null;
  /** Document-scope always-include flag. `null` clears it back to the tags. */
  alwaysInclude?: boolean | null;
  /** A re-uploaded Office file (office-service.ts): the new `metadata.original`,
   *  and every earlier one, so each version's file stays downloadable. */
  original?: OriginalFile;
  previousOriginals?: OriginalFile[];
  /** See CreateNodeInput.client. */
  client?: ClientMetadata;
  /** Re-type the node (the editor's "Convert to…"). Same accepted set and
   *  feature flags as create; leaving a runnable type drops its schedule. */
  type?: string;
  /** A new PDF for a pdf node — the only way its body changes. Runs the
   *  engine's `context_import_pdf` in place of `context_update`; governance
   *  (draft vs publish, version rows, review lock) is the same as any edit. */
  pdf?: PdfUpload;
  /** Custom field values to set, field key → value; `null` clears one. Merged
   *  into the stored map — keys left out are untouched. */
  fields?: FieldsPatch;
  /** Replacement `view:` block (§1.12), for a node that is or is becoming
   *  type: view. Replaces the block wholesale; validated like create. */
  view?: unknown;
}

/**
 * Validate a `view:` block with the engine's own schema (§13 rules 30–36) and
 * the type it is meant for. The engine re-validates on write; checking here
 * turns its refusal into a 400 that names the rule, before any governance
 * work, on every surface (REST, MCP, a held write's replay).
 */
export function assertViewBlock(view: unknown, type: string): void {
  if (type !== "view") {
    throw new ValidationError(
      `A view block is only valid on type: view (§13 rule 31), and this node is type: "${type}". Pass type: "view" in the same call, or drop the view parameter.`,
    );
  }
  if (view === null || typeof view !== "object" || Array.isArray(view)) {
    throw new ValidationError("view must be an object: { blocks: [...] } (§1.12)");
  }
  const parsed = viewMetaSchema.safeParse(view);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) =>
      i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message,
    );
    throw new ValidationError(`Invalid view block — ${issues.join("; ")}`);
  }
}

/**
 * Per-write switches for a machine-generated save.
 *
 * `notifyMentions: false` is for a body this server composed rather than a
 * person wrote — today the derived `— Annotations` projection of an artifact's
 * comment threads. Those `@names` are copies of names already notified where
 * they were typed, so notifying again would fire twice and point the reader at
 * the projection instead of the document they were named in. Kept as a call-site
 * decision rather than a guess about the node id, so a person editing that
 * document by hand still notifies normally.
 */
export interface WriteOptions {
  notifyMentions?: boolean;
  /**
   * False keeps a create out of the nest's creator-reviews posture: the
   * author is not stewarded and v1 is not published on their authority. For
   * documents the system derives (the annotations projection), which nobody
   * authored.
   */
  creatorReviews?: boolean;
  /**
   * The version the caller last saw as this node's head. Checked INSIDE the
   * write lock, so a change that landed between the caller's look and this
   * write is refused (409) instead of overwritten. The agent-activity undo
   * uses it: its "nothing changed since" check has to hold at write time.
   */
  expectHead?: number;
  /**
   * Never publish this write, whatever the nest's posture (ungoverned,
   * prime-only, self-approve, creator-reviews): it lands as a draft for a
   * reviewer. A metacognition agent's proposals use it — an agent's change is
   * a proposal by definition, so no bypass that exists for people applies.
   */
  alwaysDraft?: boolean;
  /**
   * The opposite guarantee: this write must publish, or not happen at all.
   * When the nest's rules would land it as a draft for a reviewer (a prime
   * document, a governed document without a self-approve bypass, or the
   * author's own open review), it is refused with ReviewRequiredError BEFORE
   * anything is written. Bulk board edits use it, so one confirmation can't
   * quietly turn into a pile of drafts — those documents are reported and
   * left for someone to change one at a time, through the review they need.
   * Decided inside the node's write lock, by the same autoPublishReason the
   * write itself uses, so it can't disagree with what would have happened.
   */
  publishOnly?: boolean;
  /**
   * A reviewer's edit to someone else's pending submission, made on the way
   * to approving it (POST …/approve-with-edits, CU-wdqcq04wnw). Lifts the
   * pending-review lock exactly as an author's own edit does: drafts a new
   * version and repoints the open review, whose submitter stays the author.
   * The caller has already checked edit + approve rights.
   */
  reviewerEdit?: boolean;
}

/** Refuse the write if the node's head moved past what the caller saw.
 *  Call inside the node's write lock. */
async function assertHead(nestId: string, nodeId: string, expectHead: number | undefined): Promise<void> {
  if (expectHead === undefined) return;
  const current = await versions.getCurrentVersion(nestId, nodeId);
  if (current !== expectHead) {
    throw new ConflictError(
      `This document changed while you were looking at it (now v${current}, you saw v${expectHead}). Reload and try again.`,
    );
  }
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
  userEmail: string,
  what = "prime flag",
): Promise<void> {
  const roles = await resolveUserRoles(nestId, userEmail);
  if (!roles.includes("owner") && !roles.includes("admin")) {
    throw new ForbiddenError(
      `Only the nest owner or an admin can change a document's ${what}.`
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
  doc: { tags?: readonly unknown[]; metadata?: unknown; type?: string },
  opts: { creatorReviews?: boolean; governed?: boolean } = {},
): Promise<string | null> {
  // Ungoverned nest: nothing to review, nobody to review it. A caller that
  // already looked this up passes it in — create is a hot path.
  const governed = opts.governed ?? (await isStewardshipEnabled(nestId));
  if (!governed) return "no stewards configured";
  if (await isPrimeDocument(nestId, doc.tags, doc.metadata)) return null;
  // Board work moves column many times a day; gating every drag behind a
  // reviewer would make a project board unusable. Prime still wins (above):
  // a steward who flags a task prime has asked for review on purpose.
  if (doc.type === TASK_NODE_TYPE) return "task — board work skips review";
  // Creator-reviews (a create, in a nest with the posture on): the author is
  // this document's reviewer, so v1 is theirs to publish. Only v1 — every
  // later edit, theirs included, is a change to a reviewed document and goes
  // through the queue.
  if (opts.creatorReviews) return "creator is the document's reviewer";
  // Prime-only posture: everything that isn't prime self-publishes.
  if (await nestReviewsPrimeOnly(nestId)) {
    return "prime-only review, document is not prime";
  }
  return (await actorAutoPublishes(nestId, userEmail))
    ? "owner/admin self-approve"
    : null;
}

/** Roster / parent lookups applyTaskFields needs, bound to one nest. */
function taskFieldsContext(
  nestId: string,
  storage: NestStorage,
  nodeId: string | null,
) {
  return {
    nodeId,
    now: new Date().toISOString(),
    roster: async () =>
      new Set((await listNestPeople(nestId)).map((p) => p.email.toLowerCase())),
    nodeExists: async (id: string) => {
      try {
        await storage.readDocument(id);
        return true;
      } catch {
        return false;
      }
    },
    parentOf: async (id: string) => {
      try {
        const n = await storage.readDocument(id);
        return taskFieldsOf(n.frontmatter.metadata).parent ?? null;
      } catch {
        return null;
      }
    },
  };
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
  opts: WriteOptions = {},
): Promise<NodeMutationResult> {
  const generatedId = !input.id && !slugify(input.title);
  for (let attempt = 0; ; attempt++) {
    try {
      return await createNodeOnce(nestId, input, userEmail, opts);
    } catch (err) {
      if (!generatedId || attempt >= 3 || !(err instanceof ConflictError)) {
        // A rule refusing the document is the caller's to fix — kept as a 400
        // naming the rule, also where only an AppError's message is shown (a push).
        throw ruleRefusal(err) ?? err;
      }
    }
  }
}

async function createNodeOnce(
  nestId: string,
  input: CreateNodeInput,
  userEmail: string,
  opts: WriteOptions = {},
): Promise<NodeMutationResult> {
  const { storage } = await engineCache.get(nestId);

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
  const tags = requireTags(input.tags);

  // Content-type toggles: creation of a disabled type is refused here — the
  // shared choke point for REST + MCP — so every surface gates identically.
  // Soft-disable only: existing nodes of a disabled type still read/render/
  // version untouched. Runnable types (agent/skill/tool) are gated by
  // FEATURE_WORKFLOW_PLANE at the plane routes, not here.
  const requestedType = input.pdf ? input.type || PDF_NODE_TYPE : input.type || "document";
  assertAcceptedType(requestedType);
  // A pdf node's `pdf:` block records bytes, and a JSON create carries none —
  // the engine would refuse the block-less node as an opaque 500. Point the
  // caller at the one surface that can make one.
  if (requestedType === PDF_NODE_TYPE && !input.pdf) {
    throw new ValidationError(`PDF documents can't be created from text — ${PDF_UPLOAD_HINT}.`);
  }
  if (input.pdf && requestedType !== PDF_NODE_TYPE) {
    throw new ValidationError(`a PDF upload creates a "pdf" node, not "${requestedType}"`);
  }
  if (input.view !== undefined) assertViewBlock(input.view, requestedType);

  assertModelId(input.model);
  for (const field of ["schedule", "model"] as const) {
    if (input[field] !== undefined && !isRunnableType(input.type)) {
      throw new ValidationError(
        `${field} is only valid for runnable node types (${RUNNABLE_NODE_TYPES.join(
          ", "
        )})`
      );
    }
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
    // A view's page and frames are served at <view>/view/…: neither may be
    // taken by another node, nor a view placed where one already is.
    await assertNoViewCollision(storage, id, requestedType);

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
    // that fails them never pays the DB lookup. Both sides are already folded
    // to lower case by storedTag, so "#Dept:Engineering" and the auto tag are
    // the same string and a plain match dedupes them.
    const deptTag = await departmentTagFor(userEmail);
    if (deptTag && !tags.includes(deptTag)) {
      tags.push(deptTag);
    }

    if (input.prime !== undefined) await assertMayFlagPrime(nestId, userEmail);
    // Always-include pushes this document to every agent entering the nest,
    // so flagging it is a governance act too (CU-wdqcq05rn0).
    if (input.alwaysInclude !== undefined) {
      if (typeof input.alwaysInclude !== "boolean") {
        throw new ValidationError("always_include must be true or false");
      }
      await assertMayFlagPrime(nestId, userEmail, "always-include flag");
    }
    const metadata: Record<string, unknown> = {
      owners: ["*"],
      scope: input.scope || "team",
      ...(input.schedule ? { schedule: input.schedule } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.prime === undefined ? {} : { prime: input.prime }),
      ...(input.alwaysInclude === undefined ? {} : { always_include: input.alwaysInclude }),
      ...(input.original ? { original: input.original } : {}),
    };
    if (input.type === TASK_NODE_TYPE) {
      const done = new Set(await nestDoneTags(nestId));
      if (tags.some((t) => done.has(String(t).toLowerCase().replace(/^#/, "")))) {
        metadata.completed_at = new Date().toISOString();
      }
    }
    if (hasTaskFieldsPatch(input)) {
      const { metadata: withFields } = await applyTaskFields(
        metadata,
        input,
        taskFieldsContext(nestId, storage, null),
      );
      // Nulls on a create mean "not set" — nothing to clear yet.
      Object.assign(metadata, withFields);
    }
    // Custom fields: validated against the nest's definitions, defaults
    // filled, required enforced. Stored in frontmatter so the values are
    // part of v1's hash. Skipped entirely (no definition read) only when the
    // nest has none and the caller sent none.
    {
      const defs = await listFieldDefinitions(nestId);
      if (defs.length > 0 || input.fields !== undefined) {
        const { fields } = await applyFieldsPatch({
          defs,
          nodeType: input.type || "document",
          current: {},
          patch: input.fields,
          isCreate: true,
          roster: taskFieldsContext(nestId, storage, null).roster,
        });
        if (Object.keys(fields).length > 0) metadata.fields = fields;
      }
    }
    // Creator-reviews: steward the author BEFORE deciding to publish, since v1
    // publishes on the strength of that row. A failure here fails the create
    // with nothing written — never a document published on a false premise.
    // The id is reserved by the lock and free (checked above), so the row
    // can't name someone else's document. Not atomic with the engine write
    // (a separate filesystem + DB path this can't join in one transaction), so
    // it is compensated instead: everything from here until the document is on
    // disk runs under one guard that takes the row back on any failure. A row
    // left behind on a free id would attach to whoever creates that id next.
    const governed = await isStewardshipEnabled(nestId);
    const creatorReviews =
      opts.creatorReviews !== false &&
      governed &&
      (await nestCreatorIsReviewer(nestId));
    const creatorSteward = creatorReviews
      ? await stewardDocumentCreator(nestId, id, userEmail)
      : null;

    let published = false;
    let publishNote: string | undefined;
    try {
      const publishReason = opts.alwaysDraft
        ? null
        : await autoPublishReason(
            nestId,
            userEmail,
            { tags, metadata, type: input.type },
            { creatorReviews: creatorSteward?.canApprove === true, governed },
          );
      // Same note in the engine history and the governance row: the version
      // history an admin reads in the UI comes from node_versions, so leaving
      // the reason only in history.yaml hides it from the audit that matters.
      publishNote =
        publishReason === null
          ? undefined
          : `Auto-published on create (${publishReason})`;
      published = publishReason !== null;

      // Write — and publish, when the gate allows — through the engine's
      // canonical create. Governance stays here; the engine owns frontmatter
      // assembly, validation, version assignment and the index regen, so a
      // document created here is identical to one created by the CLI or
      // mcp-server.
      try {
        if (input.pdf) {
          // Same id, tags, publish decision and note as context_create gets —
          // only the op differs: the engine stores the binary beside the node,
          // binds it by sha256 and writes the extracted text as the body.
          try {
            await engineApi.run(
              "context_import_pdf",
              {
                id,
                title: input.title,
                bytes_base64: Buffer.from(input.pdf.bytes).toString("base64"),
                ...(input.pdf.filename ? { filename: input.pdf.filename } : {}),
                ...(tags.length ? { tags } : {}),
                publish: published,
                ...(publishNote ? { note: publishNote } : {}),
                ...(input.client ? { client: input.client } : {}),
              },
              await opContext(nestId, userEmail),
            );
          } catch (err) {
            throw pdfEngineError(err);
          }
        } else {
          await engineApi.run(
            "context_create",
            {
              id,
              title: input.title,
              content: input.content,
              type: requestedType,
              // A skill node is invalid without a skill block, and this surface
              // has no field for one — default the trigger from the title, same
              // as the CLI and mcp-server do.
              ...(requestedType === "skill"
                ? { trigger: `when asked to ${input.title.toLowerCase()}` }
                : {}),
              ...(tags.length ? { tags } : {}),
              ...(input.status ? { status: input.status } : {}),
              ...(input.view !== undefined ? { view: input.view } : {}),
              metadata,
              publish: published,
              ...(publishNote ? { note: publishNote } : {}),
            },
            await opContext(nestId, userEmail),
          );
        }
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
    } catch (err) {
      // Nothing is on disk (the inner catch only rethrows when the write never
      // landed), so the steward row would name a document that never existed.
      // The original failure is what the caller needs to see; a failed
      // compensation is logged, not substituted for it.
      if (creatorSteward?.insertedId) {
        try {
          await removeSteward(creatorSteward.insertedId);
        } catch (cleanupErr) {
          console.error(
            "removeSteward failed while compensating a failed create",
            id,
            cleanupErr,
          );
        }
      }
      throw err;
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
        client: input.client,
      });
      await versions.setApprovedVersion(nestId, id, savedVersion, userEmail);
    } else {
      // No history entry for a genuine draft — same rule as the draft branch of
      // updateNode: the chain records releases, not unreviewed work. The first
      // publish seals v1 of the chain from whatever the file says then.
      await versions.createVersion({
        nestId,
        nodeId: id,
        version: 1,
        // A pdf node's body is what the engine extracted, not anything sent.
        content: input.pdf ? node.body || "" : input.content,
        author: userEmail,
        status: "draft",
        tags,
        client: input.client,
      });
    }

    await trackEvent("node.create", { nestId, nodeId: id });
    const createdAssignee = taskFieldsOf(node.frontmatter.metadata).assignee;
    // A draft's assignment isn't real until a reviewer approves it.
    if (createdAssignee && published) {
      await notifyAssigned({
        nestId,
        nodeId: id,
        title: input.title,
        assignee: createdAssignee,
        actorEmail: userEmail,
      });
    }
    // Everything a new document mentions is new.
    if (opts.notifyMentions !== false) {
      await notifyMentions({
        nestId,
        nodeId: id,
        previousBody: "",
        nextBody: node.body || "",
        actorEmail: userEmail,
      });
    }
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
): Promise<{ written: number; rejected: string[]; problems: string[]; warnings: string[] }> {
  return withIoStats(nestId, "stage", () => stageImportedFilesInner(nestId, files, userEmail));
}

async function stageImportedFilesInner(
  nestId: string,
  files: Array<{ path: string; content: string }>,
  userEmail: string
): Promise<{ written: number; rejected: string[]; problems: string[]; warnings: string[] }> {
  // `_suggestions` is a vault's OWN staged-suggestion store — derived
  // governance state, not content. Carried in, another vault's copy surfaces as
  // phantom external edits against doc ids that don't resolve here. Dropped
  // server-side, not in the browser: the endpoint can't trust its caller.
  // `.context/` is the source vault's own settings, which the engine refuses
  // to import; dropped too, so an exported nest doesn't report it as a failure.
  // Everything else travels verbatim, `.versions/` history included.
  const carried = files.filter((f) => {
    const segs = String(f?.path || "").split(/[\\/]/);
    return !segs.includes("_suggestions") && !segs.includes(".context");
  });
  if (!carried.length) return { written: 0, rejected: [], problems: [], warnings: [] };
  // View addresses (see views/collision.ts): a document arriving at a view's
  // <view>/view/… address, or a view arriving over an occupied one, is refused
  // like any other unusable file — named, with the reason.
  const viewRefusals: Array<{ path: string; why: string }> = [];
  {
    const idOf = (path: string) => path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "");
    const docsIn = carried
      .filter((f) => /\.md$/i.test(String(f.path)) && !String(f.path).split(/[\\/]/).some((seg) => seg.startsWith(".")))
      .map((f) => {
        const id = idOf(String(f.path));
        let type = "document";
        try {
          type = String(parseDocument(`${id}.md`, String(f.content ?? ""), id).frontmatter.type || "document");
        } catch {
          /* unparseable: the engine reports it */
        }
        return { id, type, path: String(f.path) };
      });
    if (docsIn.some((d) => d.type === "view" || /(^|\/)view(\/|$)/.test(d.id))) {
      const { storage } = await engineCache.get(nestId);
      const existing = (await storage.discoverDocuments({ includeRetired: true } as any)).map((d) => ({
        id: d.id,
        type: String(d.frontmatter.type || "document"),
      }));
      const refused = batchViewCollisions(docsIn, existing);
      for (const d of docsIn) {
        const why = refused.get(d.id);
        if (why) viewRefusals.push({ path: d.path, why });
      }
    }
  }
  if (viewRefusals.length) {
    const drop = new Set(viewRefusals.map((r) => r.path));
    for (let i = carried.length - 1; i >= 0; i--) if (drop.has(String(carried[i].path))) carried.splice(i, 1);
    if (!carried.length) {
      return {
        written: 0,
        rejected: viewRefusals.map((r) => r.path),
        problems: viewRefusals.map((r) => `${r.path}: refused — ${r.why}`),
        warnings: [],
      };
    }
  }
  const startedAt = Date.now();
  const result = await engineApi.run<{
    written?: number;
    failed: Array<{ id?: string; error: string }>;
    warnings?: string[];
  }>(
    "context_import",
    { files: carried, publish: false },
    await opContext(nestId, userEmail)
  );
  console.log(
    `[import] staged: nest=${nestId} files=${carried.length} written=${result.written ?? 0} ms=${Date.now() - startedAt}`
  );
  // A rejected path (traversal, empty) comes back per-file rather than throwing:
  // one bad path shouldn't cost the whole import. It must not pass silently.
  const rejected = [
    ...viewRefusals.map((r) => r.path),
    ...(result.failed ?? []).map((f) => f.id ?? "(unnamed)"),
  ];
  if (rejected.length) {
    console.warn(
      `[import] ${rejected.length} file(s) rejected:`,
      (result.failed ?? []).map((f) => `${f.id}: ${f.error}`).join(", ")
    );
  }
  // The reason travels too, as a readable `path: reason` line for the user.
  const problems = [
    ...viewRefusals.map((r) => `${r.path}: refused — ${r.why}`),
    ...(result.failed ?? []).map((f) =>
      f.id && !f.error.startsWith(f.id) ? `${f.id}: ${f.error}` : f.error
    ),
  ];
  return { written: result.written ?? 0, rejected, problems, warnings: result.warnings ?? [] };
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

/** What registration reports: documents recorded, readable `path: reason`
 *  lines for any that were not (or only as drafts), and the engine's repairs. */
export type ImportRegistration = { documents: number; problems: string[]; warnings: string[] };

export async function registerImportedDocuments(
  nestId: string,
  userEmail: string,
  /** Caller attribution for the import (§9.4) — recorded on every version row
   *  this registration seeds, so a folder an agent imported says so. */
  client?: ClientMetadata,
): Promise<ImportRegistration> {
  return withIoStats(nestId, "register", () => registerImportedDocumentsInner(nestId, userEmail, client));
}

async function registerImportedDocumentsInner(
  nestId: string,
  userEmail: string,
  client?: ClientMetadata,
): Promise<ImportRegistration> {
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
    throw err;
  }

  const docs = result.documents ?? [];
  const engineMs = Date.now() - startedAt;
  const dbStartedAt = Date.now();

  // A document the engine could not publish (an imported version chain that no
  // longer reconstructs) still registers — as a draft, at its own version, with
  // its history left untouched on disk. Losing the doc would be the worse loss.
  // Batched: one multi-row statement per table, not a few queries per document.
  // One transaction: a retry skips docs that already have a version row, so a
  // half-written batch would leave them unapproved for good.
  const tagged = docs.map((d) => ({ d, tags: d.tags.map((t) => storedTag(String(t))) }));
  const record = (rows: typeof tagged) => getDb().transaction(async (tx) => {
    await versions.createVersions(
      rows.map(({ d, tags }) => ({
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
        client,
      })),
      tx
    );
    await versions.setApprovedVersions(
      nestId,
      rows.filter(({ d }) => d.status === "published").map(({ d }) => ({ nodeId: d.id, version: d.version })),
      userEmail,
      tx
    );
    await syncNodeTagsMany(nestId, rows.map(({ d, tags }) => ({ nodeId: d.id, tags })), tx);
  });
  // One bad row must not sink the batch: on failure, record one document at a
  // time so the rest land and each refused one is named with its reason.
  const problems: string[] = [];
  let recorded = tagged;
  try {
    await record(tagged);
  } catch (err) {
    console.warn("[import] batch record failed, isolating documents", nestId, err);
    recorded = [];
    for (const row of tagged) {
      try {
        await record([row]);
        recorded.push(row);
      } catch (e) {
        problems.push(`${row.d.id}: not imported — ${(e as Error)?.message ?? String(e)}`);
      }
    }
  }
  // Only a failed publish can leave `published` on disk; the engine already
  // stamped every held document, so checking those too cost a read each.
  const failedIds = new Set(result.failed.map((f) => f.id));
  const kept = recorded.map(({ d }) => d);
  await Promise.all(
    kept
      .filter((d) => d.status !== "published" && failedIds.has(d.id))
      .map((d) => alignOnDiskStatus(nestId, d.id, d.status))
  );

  const published = kept.filter((d) => d.status === "published").length;
  // Phase split — a slow import is almost always one phase, and the total alone
  // doesn't say which.
  console.log(
    `[import] register done: registered=${kept.length} published=${published} kept=${
      kept.length - published
    } failed=${result.failed.length} alreadyTracked=${tracked.size}` +
      ` engineMs=${engineMs} dbMs=${Date.now() - dbStartedAt}`
  );
  if (result.failed.length) {
    console.warn(
      "[import] documents that would not publish:",
      result.failed.map((f) => `${f.id}: ${f.error}`).join(", ")
    );
  }
  await trackEvent("nest.import.documents", { nestId, registered: kept.length });
  const recordedIds = new Set(kept.map((d) => d.id));
  for (const f of result.failed) {
    if (f.id && recordedIds.has(f.id)) problems.push(`${f.id}: kept as a draft — ${f.error}`);
  }
  return { documents: kept.length, problems, warnings: result.warnings ?? [] };
}

/**
 * Stage a new PDF on an existing pdf node as an unpublished working copy:
 * the engine archives the prior binary, writes the new sidecar and replaces
 * the body with the new extraction. It is deliberately NOT the publish — the
 * caller then runs the very same `context_update` a text edit runs (draft with
 * the assigned version, or publish with the audit note), so a PDF version is
 * governed, numbered and sealed exactly like any other edit.
 *
 * That makes a replace two engine writes where a text edit is one, so the
 * stage hands back `rollback`: it puts the node's previous file and sidecar
 * back, byte for byte, for the caller to run when the second write fails —
 * otherwise the working copy would show a PDF no version row records. The
 * archived copy of the prior binary the engine made is content-addressed and
 * harmless to leave.
 *
 * `unchanged` means the bytes are the node's current PDF: nothing was written.
 */
async function stagePdfImport(
  nestId: string,
  nodeId: string,
  pdf: PdfUpload,
  userEmail: string,
  client: ClientMetadata | undefined,
  priorRaw: string,
): Promise<{ unchanged: boolean; rollback: () => Promise<void> }> {
  const { storage } = await engineCache.get(nestId);
  const sidecar = pdfSidecarPath(nodeId);
  let priorSidecar: Buffer | null = null;
  try {
    priorSidecar = await storage.readVaultBinary(sidecar);
  } catch {
    // Nothing (readable) there — nothing to put back.
  }
  const sealedBefore = await storage.maxRecordedVersion(nodeId);
  const rollback = async () => {
    // A write that sealed a version before failing (say, at the checkpoint)
    // is history now: the chain vouches for the new PDF, so it stays.
    if ((await storage.maxRecordedVersion(nodeId).catch(() => sealedBefore)) > sealedBefore) {
      return;
    }
    try {
      await storage.writeDocument(nodeId, priorRaw);
      if (priorSidecar) await storage.writeVaultBinary(sidecar, priorSidecar);
      await storage.regenerateIndex();
    } catch (err) {
      console.error("[pdf] could not roll back a failed PDF replace", nestId, nodeId, err);
    }
  };
  try {
    const result = await engineApi.run<{ unchanged?: boolean }>(
      "context_import_pdf",
      {
        id: nodeId,
        bytes_base64: Buffer.from(pdf.bytes).toString("base64"),
        ...(pdf.filename ? { filename: pdf.filename } : {}),
        publish: false,
        ...(client ? { client } : {}),
      },
      await opContext(nestId, userEmail),
    );
    return { unchanged: result.unchanged === true, rollback };
  } catch (err) {
    throw pdfEngineError(err);
  }
}

/** Longest frontmatter description accepted — a summary, not a second body. */
export const MAX_DESCRIPTION_LENGTH = 500;

/** A trimmed, single-line description, or a ValidationError saying why not. */
function normalizeDescription(value: unknown): string {
  if (typeof value !== "string") throw new ValidationError("description must be a string");
  const description = value.trim();
  if (/[\r\n]/.test(description)) throw new ValidationError("description must be a single line");
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new ValidationError(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return description;
}

export async function updateNode(
  nestId: string,
  nodeId: string,
  patch: UpdateNodePatch,
  userEmail: string,
  opts: WriteOptions = {},
): Promise<NodeMutationResult> {
  return withNodeWriteLock(nodeWriteKey(nestId, nodeId), async () => {
    try {
      await assertHead(nestId, nodeId, opts.expectHead);
      const { storage, versions: versionManager } = await engineCache.get(
        nestId
      );

      let node: ContextNode;
      try {
        node = await storage.readDocument(nodeId);
      } catch {
        throw new NotFoundError(`Node not found: ${nodeId}`);
      }
      // The exact stored bytes, for undoing a PDF replace whose second write
      // fails (see stagePdfImport).
      const priorRaw = node.rawContent;
      // Set once a PDF replace has staged its new binary + text.
      let pdfRollback: (() => Promise<void>) | null = null;
      // A stored type this server no longer accepts fails engine validation
      // on ANY write (content, append, tags, status, revert, the MCP
      // context_update — all land here). Unless this patch re-types the node,
      // refuse now with a message that says so, instead of the opaque 500 the
      // engine fault used to become. A patch WITH a different type is gated
      // below by assertAcceptedType like any other convert; one that echoes
      // the stored type back is not a re-type, so it is refused here too.
      if (patch.type === undefined || patch.type === node.frontmatter.type) {
        assertUpdatableType(node.frontmatter.type);
      }
      // A pdf node's body is the text the engine extracted from its binary;
      // editing it by hand would leave the two disagreeing under one version.
      // It changes only by uploading a new PDF (patch.pdf). An echo of the
      // stored body is not an edit — the editor sends content with every
      // save — so it is dropped rather than refused.
      const storedType = node.frontmatter.type || "document";
      const isPdfNode = storedType === PDF_NODE_TYPE;
      if (patch.pdf && !isPdfNode) {
        throw new ValidationError(
          `${nodeId} is a "${storedType}" node, not a PDF — a PDF can only replace the PDF of a pdf node.`,
        );
      }
      if (patch.type !== undefined && patch.type !== storedType) {
        if (isPdfNode || patch.type === PDF_NODE_TYPE) {
          throw new ValidationError(
            isPdfNode
              ? "A PDF document can't be converted to another type — its body is the text of its PDF."
              : `A document can't be converted to a PDF — ${PDF_UPLOAD_HINT}.`,
          );
        }
      }
      if (isPdfNode) {
        const readOnly =
          "This is a PDF document: its text is extracted from the PDF and can't be edited directly. " +
          "Upload a new version of the PDF (Replace PDF) to change it.";
        if (patch.append) throw new ConflictError(readOnly);
        if (patch.content !== undefined) {
          if (patch.content.trim() !== (node.body || "").trim()) {
            throw new ConflictError(readOnly);
          }
          patch = { ...patch, content: undefined };
        }
      }
      // Kept for the mention fan-out at the end: only names this save ADDS
      // notify, so the same @name surviving many saves is one event.
      const previousBody = node.body || "";
      // For the board's moved_at stamp: a tag change is a column change.
      const priorTags = [...((node.frontmatter.tags || []) as string[])];
      const priorAssignee = taskFieldsOf(node.frontmatter.metadata).assignee ?? null;

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
        // after reopen). MCP context_update replaces too, per the engine
        // catalog; a caller wanting to add a tag sends the full set.
        const nextTags = requireTags(patch.tags);
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
      if (patch.description !== undefined) {
        const description = normalizeDescription(patch.description);
        if (description !== (node.frontmatter.description ?? "")) {
          const frontmatter: Record<string, unknown> = { ...node.frontmatter };
          if (description) frontmatter.description = description;
          else delete frontmatter.description;
          node = { ...node, frontmatter: frontmatter as any };
          // The engine stores it; an empty string removes the key.
          opInput.description = description;
        }
      }
      // Re-type BEFORE the schedule gate below, so "turn this document into
      // an agent and schedule it" is one call — the gate reads the type the
      // node is becoming, as create does.
      if (patch.type !== undefined && patch.type !== node.frontmatter.type) {
        assertAcceptedType(patch.type);
        if (patch.type === "view") await assertNoViewCollision(storage, nodeId, "view");
        // A skill node is invalid without a skill block and this surface has
        // no field for one — default the trigger from the title, as create
        // does. The engine requires the block in the same call as the re-type.
        if (patch.type === "skill") {
          opInput.trigger = `when asked to ${String(node.frontmatter.title || nodeId).toLowerCase()}`;
        }
        // A schedule only means something on a runnable node; converting
        // away from one would otherwise leave an orphan the scheduler ignores.
        if (isRunnableType(node.frontmatter.type) && !isRunnableType(patch.type)) {
          const metadata = { ...(node.frontmatter.metadata as any) };
          delete metadata.schedule;
          delete metadata.model;
          node = { ...node, frontmatter: { ...node.frontmatter, metadata } };
          opInput.metadata = { ...(opInput.metadata as object), schedule: null, model: null };
        }
        node = { ...node, frontmatter: { ...node.frontmatter, type: patch.type as any } };
        opInput.type = patch.type;
      }
      if (patch.view !== undefined) {
        // Validated against the type the node is becoming, as create does.
        assertViewBlock(patch.view, String(node.frontmatter.type || "document"));
        node = { ...node, frontmatter: { ...node.frontmatter, view: patch.view as any } };
        opInput.view = patch.view;
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
      if (patch.model !== undefined) {
        assertModelId(patch.model);
        if (!isRunnableType(node.frontmatter.type)) {
          throw new ValidationError(
            `model is only valid for runnable node types (${RUNNABLE_NODE_TYPES.join(", ")})`
          );
        }
        const metadata = { ...(node.frontmatter.metadata as any) };
        if (patch.model === "") delete metadata.model;
        else metadata.model = patch.model;
        node = { ...node, frontmatter: { ...node.frontmatter, metadata } };
        opInput.metadata = {
          ...(opInput.metadata as object),
          model: patch.model === "" ? null : patch.model,
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
      if (patch.alwaysInclude !== undefined) {
        if (patch.alwaysInclude !== null && typeof patch.alwaysInclude !== "boolean") {
          throw new ValidationError("always_include must be true, false or null");
        }
        await assertMayFlagPrime(nestId, userEmail, "always-include flag");
        const metadata = { ...(node.frontmatter.metadata as any) };
        if (patch.alwaysInclude === null) delete metadata.always_include;
        else metadata.always_include = patch.alwaysInclude;
        node = { ...node, frontmatter: { ...node.frontmatter, metadata } };
        opInput.metadata = {
          ...(opInput.metadata as object),
          always_include: patch.alwaysInclude,
        };
      }
      if (patch.original) {
        const files = { original: patch.original, previous_originals: patch.previousOriginals ?? [] };
        node = { ...node, frontmatter: { ...node.frontmatter, metadata: { ...(node.frontmatter.metadata as any), ...files } } };
        opInput.metadata = { ...(opInput.metadata as object), ...files };
      }
      if (hasTaskFieldsPatch(patch)) {
        const { metadata, opMetadata } = await applyTaskFields(
          { ...((node.frontmatter.metadata as Record<string, unknown>) ?? {}) },
          patch,
          taskFieldsContext(nestId, storage, nodeId),
        );
        node = { ...node, frontmatter: { ...node.frontmatter, metadata: metadata as any } };
        opInput.metadata = { ...(opInput.metadata as object), ...opMetadata };
      }
      // Custom fields — after the re-type above, so they validate against
      // the type the node is becoming. The whole next map is handed to the
      // engine (its metadata merge is shallow), or null when it empties.
      let fieldDefs: FieldDefinition[] | null = null;
      if (patch.fields !== undefined) {
        fieldDefs = await listFieldDefinitions(nestId);
        const current = storedFieldsOf(node.frontmatter.metadata);
        const { fields, changed } = await applyFieldsPatch({
          defs: fieldDefs,
          nodeType: node.frontmatter.type || "document",
          current,
          patch: patch.fields,
          isCreate: false,
          roster: taskFieldsContext(nestId, storage, nodeId).roster,
        });
        if (changed) {
          const empty = Object.keys(fields).length === 0;
          const metadata = { ...(node.frontmatter.metadata as any) };
          if (empty) delete metadata.fields;
          else metadata.fields = fields;
          node = { ...node, frontmatter: { ...node.frontmatter, metadata } };
          opInput.metadata = { ...(opInput.metadata as object), fields: empty ? null : fields };
        }
      }
      // A time-in-status field can apply to any type, not just tasks; a node
      // it covers gets the same moved_at stamp a task does.
      const tracksMoves =
        node.frontmatter.type === TASK_NODE_TYPE ||
        (!!patch.tags &&
          (fieldDefs ??= await listFieldDefinitions(nestId)).some(
            (d) => d.type === "time_in_status" && appliesTo(d, node.frontmatter.type),
          ));
      // A task whose tag set changed moved column on a board. Compared as
      // sets: the editor resends the same tags on every save, which isn't a
      // move.
      if (patch.tags && tracksMoves) {
        const norm = (t: unknown) => String(t).toLowerCase().replace(/^#/, "");
        const before = new Set(priorTags.map(norm));
        const after = ((node.frontmatter.tags || []) as string[]).map(norm);
        if (before.size !== after.length || after.some((t) => !before.has(t))) {
          const movedAt = new Date().toISOString();
          // Entering a "done" column completes the task; leaving one reopens it.
          const done = new Set(await nestDoneTags(nestId));
          const wasDone = [...before].some((t) => done.has(t));
          const isDone = after.some((t) => done.has(t));
          const stamps: Record<string, unknown> = { moved_at: movedAt };
          if (isDone && !wasDone) stamps.completed_at = movedAt;
          if (!isDone && wasDone) stamps.completed_at = null;
          const metadata = { ...(node.frontmatter.metadata as any), ...stamps };
          if (stamps.completed_at === null) delete metadata.completed_at;
          node = { ...node, frontmatter: { ...node.frontmatter, metadata } };
          opInput.metadata = { ...(opInput.metadata as object), ...stamps };
        }
      }

      // A fields-only PATCH that changes nothing (a client echoing values
      // back) is not an edit: no version, no review, no hash move.
      const onlyFields = Object.entries(patch).every(
        ([k, v]) => v === undefined || k === "fields" || k === "client" || k === "changeNote",
      );
      if (patch.fields !== undefined && onlyFields && Object.keys(opInput).length === 0) {
        return { node, version: Number(node.frontmatter.version) || 1 };
      }

      const hasStewards = await isStewardshipEnabled(nestId);
      const currentTags = (node.frontmatter.tags || []) as string[];
      // Resolved from the POST-patch tags and metadata — so an edit that adds
      // a prime tag gates itself, and one that clears the doc flag can't
      // un-gate a prime-tagged doc.
      const publishReason = opts.alwaysDraft ? null : await autoPublishReason(nestId, userEmail, {
        tags: currentTags,
        metadata: node.frontmatter.metadata,
        // A task only if it is one before AND after this edit: converting a
        // document into a task, or a task into anything else, is reviewed.
        type: patch.type === undefined || patch.type === storedType ? storedType : undefined,
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
      // A reviewer's approve-with-edits revises the submission the same way.
      const isAuthorEditingOwnReview =
        !!pendingReview &&
        (pendingReview.requestedBy.toLowerCase() === userEmail.toLowerCase() ||
          !!opts.reviewerEdit);
      // The review resolved between the caller's check and this write: the
      // reviewer's edit must not land as an ordinary draft or publish.
      if (opts.reviewerEdit && !pendingReview) {
        throw new ConflictError("The review was resolved before your edit landed — nothing was saved. Reload the document.");
      }
      if (pendingReview && !isAuthorEditingOwnReview) {
        throw new LockedError(
          "This document is awaiting steward review and is locked. Approve or reject the pending review before editing."
        );
      }

      if (opts.publishOnly && (publishReason === null || isAuthorEditingOwnReview)) {
        throw new ReviewRequiredError(
          isAuthorEditingOwnReview
            ? "This document has your own review open — the change would be a new draft for that review."
            : "This document goes through review — the change would be saved as a draft for a reviewer.",
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
        if (patch.pdf) {
          const staged = await stagePdfImport(
            nestId, nodeId, patch.pdf, userEmail, patch.client, priorRaw,
          );
          if (staged.unchanged && Object.keys(opInput).length === 0) {
            return { node, version: node.frontmatter.version || currentVersion || 1 };
          }
          if (!staged.unchanged) pdfRollback = staged.rollback;
        }
        // The engine owns the write: it applies the patch, validates, stamps the
        // version we assigned and drops the stale published-state checksum, then
        // regenerates the index. `publish: false` because this revision has not
        // cleared review — governance below records it as a draft.
        try {
          await engineApi.run(
            "context_update",
            { id: nodeId, ...opInput, publish: false, version: newVersion },
            await opContext(nestId, userEmail),
          );
        } catch (err) {
          if (pdfRollback) await pdfRollback();
          throw err;
        }
        node = await storage.readDocument(nodeId);
        await syncNodeTags(nestId, nodeId, currentTags);

        // A draft revision is NOT appended to the engine's history chain. That
        // chain is append-only and hash-linked, so anything recorded in it can
        // never be taken back — which is exactly why drafts used to be
        // impossible to throw away, and why a drafting session left a keyframe
        // or diff on disk per save. Unreviewed work now lives in the file (the
        // working copy) plus the governance row below; only submitting or
        // publishing seals a version. discardDraft is the other half.
        //
        // Only the newest draft row is kept: with no chain entry behind it, a
        // superseded row describes bytes nothing can reconstruct.
        await versions.deleteSupersededDrafts(nestId, nodeId, newVersion);
        await versions.createVersion({
          nestId,
          nodeId,
          version: newVersion,
          content: node.body || "",
          author: userEmail,
          status: "draft",
          tags: currentTags,
          changeNote: patch.changeNote,
          client: patch.client,
        });
        // Author revised their own pending submission: move the open review
        // onto this fresh version so the steward approves the edited content.
        if (isAuthorEditingOwnReview) {
          await repointPendingReview({ nestId, nodeId, newVersion });
        }
        // The working file keeps the last published frontmatter status; the
        // version row just written is what GET reports, so say "draft" here too
        // (the reply used to claim "published" for an edit awaiting review).
        node = { ...node, frontmatter: { ...node.frontmatter, status: "draft" } };
        responseVersion = newVersion;
      } else {
        // Publish through the engine FIRST; only mirror into the DB once it
        // actually landed. Rethrow on failure — swallowing here is what let
        // node_versions climb past what history.yaml stored (DB v19 vs v15).
        const publishNote =
          patch.changeNote || `Auto-published on edit (${publishReason})`;
        let publishedVersion: number;
        if (patch.pdf) {
          const staged = await stagePdfImport(
            nestId, nodeId, patch.pdf, userEmail, patch.client, priorRaw,
          );
          if (staged.unchanged && Object.keys(opInput).length === 0) {
            return { node, version: node.frontmatter.version || 1 };
          }
          if (!staged.unchanged) pdfRollback = staged.rollback;
        }
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
          if (pdfRollback) await pdfRollback();
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
          client: patch.client,
        });
        await versions.setApprovedVersion(
          nestId,
          nodeId,
          publishedVersion,
          userEmail
        );
        responseVersion = publishedVersion;
      }

      const nextAssignee = taskFieldsOf(node.frontmatter.metadata).assignee ?? null;
      // Only a published edit notifies: a drafted assignment may be rejected.
      // Approving that draft later doesn't notify either (known gap).
      const savedAsDraft = publishReason === null || isAuthorEditingOwnReview;
      if (nextAssignee && nextAssignee !== priorAssignee && !savedAsDraft) {
        await notifyAssigned({
          nestId,
          nodeId,
          title: String(node.frontmatter.title || nodeId),
          assignee: nextAssignee,
          actorEmail: userEmail,
        });
      }
      // Awaited, like the other inbox fan-outs: it swallows its own failures,
      // and a local insert is cheaper than a save that returns before it lands.
      if (opts.notifyMentions !== false) {
        await notifyMentions({
          nestId,
          nodeId,
          previousBody,
          nextBody: node.body || "",
          actorEmail: userEmail,
        });
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
  action: "moving" | "deleting" | "discarding",
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
  ["node_index", "node_id"],
  ["node_suggestions", "node_id"],
  ["watchers", "node_id"],
  ["schedules", "agent_node"],
  // A live capability token bound to one agent node — deleting the agent must
  // revoke it, or a later node at that id answers the old webhook.
  ["trigger_hooks", "agent_node"],
  // A live public link pinned to one node. Deleting the document must kill the
  // link, and moving it must carry the link along — otherwise /p/<slug> serves
  // whatever node next takes that id.
  ["publish", "node_id"],
  ["edges", "from_node"],
  ["edges", "to_node"],
  // Who read / pulled the document (CU-wdqcq03aw2). Moves carry it along;
  // a delete purges it with the rest of the document's history, so a later
  // document at the same id never inherits someone else's reads. The
  // deletion tombstone and whole-nest export rows (node_id NULL) survive.
  ["node_access_events", "node_id"],
  // A metacognition agent's config (CU-wdqcq041jm): it runs the agent node, so
  // a delete must stop it and a move must take it along.
  ["metacognition_agents", "node_id"],
  // Agent/person interactions logged on a task (migration 064).
  ["task_activity", "node_id"],
  // Document pins (CU-wdqcq02crw, migration 071) — editorial and personal. A
  // delete takes them with it (no pin on a document that is gone, or on the
  // next one to take its id); a move carries them along.
  ["node_pins", "node_id"],
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
  // A request for access to this document asks about something that no longer
  // exists; a later document at the same id must not inherit it.
  await tx.run(
    `DELETE FROM access_requests
     WHERE nest_id = ? AND target_type = 'node' AND target_id = ?`,
    [nestId, nodeId],
  );
  // Public docs-site URLs (CU-wdqcq05jhm) outlive the document on purpose: its
  // old addresses answer 410 Gone, which tells search engines to drop them.
  // The row is detached from the id, so a later document there inherits none.
  await tx.run(
    `UPDATE site_paths SET node_id = '', kind = 'history' WHERE nest_id = ? AND node_id = ?`,
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
  // Pins are the one node-keyed table with a uniqueness rule on the id
  // (migration 071's partial unique indexes). The destination is not a live
  // document, so any pin row already on it is stale (its document vanished
  // outside the app) — clear it, or the repoint trips the index and the move
  // fails.
  await tx.run("DELETE FROM node_pins WHERE nest_id = ? AND node_id = ?", [nestId, newId]);
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
  await tx.run(
    `UPDATE access_requests SET target_id = ?
     WHERE nest_id = ? AND target_type = 'node' AND target_id = ?`,
    [newId, nestId, oldId],
  );
  // The page's public URLs move with it: its custom URL stays its own, and
  // every address it was served at 301s to wherever it lands now.
  await tx.run(`UPDATE site_paths SET node_id = ? WHERE nest_id = ? AND node_id = ?`, [newId, nestId, oldId]);
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

  // A pdf node's binary is bound to its id (`<id>.pdf`, its archived versions
  // under the id's .versions/), and a move rewrites the id without carrying
  // either — the moved node would name a sidecar that is not there and the
  // delete of the old id would take the binary with it. Refuse until the
  // engine can relocate a pdf node as one unit.
  if (node.frontmatter.type === PDF_NODE_TYPE) {
    throw new ValidationError(
      "PDF documents can't be moved to another folder yet. Upload the PDF again in the destination folder instead.",
    );
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
    await assertNoViewCollision(
      storage,
      newId,
      String(node.frontmatter.type || "document"),
      new Set([nodeId]),
    );

    const moved: ContextNode = {
      ...node,
      id: newId,
      frontmatter: {
        ...node.frontmatter,
        updated_at: new Date().toISOString(),
      },
    };
    // Under enforced rules a move is judged as a delete there and a create
    // here — before anything is written.
    const plan = await assertMovable(storage, nodeId, newId, moved);
    // serializeNodeSafe, not serializeDocument: `moved` came from
    // readDocument, so an empty `tags: []` on disk is back as
    // `tags: undefined` and the YAML dumper throws on it. Only published docs
    // are already clean (approve rewrites them through serializeNodeSafe),
    // which is why drafts and pending-review docs were the ones failing.
    // No document at the destination (checked above), so any rows there are
    // orphans — same as create, clear them or the repoint trips UNIQUE. Before
    // the write: its index write-through creates fresh rows at newId.
    await getDb().transaction(async (tx) => {
      await purgeNodeKeyedRows(tx, nestId, newId);
      await purgeNodeKeyedRows(tx, nestId, derivedIdOf(newId));
    });
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
    await scaffold(storage, plan);

    // Repoint every node-keyed table for the source doc and its derived
    // annotations node, plus the run traces delete keeps. One transaction: a
    // half-moved node would be worse than a failed move.
    //
    // rewriteNodeKeyedRows only moves the keyed column, so it does NOT
    // recompute node_index.folder. That is fine for both rows here:
    //   - the source doc has no node_index row left to rewrite — its write to
    //     newId and its delete of nodeId both ran above, each folding through
    //     the index write-through, so this is a no-op on an already-correct row;
    //   - the derived annotations row is repointed with its pre-move folder,
    //     then replaced outright a few lines below when its document is written
    //     at newDerived, which recomputes the folder. Stale only within this
    //     transaction, and never on a path that serves a read.
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

    // Regenerate the derived vault files. A move writes and deletes through raw
    // storage rather than the operation catalog, so unlike create/update/
    // publish/delete nothing here refreshed them — the SOURCE folder's INDEX.md
    // kept listing a document that had left, the DESTINATION's never learned it
    // arrived, and context.yaml (which graph-mode reads seed from) stayed on the
    // old id until some unrelated write in the nest happened to trigger a regen.
    //
    // Best-effort: the move itself is already committed to disk and to the
    // index, and derived files are regenerated from that truth. Failing the
    // whole move because a generated file could not be rewritten would be the
    // worse outcome; the next mutation, or a reindex, restores them.
    try {
      await storage.regenerateIndex();
    } catch (err) {
      console.error("[move] regenerateIndex failed", nestId, nodeId, newId, err);
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
/**
 * Throw away the unreviewed work on a node and put the file back to its last
 * sealed version.
 *
 * This is the other half of drafts staying out of the hash chain (see the draft
 * branch of updateNode): nothing was appended, so nothing has to be unwound —
 * restoring is a plain write of bytes the chain still holds, and the governance
 * rows above the seal are simply dropped. `ctx verify` is unaffected either way.
 *
 * A node that was never published has no earlier state to fall back to, so
 * discarding its draft means deleting the document — the same thing the "…" →
 * Delete menu already did, one step instead of two.
 */
export async function discardDraft(
  nestId: string,
  nodeId: string,
  userEmail: string,
  opts: Pick<WriteOptions, "expectHead"> = {},
): Promise<{ deleted: boolean; version: number | null; warning?: string }> {
  return withNodeWriteLock(nodeWriteKey(nestId, nodeId), async () => {
    await assertHead(nestId, nodeId, opts.expectHead);
    await assertNotReviewLocked(nestId, nodeId, userEmail, "discarding");

    const sealed = await versions.getSealedVersion(nestId, nodeId);
    if (sealed == null) {
      await deleteNode(nestId, nodeId, userEmail);
      return { deleted: true, version: null };
    }

    const { storage, versions: versionManager } = await engineCache.get(nestId);
    let raw: string;
    try {
      raw = await versionManager.reconstructVersion(nodeId, sealed);
    } catch (err) {
      console.error(
        "reconstructVersion failed (discard draft)",
        nestId,
        nodeId,
        sealed,
        err,
      );
      throw new ValidationError(
        `Can't restore version ${sealed} of this document — its history no longer replays. Delete the document instead.`,
      );
    }

    // Written back verbatim rather than patched through context_update: the
    // reconstructed bytes carry the checksum they were published with, so the
    // file matches its own frontmatter again and the drift scanner stays quiet.
    // Same move rejectSuggestion makes, and for the same reason — a discard
    // must not cost a version.
    await storage.writeDocument(nodeId, raw);
    await storage.regenerateIndex();

    // Tags travel in frontmatter, so a draft that added or removed one has to
    // be undone in the tag index too — steward resolution reads it.
    const restored = parseDocument(`${nodeId}.md`, raw, nodeId);
    // A pdf node's draft also replaced the binary beside it. The restored
    // frontmatter names the sealed version's bytes; put them back as the live
    // sidecar (the engine resolves them from the archive and verifies the
    // hash), so the file and its binary agree again.
    let warning: string | undefined;
    if (restored.frontmatter.type === PDF_NODE_TYPE) {
      try {
        const bytes = await readPdfBinary(storage as NestStorage, nodeId);
        await storage.writeVaultBinary(pdfSidecarPath(nodeId), bytes);
      } catch (err) {
        // The text is back; the binary could not be. Reads stay safe (the
        // served PDF is hash-verified, so a mismatch is refused, not served),
        // but the caller should hear it now rather than from a later 500.
        console.error("[pdf] could not restore the sealed binary on discard", nestId, nodeId, err);
        warning =
          `The draft was discarded, but the PDF of version ${sealed} could not be restored ` +
          "(its archived copy is missing or no longer matches). Upload the PDF again, or ask an admin to verify the nest.";
      }
    }
    await syncNodeTags(
      nestId,
      nodeId,
      ((restored.frontmatter.tags as string[]) || []).map(storedTag),
    );

    await versions.deleteUnsealedVersions(nestId, nodeId, sealed);
    await trackEvent("node.discard_draft", { nestId, nodeId, version: sealed });
    return { deleted: false, version: sealed, ...(warning ? { warning } : {}) };
  });
}

/**
 * Restore an old version by writing its reconstructed content as a NEW version
 * through updateNode — history is append-only, nothing is lost, and the write
 * takes the same governance path any edit does (review lock, draft vs publish).
 * Shared by POST …/revert and the agent-activity undo.
 *
 * A pdf node's body can't be written back as text — it is whatever its PDF
 * extracts to. Restoring a pdf version re-imports that version's binary
 * (resolved from the archive and hash-verified by the engine), which brings
 * its text back with it.
 */
export async function restoreVersion(
  nestId: string,
  nodeId: string,
  targetVersion: number,
  userEmail: string,
  opts: { client?: ClientMetadata; changeNote?: string; expectHead?: number } = {},
): Promise<NodeMutationResult> {
  const { storage, versions: versionManager } = await engineCache.get(nestId);
  let raw: string;
  try {
    raw = await versionManager.reconstructVersion(nodeId, targetVersion);
  } catch {
    throw new NotFoundError(`Version ${targetVersion} not found for ${nodeId}`);
  }
  let pdfMeta: unknown;
  try {
    pdfMeta = parseDocument(`${nodeId}.md`, raw, nodeId).frontmatter.pdf;
  } catch {
    pdfMeta = undefined;
  }
  let restoredPdf: Buffer | null = null;
  if (pdfMeta) {
    try {
      restoredPdf = await readPdfBinary(storage as unknown as NestStorage, nodeId, {
        version: targetVersion,
      });
    } catch (err) {
      console.error("[pdf] restore could not read the version's binary", nestId, nodeId, targetVersion, err);
      throw new NotFoundError(`The PDF of version ${targetVersion} is not available to restore.`);
    }
  }
  return updateNode(
    nestId,
    nodeId,
    {
      ...(restoredPdf ? { pdf: { bytes: new Uint8Array(restoredPdf) } } : { content: bodyOnly(nodeId, raw) }),
      changeNote: opts.changeNote ?? `Restored from version ${targetVersion}`,
      client: opts.client,
    },
    userEmail,
    { expectHead: opts.expectHead },
  );
}

/**
 * deleteNode, refused if the node's head moved past `expectHead`. deleteNode
 * takes no lock of its own (discardDraft calls it from inside one), so this
 * holds the node's write lock across the check and the delete — a delete
 * purges history, so it must never land on a change the caller didn't see.
 */
export async function deleteNodeIfUnchanged(
  nestId: string,
  nodeId: string,
  userEmail: string,
  expectHead: number,
  opts: { client?: ClientMetadata } = {},
): Promise<void> {
  return withNodeWriteLock(nodeWriteKey(nestId, nodeId), async () => {
    await assertHead(nestId, nodeId, expectHead);
    await deleteNode(nestId, nodeId, userEmail, opts);
  });
}

export async function deleteNode(
  nestId: string,
  nodeId: string,
  userEmail: string,
  opts: {
    /** Caller attribution (§9.4) for the tombstone — the one record a delete
     *  leaves, so it is where "which agent deleted this" has to live. */
    client?: ClientMetadata;
  } = {},
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
  } catch (err) {
    // A structure rule refusing the delete (a required file) is not "missing".
    throw ruleRefusal(err) ?? new NotFoundError(`Node not found: ${nodeId}`);
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
      `INSERT INTO node_deletions (nest_id, node_id, deleted_by, deleted_at, client_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(nest_id, node_id) DO UPDATE
         SET deleted_by = excluded.deleted_by, deleted_at = excluded.deleted_at,
             client_json = excluded.client_json`,
      [nestId, nodeId, userEmail, new Date().toISOString(), serializeClient(opts.client)],
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
  // A required folder is not deleted alone; the rest go deepest first, each
  // folder's required files last (see folderDeleteOrder).
  const targets = await folderDeleteOrder(
    storage,
    rel,
    docs.map((d) => d.id).filter((id) => isIdUnderFolder(id, rel)),
  );
  if (targets.length === 0) {
    // A folder holding no document is still a directory in the vault (an
    // explicitly created one, or the remains of a folder whose documents have
    // all gone), so deleting it is removing that directory.
    if (await removeVaultFolder(nestId, rel)) return [];
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
  // The documents are gone but the directory (and its generated INDEX.md) is
  // not — and a directory is a folder now, so leaving it would keep the folder
  // in the tree after the user deleted it.
  await removeVaultFolder(nestId, rel);
  return deleted;
}

/**
 * Rename or move a folder: everything under `folder` (sub-folders included,
 * empty ones too) lands under `newFolder`. A rename is a move to a path with
 * the same parent, so there is one operation. Each document goes through
 * moveNode, which keeps ids' history, review state and links, enforces the
 * structure rules, and refuses a document under open review. Returns the old
 * and new id of every document moved.
 */
export async function moveFolder(
  nestId: string,
  folder: string,
  newFolder: string,
  userEmail: string,
): Promise<{ folder: string; moved: Array<{ id: string; previousId: string }> }> {
  const from = folderToSegments(folder).join("/");
  const to = folderToSegments(newFolder).join("/");
  if (!from || !to) throw new ValidationError("folder and new folder are required");
  if (from === to) return { folder: to, moved: [] };
  if (to.startsWith(`${from}/`)) {
    throw new ValidationError("A folder can't be moved into itself.");
  }

  const { storage } = await engineCache.get(nestId);
  const all = (await storage.discoverDocuments()).map((d) => d.id);
  const inside = all.filter((id) => isIdUnderFolder(id, from) && !isDerivedAnnotationsNode(id));
  const subfolders = [
    from,
    ...(await vaultFolderPaths(nestId, { folder: from })).filter((p) => p.startsWith(`${from}/`)),
  ];
  if (inside.length === 0 && !(await vaultFolderExists(nestId, from))) {
    throw new NotFoundError(`No folder found: ${folder}`);
  }
  if (await vaultFolderExists(nestId, to)) {
    // Merging into a folder that is there would be a silent, partial overwrite
    // of its INDEX and rules; say so instead.
    throw new ConflictError(`A folder already exists at "${to}"`);
  }
  const targets = await assertFolderMovable(storage, from, to, inside);

  const destOf = (id: string) => `${to}${folderOfId(id).slice(from.length)}`;
  const taken = new Set(all);
  const clash = targets.find((id) => taken.has(`nodes/${destOf(id)}/${id.split("/").pop()}`));
  if (clash) throw new ConflictError(`A document already exists where "${clash}" would go.`);
  // View addresses (see views/collision.ts), checked for every node BEFORE
  // the first one moves, so a refusal never leaves the folder half-moved.
  {
    const leaving = new Set(targets);
    for (const id of targets) {
      const doc = await storage.readDocument(id);
      await assertNoViewCollision(
        storage,
        `nodes/${destOf(id)}/${id.split("/").pop()}`,
        String(doc.frontmatter.type || "document"),
        leaving,
      );
    }
  }

  // Sequential, like deleteFolder: a failure names how far it got, and what
  // moved stays coherent (each move is atomic).
  const moved: Array<{ id: string; previousId: string }> = [];
  for (const id of targets) {
    try {
      const r = await moveNode(nestId, id, destOf(id), userEmail);
      moved.push({ id: r.node.id, previousId: r.previousId });
    } catch (err) {
      const detail = moved.length > 0 ? ` (${moved.length} of ${targets.length} already moved)` : "";
      throw new Error(`Failed to move "${id}"${detail}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // Folders that held no document have nothing to carry them: recreate each at
  // the new path, then drop the old directory tree.
  for (const sub of subfolders) {
    await createEmptyFolder(nestId, `${to}${sub.slice(from.length)}`);
  }
  await removeVaultFolder(nestId, from);
  await trackEvent("folder.move", { nestId, from, to });
  return { folder: to, moved };
}

/**
 * A folder's directory in the vault. `rel` is community-dialect and always
 * slugified segments, so it cannot climb out of the nest.
 */
async function vaultFolderDir(nestId: string, rel: string): Promise<string> {
  const prefix = await storagePrefix(nestId);
  return join(
    resolveNestPath(nestId),
    ...(prefix ? [prefix] : []),
    ...rel.split("/"),
  );
}

/** Is this folder already a directory in the vault? */
export async function vaultFolderExists(nestId: string, rel: string): Promise<boolean> {
  if (!rel) return false;
  assertSafeFolder(rel);
  try {
    return (await stat(await vaultFolderDir(nestId, rel))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Remove a folder's directory from the vault. Returns false when there was no
 * such directory.
 */
async function removeVaultFolder(nestId: string, rel: string): Promise<boolean> {
  if (!(await vaultFolderExists(nestId, rel))) return false;
  await rm(await vaultFolderDir(nestId, rel), { recursive: true, force: true });
  return true;
}
