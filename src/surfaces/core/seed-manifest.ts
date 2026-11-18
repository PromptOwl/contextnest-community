/**
 * The seed manifest (PRD §13): parse, validate, hash. Pure — no DB, no I/O.
 *
 * A seed is DATA: a manifest node `seeds/<id>/seed` (YAML frontmatter or a
 * fenced ```yaml block) plus the seed nodes it lists. The engine never names
 * a folder; every folder, definition, tag and listener setting comes from
 * the manifest.
 *
 * Pure: no imports outside this folder (AC-CON-03). The YAML parser and the
 * hash are injected by services/seed-format.ts.
 *
 * Validation is all-or-nothing (AC-SEED-05): the first violation refuses the
 * whole seed with a reason, before anything is written. Path traversal, ids
 * outside `seeds/<id>/`, folders the manifest doesn't declare and the size
 * caps are all refused here.
 */

export const SEED_MAX_NODES = 50;
export const SEED_MAX_BYTES = 200 * 1024;
export const SEED_MAX_FOLDERS = 50;
export const SEED_MAX_DEFINITIONS = 100;
export const SEED_MAX_TAGS = 100;
export const MANIFEST_MAX_BYTES = 64 * 1024;

export const SEED_LAYERS = ["lifecycle", "org_mirror", "framework", "thesis"] as const;
export type SeedLayer = (typeof SEED_LAYERS)[number];

/**
 * Folder purposes the engine acts on. Written as object keys (a purpose is a
 * role, not a folder path): the people role gets the §4.6 people rules
 * (AC-STR-04) and the org mirror's person proposals; the areas role gets the
 * org mirror's channel-group areas. Every other purpose is free text for humans.
 */
const ROLES = { people: null, areas: null };
export const ROLE = Object.fromEntries(Object.keys(ROLES).map((k) => [k, k])) as { [K in keyof typeof ROLES]: K };

export interface SeedFolder {
  path: string;
  purpose: string;
  admin_only: boolean;
}
export interface SeedNodeRef {
  /** Id inside the seed: `seeds/<seed-id>/<rel>`. */
  id: string;
  /** Where it lands: `context` = the nest's CONTEXT.md; otherwise a node id
   *  relative to `nodes/` (the default is the id's path inside the seed). */
  target: string;
}
/**
 * A recipe (PO-1411): a seed offered when a nest is created. `name` and
 * `purpose` are what the picker card says; `order` places it in the catalog.
 */
export interface SeedRecipe {
  name: string;
  purpose: string;
  order: number;
}
/** A saved Board view grouped by the stage tag namespace, one column per stage, in order. */
export interface SeedBoard {
  name: string;
  stages: string[];
  /** This board's stages become the nest's task stages (order and default). At most one board. */
  task_stages: boolean;
}
/** A team chat channel (created only where team chat is on). */
export interface SeedChannel {
  name: string;
  purpose: string;
}
/** An agent the recipe suggests hiring: a C10 hire-catalog kind plus a handle. Never hired automatically. */
export interface SeedAgent {
  kind: SeedAgentKind;
  handle: string;
  why: string;
  /** watcher only: the seed channels it reads. */
  channels: string[];
}
/** The C10 hire catalog's kinds (src/hire/catalog.ts KINDS; a test keeps the two equal). */
export const SEED_AGENT_KINDS = ["hootie", "watcher", "webhook", "key"] as const;
export type SeedAgentKind = (typeof SEED_AGENT_KINDS)[number];
/** The tag namespace a seed board groups by (`stage:intent`, `stage:build`). */
export const STAGE_NAMESPACE = "stage";
/** Where a seed's distill ontology lands: the node the onboarding distill reads (src/onboarding/distill.ts ONTOLOGY_SLUG; a test keeps the two equal). */
export const DISTILL_TARGET = "distill/default-ontology";
export const SEED_MAX_BOARDS = 5;
export const SEED_MAX_STAGES = 12;
export const SEED_MAX_CHANNELS = 10;
export const SEED_MAX_AGENTS = 10;

export interface SeedManifest {
  id: string;
  version: number;
  title: string;
  /** One or two plain sentences on what the seed is for. */
  description: string | null;
  recipe: SeedRecipe | null;
  boards: SeedBoard[];
  channels: SeedChannel[];
  /** `hire:` in the manifest. */
  agents: SeedAgent[];
  /** The node id (under seeds/<id>/) that becomes the nest's distill ontology, or null. */
  distill: string | null;
  layers: SeedLayer[];
  folders: SeedFolder[];
  tags: Array<{ tag: string; meaning: string }>;
  definitions: Array<{ term: string; definition: string }>;
  thesis: string | null;
  /** never_terms: the seed's synonyms for its never_propose categories (data, S7-R2 L5). */
  listener: { propose_folders: string[]; domain_tags: string[]; never_propose: string[]; never_terms: string[] };
  nodes: SeedNodeRef[];
}

