/**
 * §1.12 view serving — the pure core.
 *
 * A `view` node is a layout (engine `ViewMeta`, validated upstream by
 * `viewMetaSchema`); serving one means resolving its blocks for ONE reader.
 * This module owns the rules of that resolution and of the `nest-data` JSON
 * handed to an html block's frame: visibility per principal set, caps,
 * escaping, errors as data, and the trust rule that decides whose access
 * bounds the data. It does no I/O of its own — every vault, ACL and history
 * read goes through `ViewDeps` (wired in deps.ts) — so all of it is testable
 * without HTTP or a database.
 *
 * Security posture, in one place:
 *  - A node is visible only when EVERY principal may read it (filterAccessible
 *    semantics, intersected). A denied node and a missing one resolve to the
 *    same `not_found`, so the payload is no existence oracle.
 *  - `decideDataTrust` runs before any ACL call and fails closed: an
 *    unapproved view or artifact, the kill switch, or any author who is not a
 *    real, current member withholds every entry.
 *  - The JSON is escaped so it can never leave its <script> element.
 */
import type { ViewMeta } from "@promptowl/contextnest-engine";
import { VIEW_BLOCK_KINDS } from "@promptowl/contextnest-engine";

/** Caps (spec §2.3). Exported so tests and callers share one set of numbers. */
export const CAPS = {
  MAX_BLOCKS: 50,
  MAX_DATA_FROM: 10,
  MAX_LIST_ITEMS: 200,
  MAX_ROWS: 500,
  MAX_BLOCK_BYTES: 262144,
  MAX_NEST_DATA_BYTES: 1048576,
  /** A `summary` block's `max_nodes` when it sets none. */
  DEFAULT_SUMMARY_NODES: 25,
} as const;

export type Caps = { readonly [K in keyof typeof CAPS]: number };