/** One seed node's content (title + body), as loaded from disk or a library nest. */
export interface SeedNodeContent {
  title: string;
  body: string;
}

export class SeedInvalidError extends Error {}

export const CONTEXT_TARGET = "context";
const SEED_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SEGMENT_RE = /^[a-z0-9][a-z0-9_-]{0,60}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
/**
 * Leaf names the storage treats specially (a folder's CONTEXT.md, INDEX.md,
 * README/agent-config files, view pages, the seed's own manifest). Written
 * upper-case and lowered at load, so no folder name appears as a literal.
 */
export const RESERVED_LEAVES: ReadonlySet<string> = new Set(
  ["CONTEXT", "INDEX", "README", "CLAUDE", "GEMINI", "AGENTS", "VIEW", "SEED"].map((s) => s.toLowerCase()),
);
const reservedLeaf = (path: string) => RESERVED_LEAVES.has(path.split("/").pop()!.toLowerCase());
const TERM_RE = /^[\p{L}\p{N}][\p{L}\p{N}' -]{0,59}$/u;
export const MAX_TERMS_PER_CATEGORY = 20;
const TOP_KEYS = new Set([
  "id",
  "version",
  "title",
  "layers",
  "folders",
  "tags",
  "definitions",
  "thesis",
  "listener",
  "nodes",
  "description",
  "recipe",
  "boards",
  "channels",
  "hire",
  "distill",
]);
const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const bad = (reason: string): never => {
  throw new SeedInvalidError(reason);
};

/** The YAML of a manifest: frontmatter first, else the first fenced ```yaml block. */
export function manifestYaml(text: string): string {
  const t = text.replace(/\r\n/g, "\n");
  const fm = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(t);
  if (fm) return fm[1];
  const fence = /```ya?ml\n([\s\S]*?)\n```/.exec(t);
  if (fence) return fence[1];
  return bad("the manifest has no YAML frontmatter or ```yaml block");
}

/** Is this a safe relative path of slug segments (no "..", no absolute, no backslash)? */
function safeSegments(p: string, maxDepth: number): string[] | null {
  if (typeof p !== "string" || !p || p.length > 300 || p.includes("\\") || p.includes("\0") || p.startsWith("/")) return null;
  const parts = p.split("/");
  if (parts.length > maxDepth) return null;
  for (const s of parts) if (s === ".." || s === "." || !SEGMENT_RE.test(s)) return null;
  return parts;
}

/** A folder path: slug segments ending in "/", at most 4 deep. */
export function validFolderPath(p: unknown): p is string {
  return typeof p === "string" && p.endsWith("/") && !!safeSegments(p.slice(0, -1), 4);
}

/** Top-level folder of a target ("/" for a document at the nest root). */
export function folderOfTarget(target: string): string {
  const parts = target.split("/");
  return parts.length > 1 ? `${parts.slice(0, -1).join("/")}/` : "/";
}

function str(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== "string" || v.trim().length < min || v.length > max) bad(`${field} must be text of ${min}–${max} characters`);
  return (v as string).trim();
}
function arr(v: unknown, field: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) bad(`${field} must be a list`);
  return v as unknown[];
}

/** Parse + validate a manifest with the given YAML loader. Throws SeedInvalidError (→ 422) on the first violation. */
export function parseManifestWith(text: string, loadYaml: (yamlText: string) => unknown): SeedManifest {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MANIFEST_MAX_BYTES) bad(`the manifest is over ${MANIFEST_MAX_BYTES / 1024} KB`);
  let raw: unknown;
  try {
    raw = loadYaml(manifestYaml(text));
  } catch (err) {
    if (err instanceof SeedInvalidError) throw err;
    bad("the manifest YAML doesn't parse");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("the manifest must be a mapping");
  const m = raw as Record<string, unknown>;
  for (const k of Object.keys(m)) if (!TOP_KEYS.has(k)) bad(`unknown manifest key "${k}"`);

  const id = typeof m.id === "string" && SEED_ID_RE.test(m.id) ? m.id : bad("id must be a lowercase slug");
  const version = typeof m.version === "number" && Number.isInteger(m.version) && m.version >= 1 && m.version <= 1_000_000 ? m.version : bad("version must be a whole number ≥ 1");
  const title = str(m.title, "title", 1, 120);
  const layers = arr(m.layers, "layers").map((l) => ((SEED_LAYERS as readonly unknown[]).includes(l) ? (l as SeedLayer) : bad(`unknown layer "${String(l)}"`)));

  const seedRoot = `seeds/${id}/`;
  const folders: SeedFolder[] = [];
  const fl = arr(m.folders, "folders");
  if (fl.length > SEED_MAX_FOLDERS) bad(`more than ${SEED_MAX_FOLDERS} folders`);
  for (const f of fl) {
    if (!f || typeof f !== "object") bad("each folder is {path, purpose, admin_only?}");
    const x = f as Record<string, unknown>;
    for (const k of Object.keys(x)) if (!["path", "purpose", "admin_only"].includes(k)) bad(`unknown folder key "${k}"`);
    if (!validFolderPath(x.path)) bad(`folder path "${String(x.path)}" must be slug segments ending in / (no "..", not absolute)`);
    const path = x.path as string;
    if (path === "seeds/" || path.startsWith("seeds/")) bad(`folder "${path}" is inside the seed library area`);
    if (folders.some((g) => g.path === path)) bad(`folder "${path}" is listed twice`);
    const purpose = typeof x.purpose === "string" && SLUG_RE.test(x.purpose) ? x.purpose : bad(`folder "${path}" needs a purpose slug`);
    if (x.admin_only !== undefined && typeof x.admin_only !== "boolean") bad(`folder "${path}": admin_only must be true or false`);
    folders.push({ path, purpose, admin_only: x.admin_only === true });
  }
  const declared = new Set(folders.map((f) => f.path));

  const tags = arr(m.tags, "tags").map((t) => {
    const x = (t && typeof t === "object" ? t : bad("each tag is {tag, meaning}")) as Record<string, unknown>;
    const tag = typeof x.tag === "string" && SLUG_RE.test(x.tag) ? x.tag : bad(`tag "${String(x.tag)}" must be a lowercase slug`);
    return { tag, meaning: str(x.meaning, `tag ${tag} meaning`, 1, 400) };
  });
  if (tags.length > SEED_MAX_TAGS) bad(`more than ${SEED_MAX_TAGS} tags`);

  const definitions = arr(m.definitions, "definitions").map((d) => {
    const x = (d && typeof d === "object" ? d : bad("each definition is {term, definition}")) as Record<string, unknown>;
    return { term: str(x.term, "definition term", 1, 200), definition: str(x.definition, "definition text", 1, 2000) };
  });
  if (definitions.length > SEED_MAX_DEFINITIONS) bad(`more than ${SEED_MAX_DEFINITIONS} definitions`);
  const terms = new Set<string>();
  for (const d of definitions) {
    if (terms.has(d.term.toLowerCase())) bad(`definition "${d.term}" is listed twice`);
    terms.add(d.term.toLowerCase());
  }

  const nodes: SeedNodeRef[] = [];
  for (const n of arr(m.nodes, "nodes")) {
    const x = (typeof n === "string" ? { id: n } : n && typeof n === "object" ? n : bad("each node is an id or {id, target}")) as Record<string, unknown>;
    for (const k of Object.keys(x)) if (!["id", "target"].includes(k)) bad(`unknown node key "${k}"`);
    const nid = typeof x.id === "string" ? x.id : bad("node id is required");
    if (!nid.startsWith(seedRoot) || !safeSegments(nid, 6)) bad(`node "${nid}" is outside ${seedRoot}`);
    const rel = nid.slice(seedRoot.length);
    if (!rel || rel === "seed") bad(`node "${nid}" is the manifest itself`);
    if (reservedLeaf(rel)) bad(`node "${nid}" uses a reserved name`);
    const rawTarget = x.target === undefined ? rel : x.target;
    const target: string = typeof rawTarget === "string" ? rawTarget : bad(`node "${nid}": target must be text`);
    if (target !== CONTEXT_TARGET) {
      if (!safeSegments(target, 5)) bad(`node "${nid}": target "${target}" isn't a safe relative path`);
      if (reservedLeaf(target)) bad(`node "${nid}": target "${target}" uses a reserved name`);
      const folder = folderOfTarget(target);
      if (folder !== "/" && !declared.has(folder)) bad(`node "${nid}" targets folder "${folder}", which the manifest doesn't declare`);
    }
    if (nodes.some((o) => o.id === nid)) bad(`node "${nid}" is listed twice`);
    if (nodes.some((o) => o.target === target)) bad(`two nodes target "${target}"`);
    nodes.push({ id: nid, target });
  }
  let thesis: string | null = null;
  if (m.thesis !== undefined && m.thesis !== null) {
    thesis = typeof m.thesis === "string" ? m.thesis : bad("thesis must be a node id");
    if (!thesis.startsWith(seedRoot) || !safeSegments(thesis, 6)) bad(`thesis "${thesis}" is outside ${seedRoot}`);
    if (reservedLeaf(thesis)) bad(`thesis "${thesis}" uses a reserved name`);
    const t = thesis;
    if (!nodes.some((n) => n.id === t)) {
      const rel = t.slice(seedRoot.length);
      if (nodes.some((o) => o.target === rel)) bad(`two nodes target "${rel}"`);
      nodes.push({ id: t, target: rel });
    }
    const tn = nodes.find((n) => n.id === t)!;
    if (tn.target === CONTEXT_TARGET) bad("the thesis can't be CONTEXT.md");
  }
  let distill: string | null = null;
  if (m.distill !== undefined && m.distill !== null) {
    distill = typeof m.distill === "string" ? m.distill : bad("distill must be a node id");
    if (!distill.startsWith(seedRoot) || !safeSegments(distill, 6)) bad(`distill "${distill}" is outside ${seedRoot}`);
    if (reservedLeaf(distill)) bad(`distill "${distill}" uses a reserved name`);
    const d = distill;
    const listed = nodes.find((n) => n.id === d);
    if (listed && listed.target !== DISTILL_TARGET) bad(`distill "${d}" is also listed with another target`);
    if (!listed) {
      if (nodes.some((o) => o.target === DISTILL_TARGET)) bad(`two nodes target "${DISTILL_TARGET}"`);
      // The ontology's own folder is the onboarding distill's, not one the seed declares.
      nodes.push({ id: d, target: DISTILL_TARGET });
    }
  }
  if (nodes.length > SEED_MAX_NODES) bad(`more than ${SEED_MAX_NODES} nodes`);

  const description = m.description === undefined || m.description === null ? null : str(m.description, "description", 1, 600);
  const recipe = parseRecipe(m.recipe);
  const boards = parseBoards(m.boards);
  const channels = parseChannels(m.channels);
  // `hire:` in the manifest: the agents worth hiring (C10 catalog kinds).
  const agents = parseAgents(m.hire, new Set(channels.map((c) => c.name)));

  const l = (m.listener ?? {}) as Record<string, unknown>;
  if (typeof l !== "object" || Array.isArray(l)) bad("listener must be a mapping");
  for (const k of Object.keys(l)) if (!["propose_folders", "domain_tags", "never_propose"].includes(k)) bad(`unknown listener key "${k}"`);
  const propose = arr(l.propose_folders, "listener.propose_folders").map((p) => {
    if (p === "/") return "/";
    if (!validFolderPath(p)) bad(`listener folder "${String(p)}" must be slug segments ending in /`);
    if (!declared.has(p as string)) bad(`listener folder "${String(p)}" isn't one of the seed's folders`);
    if ((p as string).split("/").length !== 2) bad(`listener folder "${String(p)}" must be a top-level folder`);
    return p as string;
  });
  const tagSet = new Set(tags.map((t) => t.tag));
  const domainTags = arr(l.domain_tags, "listener.domain_tags").map((t) =>
    typeof t === "string" && tagSet.has(t) ? t : bad(`domain tag "${String(t)}" isn't one of the seed's tags`),
  );
  const never: string[] = [];
  const neverTerms: string[] = [];
  for (const t of arr(l.never_propose, "listener.never_propose")) {
    if (typeof t === "string") {
      never.push(SLUG_RE.test(t) ? t : bad(`never_propose "${t}" must be a slug`));
      continue;
    }
    const x = (t && typeof t === "object" && !Array.isArray(t) ? t : bad("each never_propose is a slug or {category, terms}")) as Record<string, unknown>;
    for (const k of Object.keys(x)) if (!["category", "terms"].includes(k)) bad(`unknown never_propose key "${k}"`);
    never.push(typeof x.category === "string" && SLUG_RE.test(x.category) ? x.category : bad(`never_propose category "${String(x.category)}" must be a slug`));
    const terms = arr(x.terms, "never_propose terms");
    if (terms.length > MAX_TERMS_PER_CATEGORY) bad(`never_propose "${String(x.category)}" has more than ${MAX_TERMS_PER_CATEGORY} terms`);
    for (const w of terms) neverTerms.push(typeof w === "string" && TERM_RE.test(w.trim()) ? w.trim().toLowerCase() : bad(`never_propose term "${String(w)}" must be plain words`));
  }

  return {
    id,
    version,
    title,
    description,
    recipe,
    boards,
    channels,
    agents,
    distill,
    layers,
    folders,
    tags,
    definitions,
    thesis,
    listener: { propose_folders: [...new Set(propose)], domain_tags: [...new Set(domainTags)], never_propose: [...new Set(never)], never_terms: [...new Set(neverTerms)] },
    nodes,
  };
}