/** The closed set of error codes a block or nest-data entry can carry. */
export const ERROR_CODES = [
  "not_found",
  "not_published",
  "history_error",
  "unsupported_kind",
  "unsupported_binding",
  "feature_disabled",
  "query_failed",
  "too_large",
  "withheld",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Someone whose read access bounds what a view resolves to. */
export type Principal = { userId: string; email: string; approvedOnly: boolean };

/** One member of a `list` block, before field projection. */
export interface NodeSummary {
  id: string;
  title: string;
  version?: number;
  status?: string;
  tags?: string[];
}

export type TableRows = { columns: string[]; rows: Record<string, unknown>[] };

/** What a `summary` block asks for: `ids` readable by the viewer, sorted. */
export interface SummaryInput {
  ids: string[];
  style: "brief" | "detailed";
  maxNodes: number;
}

export type SummaryResult =
  | { ok: true; text: string; refs: string[]; truncated: boolean }
  | { ok: false; error: ErrorCode };

/** Every read the core needs, injected. deps.ts wires the real ones. */
export interface ViewDeps {
  /** A `ref`/`binding` → the node it names. Path or contextnest:// URI only,
   *  never a title. null when there is no such (non-forgotten) node. */
  resolveRef(nestId: string, ref: string): Promise<{ id: string; type: string } | null>;
  /** The ids EVERY principal in `p` may read (filterAccessible, intersected). */
  visible(nestId: string, ids: string[], p: Principal[]): Promise<Set<string>>;
  /** A node's published body: the approved version, or a pinned `version`
   *  that was itself published when it was cut. */
  readMd(
    nestId: string,
    id: string,
    version?: number,
  ): Promise<{ ok: true; text: string; version: number } | { ok: false; error: ErrorCode }>;
  /** Published nodes matching an engine selector, in selector order,
   *  evaluated over the documents visible to `p`. */
  selectNodes(nestId: string, selector: string, p: Principal[]): Promise<NodeSummary[]>;
  /** A table node's rows (approved rows when `approvedOnly`). */
  tableRows(
    nestId: string,
    id: string,
    approvedOnly: boolean,
    p: Principal[],
  ): Promise<TableRows | { error: ErrorCode }>;
  /** Generate or fetch a summary. Absent: `summary` blocks don't resolve, so
   *  a frame (whose nest-data has no summary entry) never pays for a call. */
  summarize?(nestId: string, input: SummaryInput): Promise<SummaryResult>;
}

interface BlockBase {
  /** Position in the layout. */
  index: number;
  /** The block's own id, or `_b<index>` for one without (never a valid
   *  user id: those must start with a letter). */
  id: string;
  kind: string;
  /** Node ids whose content this block disclosed (md / data / list members).
   *  Server-side only: buildNestData never copies it into nest-data. */
  sources?: string[];
}

export type ResolvedBlock =
  | (BlockBase & { kind: "md"; ok: true; text: string; version?: number })
  | (BlockBase & { kind: "list"; ok: true; items: Record<string, unknown>[]; truncated?: true })
  | (BlockBase & {
      kind: "data";
      ok: true;
      columns: string[];
      rows: Record<string, unknown>[];
      truncated?: true;
    })
  | (BlockBase & { kind: "callout"; ok: true; text: string; tone: "info" | "warning" })
  | (BlockBase & { kind: "html"; ok: true; artifactId: string; dataFrom: string[] })
  | (BlockBase & {
      kind: "summary";
      ok: true;
      /** Always true: model output, labeled as such wherever it is served. */
      generated: true;
      text: string;
      /** `id@version` of each node the text was written from. */
      refs: string[];
      truncated?: true;
    })
  | (BlockBase & { ok: false; error: ErrorCode });

export type NestDataEntry = Record<string, unknown> & { ok: boolean };
export type NestData = Record<string, NestDataEntry>;

type RawBlock = Record<string, unknown> & { id?: unknown };

const KINDS: ReadonlySet<string> = new Set(VIEW_BLOCK_KINDS);
const LIST_FIELDS = ["id", "title", "version", "status", "tags"] as const;

/** The one kind a block declares (engine rule 32), or null. */
export function blockKindOf(block: RawBlock): string | null {
  const keys = Object.keys(block).filter((k) => k !== "id");
  return keys.length === 1 && KINDS.has(keys[0]) ? keys[0] : null;
}

/** The address of a block: its own id, else `_b<index>`. */
export function blockIdOf(block: RawBlock, index: number): string {
  return typeof block.id === "string" && block.id ? block.id : `_b${index}`;
}

/** `data_from` as an ordered, de-duplicated list of block ids. */
export function normalizeDataFrom(v: unknown): string[] {
  const list = typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
  const out: string[] = [];
  for (const x of list) if (typeof x === "string" && x && !out.includes(x)) out.push(x);
  return out;
}

/** The blocks this core serves: the first MAX_BLOCKS of the layout. */
export function servedBlocks(view: ViewMeta, caps: Caps = CAPS): RawBlock[] {
  return ((view?.blocks ?? []) as unknown as RawBlock[]).slice(0, caps.MAX_BLOCKS);
}

/** The block a frame address names, if it is an html block of the layout. */
export function findHtmlBlock(
  view: ViewMeta,
  blockId: string,
  caps: Caps = CAPS,
): { index: number; ref: string; dataFrom: string[] } | null {
  const blocks = servedBlocks(view, caps);
  for (let i = 0; i < blocks.length; i++) {
    if (blockIdOf(blocks[i], i) !== blockId) continue;
    if (blockKindOf(blocks[i]) !== "html") return null;
    const opts = (blocks[i].html ?? {}) as { ref?: unknown; data_from?: unknown };
    if (typeof opts.ref !== "string") return null;
    return { index: i, ref: opts.ref, dataFrom: normalizeDataFrom(opts.data_from) };
  }
  return null;
}

const fail = (base: BlockBase, error: ErrorCode): ResolvedBlock => ({ ...base, ok: false, error });

async function isVisible(deps: ViewDeps, nestId: string, id: string, p: Principal[]) {
  return (await deps.visible(nestId, [id], p)).has(id);
}

/** A ref resolved and visible under `p`, or the not_found every miss shares. */
async function visibleRef(
  deps: ViewDeps,
  nestId: string,
  ref: unknown,
  p: Principal[],
): Promise<{ id: string; type: string } | null> {
  if (typeof ref !== "string" || !ref) return null;
  let target: { id: string; type: string } | null;
  try {
    target = await deps.resolveRef(nestId, ref);
  } catch {
    return null;
  }
  if (!target) return null;
  return (await isVisible(deps, nestId, target.id, p)) ? target : null;
}

/** A selector's members, in selector order, that every principal can see. */
async function selectVisible(
  deps: ViewDeps,
  nestId: string,
  selector: string,
  p: Principal[],
): Promise<NodeSummary[]> {
  const matched = await deps.selectNodes(nestId, selector, p);
  // Belt and braces: whatever selectNodes returned, only members every
  // principal can see survive.
  const seen = await deps.visible(nestId, matched.map((m) => m.id), p);
  return matched.filter((m) => seen.has(m.id));
}

async function resolveOne(
  raw: RawBlock,
  index: number,
  nestId: string,
  p: Principal[],
  deps: ViewDeps,
  caps: Caps,
): Promise<ResolvedBlock> {
  const kind = blockKindOf(raw) ?? "unknown";
  const base: BlockBase = { index, id: blockIdOf(raw, index), kind };
  const opts = (raw[kind] ?? {}) as Record<string, unknown>;
  switch (kind) {
    case "md": {
      const target = await visibleRef(deps, nestId, opts.ref, p);
      if (!target) return fail(base, "not_found");
      const version = typeof opts.version === "number" ? opts.version : undefined;
      try {
        const md = await deps.readMd(nestId, target.id, version);
        if (!md.ok) return fail(base, md.error);
        return { ...base, kind: "md", ok: true, text: md.text, version: md.version, sources: [target.id] };
      } catch {
        return fail(base, "history_error");
      }
    }
    case "list": {
      if (typeof opts.select !== "string") return fail(base, "query_failed");
      const fields = (
        Array.isArray(opts.fields) && opts.fields.length > 0 ? opts.fields : ["id", "title"]
      ).filter((f): f is (typeof LIST_FIELDS)[number] =>
        (LIST_FIELDS as readonly string[]).includes(f as string),
      );
      const limit = Math.min(
        typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : caps.MAX_LIST_ITEMS,
        caps.MAX_LIST_ITEMS,
      );
      let matched: NodeSummary[];
      try {
        matched = await selectVisible(deps, nestId, opts.select, p);
      } catch {
        return fail(base, "query_failed");
      }
      const shown = matched.slice(0, limit);
      const items = shown.map((m) => {
        const item: Record<string, unknown> = {};
        for (const f of fields) {
          const v = f === "tags" ? (m.tags ?? []) : m[f];
          if (v !== undefined) item[f] = v;
        }
        return item;
      });
      return {
        ...base,
        kind: "list",
        ok: true,
        items,
        sources: shown.map((m) => m.id),
        ...(matched.length > limit ? { truncated: true as const } : {}),
      };
    }
    case "summary": {
      if (!deps.summarize) return fail(base, "unsupported_kind");
      if (typeof opts.select !== "string") return fail(base, "query_failed");
      try {
        const nodes = await selectVisible(deps, nestId, opts.select, p);
        const out = await deps.summarize(nestId, {
          // Sorted, so "the first max_nodes" is the same set on every render.
          ids: nodes.map((n) => n.id).sort(),
          style: opts.style === "detailed" ? "detailed" : "brief",
          maxNodes: typeof opts.max_nodes === "number" ? opts.max_nodes : caps.DEFAULT_SUMMARY_NODES,
        });
        if (!out.ok) return fail(base, out.error);
        return {
          ...base,
          kind: "summary",
          ok: true,
          generated: true,
          text: out.text,
          refs: out.refs,
          sources: out.refs.map((r) => r.slice(0, r.lastIndexOf("@"))),
          ...(out.truncated ? { truncated: true as const } : {}),
        };
      } catch {
        return fail(base, "query_failed");
      }
    }
    case "callout": {
      const tone = opts.tone === "warning" ? "warning" : "info";
      return { ...base, kind: "callout", ok: true, text: String(opts.text ?? ""), tone };
    }
    case "data": {
      const target = await visibleRef(deps, nestId, opts.binding, p);
      if (!target) return fail(base, "not_found");
      if (target.type !== "table") return fail(base, "unsupported_binding");
      let out: TableRows | { error: ErrorCode };
      try {
        out = await deps.tableRows(nestId, target.id, p.some((x) => x.approvedOnly), p);
      } catch {
        return fail(base, "query_failed");
      }
      if ("error" in out) return fail(base, out.error);
      const truncated = out.rows.length > caps.MAX_ROWS;
      return {
        ...base,
        kind: "data",
        ok: true,
        sources: [target.id],
        columns: out.columns,
        rows: out.rows.slice(0, caps.MAX_ROWS),
        ...(truncated ? { truncated: true as const } : {}),
      };
    }
    case "html": {
      const target = await visibleRef(deps, nestId, opts.ref, p);
      if (!target) return fail(base, "not_found");
      if (target.type !== "artifact") return fail(base, "unsupported_binding");
      return {
        ...base,
        kind: "html",
        ok: true,
        artifactId: target.id,
        dataFrom: normalizeDataFrom(opts.data_from),
      };
    }
    default:
      // table / kpi / chart / metric — no renderer in v1.
      return fail(base, "unsupported_kind");
  }
}

/**
 * Resolve a view's blocks for the principal set `p` (the viewer on the page;
 * the trust principals for a frame). `only` limits resolution to those block
 * ids — a frame resolves its data_from targets and nothing else.
 */
export async function resolveBlocks(
  view: ViewMeta,
  nestId: string,
  p: Principal[],
  deps: ViewDeps,
  only?: Iterable<string>,
  caps: Caps = CAPS,
): Promise<ResolvedBlock[]> {
  const wanted = only ? new Set(only) : null;
  const out: ResolvedBlock[] = [];
  const blocks = servedBlocks(view, caps);
  for (let i = 0; i < blocks.length; i++) {
    if (wanted && !wanted.has(blockIdOf(blocks[i], i))) continue;
    out.push(await resolveOne(blocks[i], i, nestId, p, deps, caps));
  }
  return out;
}

// ─── nest-data ──────────────────────────────────────────────────────────
// The nest-data wire shape (entry kinds, error codes, caps, placement) is
// owned here until §1.12 specifies it: proposed upstream in
// PromptOwl/ContextNest#215. Once the engine exports it, consume it from there.

/** Escape serialized JSON so it can sit inside <script>…</script> (§2.4):
 *  no literal `<` survives, so `</script>` cannot close the element, and
 *  U+2028/2029 cannot end a line in a pre-ES2019 parser. */
function escapeJson(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Bytes an entry costs in the final, escaped payload. */
function costOf(value: unknown): number {
  return Buffer.byteLength(escapeJson(JSON.stringify(value)), "utf8");
}

/** The longest prefix of `n` items for which `fits(k)` holds (binary search;
 *  `fits` is monotone: fewer items never cost more). */
function longestFit(n: number, fits: (k: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function entryOf(b: ResolvedBlock): NestDataEntry {
  if (!b.ok) return { ok: false, kind: b.kind, error: b.error };
  switch (b.kind) {
    case "md":
      return { ok: true, kind: "md", text: b.text };
    case "list":
      return { ok: true, kind: "list", items: b.items, ...(b.truncated ? { truncated: true } : {}) };
    case "data":
      return {
        ok: true,
        kind: "data",
        columns: b.columns,
        rows: b.rows,
        ...(b.truncated ? { truncated: true } : {}),
      };
    case "callout":
      return { ok: true, kind: "callout", text: b.text, tone: b.tone };
    default:
      // An html block is a frame, not data.
      return { ok: false, kind: b.kind, error: "unsupported_kind" };
  }
}

/** Fit one entry under MAX_BLOCK_BYTES: drop trailing rows/items, or cut md
 *  text at a code-point (so UTF-8) boundary, and mark it truncated. */
function capEntry(entry: NestDataEntry, caps: Caps): NestDataEntry {
  if (costOf(entry) <= caps.MAX_BLOCK_BYTES) return entry;
  const tooLarge = { ok: false, kind: entry.kind, error: "too_large" } as NestDataEntry;
  const listKey = Array.isArray(entry.rows) ? "rows" : Array.isArray(entry.items) ? "items" : null;
  if (listKey) {
    const all = entry[listKey] as unknown[];
    const at = (k: number) => ({ ...entry, [listKey]: all.slice(0, k), truncated: true });
    const k = longestFit(all.length, (n) => costOf(at(n)) <= caps.MAX_BLOCK_BYTES);
    const out = at(k) as NestDataEntry;
    return costOf(out) <= caps.MAX_BLOCK_BYTES ? out : tooLarge;
  }
  if (typeof entry.text === "string") {
    const chars = Array.from(entry.text);
    const at = (k: number) => ({ ...entry, text: chars.slice(0, k).join(""), truncated: true });
    const k = longestFit(chars.length, (n) => costOf(at(n)) <= caps.MAX_BLOCK_BYTES);
    const out = at(k) as NestDataEntry;
    return costOf(out) <= caps.MAX_BLOCK_BYTES ? out : tooLarge;
  }
  return tooLarge;
}

/**
 * The `nest-data` object for one html block: exactly the ids in its
 * `data_from`, in that order, and nothing else. An id with no resolved block
 * (never declared, or past MAX_BLOCKS) is `not_found`; ids past MAX_DATA_FROM
 * and entries that would push the payload past MAX_NEST_DATA_BYTES are
 * `too_large`.
 */
export function buildNestData(
  resolved: ResolvedBlock[],
  dataFrom: string[] | string | undefined,
  caps: Caps = CAPS,
): NestData {
  const ids = normalizeDataFrom(dataFrom);
  const byId = new Map(resolved.map((b) => [b.id, b]));
  const out: NestData = {};
  let total = 2; // "{}"
  ids.forEach((id, i) => {
    const block = byId.get(id);
    const kind = block?.kind;
    const err = (error: ErrorCode): NestDataEntry =>
      kind ? { ok: false, kind, error } : { ok: false, error };
    let entry: NestDataEntry;
    if (i >= caps.MAX_DATA_FROM) entry = err("too_large");
    else if (!block) entry = err("not_found");
    else entry = capEntry(entryOf(block), caps);
    // Key, colon, value, and a comma for every entry after the first.
    const cost = (e: NestDataEntry) => costOf(id) + 1 + costOf(e) + (i > 0 ? 1 : 0);
    if (total + cost(entry) > caps.MAX_NEST_DATA_BYTES) entry = err("too_large");
    total += cost(entry);
    out[id] = entry;
  });
  return out;
}

/** Every `data_from` entry withheld — what a frame gets when trust fails. */
export function withheldNestData(view: ViewMeta, dataFrom: string[] | string | undefined): NestData {
  const kinds = new Map<string, string>();
  servedBlocks(view).forEach((b, i) => kinds.set(blockIdOf(b, i), blockKindOf(b) ?? "unknown"));
  const out: NestData = {};
  for (const id of normalizeDataFrom(dataFrom)) {
    const kind = kinds.get(id);
    out[id] = kind ? { ok: false, kind, error: "withheld" } : { ok: false, error: "withheld" };
  }
  return out;
}

/** Serialize for injection (§2.4). */
export function serializeNestData(data: NestData): string {
  return escapeJson(JSON.stringify(data));
}

const DOCTYPE_RE = /^\uFEFF?\s*<!doctype\b[^>]*>/i;
/**
 * One left-to-right pass over the markup. Alternatives that are NOT an
 * insertion point are consumed whole so their text can't match: comments,
 * raw-text / inert elements (title, textarea, style, xmp, noscript, template)
 * and ordinary start tags with quoted attribute values. Group 2 is the
 * insertion point: a real `<script` start tag or `</head>`. Every repeated
 * piece matches one character or one closed quote, so there is no
 * nested-quantifier backtracking.
 */
const SCAN_RE =
  /<!--[\s\S]*?(?:-->|$)|<(title|textarea|style|xmp|noscript|template)\b[\s\S]*?(?:<\/\1\s*>|$)|(<script[\s>/]|<\/head[\s>])|<[a-zA-Z][^\s/<>]*(?:\s|"[^"]*"|'[^']*'|[^\s"'<>])*>/gi;

function insertionPoint(html: string): number {
  SCAN_RE.lastIndex = 0;
  for (let m = SCAN_RE.exec(html); m; m = SCAN_RE.exec(html)) {
    if (m[2]) return m.index;
    if (m[0].length === 0) SCAN_RE.lastIndex++;
  }
  return -1;
}

/**
 * Insert exactly one `<script type="application/json" id="nest-data">`:
 * after the doctype (so the page stays out of quirks mode), before the first
 * `<script` or `</head>` tag (so the artifact's own scripts can read it
 * synchronously; text inside comments, raw-text elements and attribute
 * values is skipped), else right after the doctype or at byte 0. Ours always
 * comes first, so `getElementById("nest-data")` returns it even when the
 * artifact ships an element of its own with that id.
 */
export function injectNestData(html: string, json: string): string {
  const tag = `<script type="application/json" id="nest-data">${json}</script>`;
  const doctype = DOCTYPE_RE.exec(html);
  const start = doctype ? doctype[0].length : 0;
  const rest = html.slice(start);
  const i = insertionPoint(rest);
  const at = start + (i >= 0 ? i : 0);
  return html.slice(0, at) + tag + html.slice(at);
}

// ─── Trust ──────────────────────────────────────────────────────────────

/** A `node_versions.author` of the view or artifact chain, looked up. */
export type AuthorInfo = {
  email: string;
  /** null when the email names no user on this server. */
  userId: string | null;
  isSystem: boolean;
  nestPermission: "none" | string;
  /** True when their only standing here is the nest's visibility. */
  approvedOnly?: boolean;
};

export interface TrustInput {
  stewardship: boolean;
  viewApproved: boolean;
  artifactApproved: boolean;
  viewer: Principal;
  authors: AuthorInfo[];
  /** True when some version of either chain has no author on record, so
   *  `authors` cannot be the whole list — withholds. */
  authorsIncomplete?: boolean;
  killSwitch: boolean;
}

export type TrustDecision = { ok: true; principals: Principal[] } | { ok: false; reason: string };

/**
 * Whose access bounds a frame's data (spec §2.5). Pure, and every check runs
 * before any ACL call; the first failure withholds.
 *
 *  - The served view AND artifact versions must be approved.
 *  - On every nest, governed or not, everyone who wrote a version of either
 *    chain up to the served one is a principal next to the viewer (approval
 *    may have been self-publication) — and any of them who is a system or
 *    service identity, unknown, or no longer a member makes the data unsafe
 *    to hand over at all. `stewardship` is kept in the input for the record;
 *    it no longer widens anything.
 */
export function decideDataTrust(i: TrustInput): TrustDecision {
  if (i.killSwitch) return { ok: false, reason: "kill_switch" };
  if (!i.viewApproved) return { ok: false, reason: "view_not_approved" };
  if (!i.artifactApproved) return { ok: false, reason: "artifact_not_approved" };
  // No governed-nest shortcut: "approved" can be the author's own publication
  // (creator-reviews v1, a prime-only posture's non-prime documents, an
  // owner's self-approve), so approval alone never proves a second person read
  // the code. The authors always bound the data, on every nest.
  if (i.authorsIncomplete) return { ok: false, reason: "authors_incomplete" };
  if (i.authors.length === 0) return { ok: false, reason: "no_authors" };
  const principals: Principal[] = [i.viewer];
  for (const a of i.authors) {
    if (!a.email || a.isSystem || a.email.startsWith("system:")) {
      return { ok: false, reason: "system_or_empty_author" };
    }
    if (!a.userId) return { ok: false, reason: "unknown_author" };
    if (!a.nestPermission || a.nestPermission === "none") {
      return { ok: false, reason: "author_without_access" };
    }
    if (principals.some((p) => p.userId === a.userId)) continue;
    principals.push({ userId: a.userId, email: a.email, approvedOnly: a.approvedOnly === true });
  }
  return { ok: true, principals };
}

/**
 * A frame's whole data flow: decide trust, then — only if it holds — resolve
 * the `data_from` targets under the trust principals and build the payload.
 * When trust fails no dep is called at all.
 */
export async function frameNestData(i: {
  view: ViewMeta;
  dataFrom: string[] | string | undefined;
  nestId: string;
  deps: ViewDeps;
  trust: TrustInput;
  caps?: Caps;
}): Promise<{ data: NestData; trust: TrustDecision; sources: string[] }> {
  const caps = i.caps ?? CAPS;
  const trust = decideDataTrust(i.trust);
  if (!trust.ok) return { data: withheldNestData(i.view, i.dataFrom), trust, sources: [] };
  const ids = normalizeDataFrom(i.dataFrom).slice(0, caps.MAX_DATA_FROM);
  const deps = { ...i.deps, summarize: undefined };
  const resolved = await resolveBlocks(i.view, i.nestId, trust.principals, deps, ids, caps);
  const sources = [...new Set(resolved.flatMap((b) => (b.ok && b.sources) || []))];
  return { data: buildNestData(resolved, i.dataFrom, caps), trust, sources };
}