function mapping(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) bad(`${what} must be a mapping`);
  return v as Record<string, unknown>;
}
function onlyKeys(x: Record<string, unknown>, keys: string[], what: string): void {
  for (const k of Object.keys(x)) if (!keys.includes(k)) bad(`unknown ${what} key "${k}"`);
}

function parseRecipe(v: unknown): SeedRecipe | null {
  if (v === undefined || v === null) return null;
  const x = mapping(v, "recipe");
  onlyKeys(x, ["name", "purpose", "order"], "recipe");
  const order = x.order === undefined ? 100 : x.order;
  if (typeof order !== "number" || !Number.isInteger(order) || order < 0 || order > 1000) bad("recipe.order must be a whole number 0–1000");
  return { name: str(x.name, "recipe.name", 1, 60), purpose: str(x.purpose, "recipe.purpose", 1, 200), order: order as number };
}

function parseBoards(v: unknown): SeedBoard[] {
  const list = arr(v, "boards");
  if (list.length > SEED_MAX_BOARDS) bad(`more than ${SEED_MAX_BOARDS} boards`);
  const out: SeedBoard[] = [];
  for (const b of list) {
    const x = mapping(b, "each board");
    onlyKeys(x, ["name", "stages", "task_stages"], "board");
    const name = str(x.name, "board name", 1, 80);
    if (out.some((o) => o.name.toLowerCase() === name.toLowerCase())) bad(`board "${name}" is listed twice`);
    const stages = arr(x.stages, `board "${name}" stages`).map((s) => (typeof s === "string" && SLUG_RE.test(s) ? s : bad(`board "${name}": stage "${String(s)}" must be a lowercase slug`)));
    if (stages.length < 2 || stages.length > SEED_MAX_STAGES) bad(`board "${name}" needs 2–${SEED_MAX_STAGES} stages`);
    if (new Set(stages).size !== stages.length) bad(`board "${name}" lists a stage twice`);
    if (x.task_stages !== undefined && typeof x.task_stages !== "boolean") bad(`board "${name}": task_stages must be true or false`);
    out.push({ name, stages, task_stages: x.task_stages === true });
  }
  if (out.filter((b) => b.task_stages).length > 1) bad("only one board can set the nest's task stages");
  return out;
}

function parseChannels(v: unknown): SeedChannel[] {
  const list = arr(v, "channels");
  if (list.length > SEED_MAX_CHANNELS) bad(`more than ${SEED_MAX_CHANNELS} channels`);
  const out: SeedChannel[] = [];
  for (const c of list) {
    const x = mapping(c, "each channel");
    onlyKeys(x, ["name", "purpose"], "channel");
    const name = typeof x.name === "string" && CHANNEL_RE.test(x.name) && !RESERVED_LEAVES.has(x.name) && x.name !== "search" ? x.name : bad(`channel "${String(x.name)}" must be a lowercase name (letters, digits, dashes)`);
    if (out.some((o) => o.name === name)) bad(`channel "${name}" is listed twice`);
    out.push({ name, purpose: str(x.purpose, `channel ${name} purpose`, 1, 280) });
  }
  return out;
}

function parseAgents(v: unknown, channelNames: Set<string>): SeedAgent[] {
  const list = arr(v, "hire");
  if (list.length > SEED_MAX_AGENTS) bad(`more than ${SEED_MAX_AGENTS} agents to hire`);
  const out: SeedAgent[] = [];
  for (const a of list) {
    const x = mapping(a, "each agent");
    onlyKeys(x, ["kind", "handle", "why", "channels"], "agent");
    const kind = (SEED_AGENT_KINDS as readonly unknown[]).includes(x.kind) ? (x.kind as SeedAgentKind) : bad(`agent kind "${String(x.kind)}" must be one of ${SEED_AGENT_KINDS.join(", ")}`);
    const handle = typeof x.handle === "string" && HANDLE_RE.test(x.handle) ? x.handle : bad(`agent handle "${String(x.handle)}" must be a lowercase handle`);
    if (out.some((o) => o.handle === handle)) bad(`agent "${handle}" is listed twice`);
    const channels = arr(x.channels, `agent ${handle} channels`).map((c) => (typeof c === "string" && channelNames.has(c) ? c : bad(`agent "${handle}" reads channel "${String(c)}", which the seed doesn't declare`)));
    if (kind === "watcher" && channels.length === 0) bad(`watcher "${handle}" needs at least one of the seed's channels`);
    if (kind !== "watcher" && channels.length > 0) bad(`agent "${handle}": only a watcher reads channels`);
    out.push({ kind, handle, why: str(x.why, `agent ${handle} why`, 1, 280), channels });
  }
  return out;
}

/**
 * The saved Board config (src/nests/board-service.ts BoardConfig) for a seed
 * board: tasks grouped by the stage tag, the stages as its exact columns.
 */
export function boardConfigFor(b: Pick<SeedBoard, "stages">): Record<string, unknown> {
  return {
    dimension: "tag",
    tagNamespace: STAGE_NAMESPACE,
    tasksOnly: true,
    layouts: { [`tag:${STAGE_NAMESPACE}`]: { columnOrder: [...b.stages] } },
  };
}

/** Total size check across manifest + node bodies + definitions (AC-SEED-05). */
export function assertSeedSize(manifestText: string, m: SeedManifest, contents: Map<string, SeedNodeContent>): void {
  let bytes = Buffer.byteLength(manifestText, "utf8");
  for (const n of m.nodes) {
    const c = contents.get(n.id);
    if (!c) bad(`node "${n.id}" is listed but missing from the seed`);
    if (!c!.title.trim() || c!.title.length > 200) bad(`node "${n.id}" needs a title of at most 200 characters`);
    // CONTEXT.md gets the same validation as any instructions save (S7-R2 L6).
    if (n.target === CONTEXT_TARGET && !c!.body.trim()) bad(`node "${n.id}" is the nest instructions and can't be empty`);
    bytes += Buffer.byteLength(c!.title, "utf8") + Buffer.byteLength(c!.body, "utf8");
  }
  if (bytes > SEED_MAX_BYTES) bad(`the seed is over ${SEED_MAX_BYTES / 1024} KB in total`);
}

/** Normalised body: CRLF → LF, trimmed. Both the stored hash and the check use it. */
export function normBody(body: string): string {
  return String(body ?? "").replace(/\r\n/g, "\n").trim();
}
/** What a definition's hash covers: its term and text. */
export const definitionText = (term: string, definition: string) => `${term.trim()}\n${definition.trim()}`;
export const seedOrigin = (m: Pick<SeedManifest, "id" | "version">) => `${m.id}@${m.version}`;

/**
 * What apply does to one seeded item (AC-SEED-02/03), decided from what the
 * nest holds now and what the seed recorded when it last wrote it.
 */
export type ItemAction = "created" | "unchanged" | "kept_human_edit" | "kept_human_delete" | "upgrade_available" | "updated" | "failed" | "create" | "update" | "skipped";
export function decideItem(input: {
  present: boolean;
  recordedHash: string | null;
  currentHash: string | null;
  recordedVersion: number | null;
  seedVersion: number;
  seedHash: string;
  upgrade: boolean;
}): "create" | "unchanged" | "kept_human_edit" | "kept_human_delete" | "upgrade_available" | "updated" {
  // Gone, but the seed wrote it: a person deleted it — never re-created (S7-R2 L2).
  if (!input.present) return input.recordedHash !== null ? "kept_human_delete" : "create";
  // Present but never written by this seed: a person's own document there.
  if (input.recordedHash === null) return "kept_human_edit";
  if (input.currentHash !== input.recordedHash) return "kept_human_edit";
  if (input.currentHash === input.seedHash) return "unchanged";
  if ((input.recordedVersion ?? 0) >= input.seedVersion) return "unchanged";
  return input.upgrade ? "updated" : "upgrade_available";
}

/** A short line for the bundled-seed lint (AC-SEED-06): the folder names a manifest declares. */
export function folderNames(m: SeedManifest): string[] {
  return [...new Set(m.folders.flatMap((f) => f.path.replace(/\/$/, "").split("/")))];
}
