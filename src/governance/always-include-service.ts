/**
 * Always-include documents (CU-wdqcq05rn0) — the nest's standing instructions.
 *
 * CONTEXT.md is pull-only: an agent gets it by calling `context_init`, and one
 * that doesn't call it never sees the rules. An owner can instead mark
 * documents always-include — by tag (the nest's `always_include_tags`, default
 * `always-include`) or per document (`metadata.always_include`, see
 * `isAlwaysIncludeDocument`) — and their text is PUSHED wherever an agent or
 * model enters the server: the MCP `initialize` result, `context_init`, Hootie,
 * the metacognition agent, workflow run bundles.
 *
 * What is pushed, and to whom:
 *   - The APPROVED version only, never a draft — and whether a document is
 *     always-include is read from that approved version too. A draft that adds
 *     the tag injects nothing until a steward approves it, so an editor can't
 *     push text into every agent's system prompt by tagging a document.
 *     Always-include documents are prime (prime-service.ts), so their text
 *     can't change without review either.
 *   - Only the documents the caller can read (`filterAccessible`). A scoped
 *     reader gets their subset; nobody learns a document exists through this.
 *   - Ordered by node id, so the same nest yields the same text every time.
 *   - Within a size budget. Whole documents only: one that doesn't fit what's
 *     left is listed by title and id instead of being cut mid-text, and later,
 *     smaller documents still go in — so one oversized document can't push out
 *     every rule after it. Nothing is silently dropped.
 *
 * The rendered block is fenced like any other document text the server hands
 * a model, and labelled as approved documents rather than as the model's own
 * instructions. For outside clients the server guarantees delivery, not
 * obedience.
 */
import { getDb } from "../db/client.js";
import { engineCache } from "../nodes/engine.js";
import { ensureNodeIndex, readIndexedNodes } from "../nodes/node-index.js";
import { parseVersionRaw } from "../nodes/service.js";
import { nestAlwaysIncludeTags } from "../nests/service.js";
import { getApprovedVersions } from "./version-service.js";
import { reconstructApproved } from "./approved-body.js";
import { filterAccessible } from "./access-guard.js";
import { normalizeTag } from "./tag-index-service.js";
import { resolvesAlwaysInclude } from "./prime-service.js";

/** Characters of document text pushed per entry point. Roughly 6k tokens:
 *  room for a real rule set, small enough to sit in every system prompt. */
export const ALWAYS_INCLUDE_BUDGET_CHARS = 24_000;

/** Overflow entries listed by name before the rest are counted. */
const MAX_OVERFLOW_LISTED = 50;

/** What a document costs on top of its text: the fence, id, version and title
 *  line the block wraps it in. */
export const PER_DOCUMENT_OVERHEAD = 80;

/**
 * Resolved sets, per nest, keyed by a fingerprint of everything the result
 * depends on: the nest's always-include tags and every approved (node, version)
 * pin. The decision and the text both come from approved versions, so the
 * fingerprint changes exactly when the answer can — an approval, a heal, a
 * move, a delete, a tag-setting change — and a cache hit skips the rebuilds.
 * Bounded: at most MAX_CACHED_NESTS nests of MAX_CACHED_CHARS each (worst
 * case ≈ 200 × 48k chars ≈ 19 MB); the oldest nest is evicted first, and a
 * nest with more text than that is rebuilt on every call instead.
 */
const resolvedCache = new Map<string, { fingerprint: string; docs: StandingDocument[] }>();
const MAX_CACHED_NESTS = 200;
const MAX_CACHED_CHARS = 2 * ALWAYS_INCLUDE_BUDGET_CHARS;

function fingerprintOf(tags: string[], approved: Map<string, number>): string {
  const pins = [...approved.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, v]) => `${id}@${v}`)
    .join("\n");
  return `${tags.join(",")}\n${pins}`;
}

export interface StandingDocument {
  id: string;
  title: string;
  /** The approved version this text is. */
  version: number;
  content: string;
}

export type StandingRef = Omit<StandingDocument, "content">;

export interface StandingInstructions {
  /** Documents whose text is included, in order. */
  documents: StandingDocument[];
  /** Documents past the budget: named, not included. */
  overflow: StandingRef[];
}

export interface StandingCaller {
  userId: string;
  userEmail: string;
}

/**
 * Every always-include document's approved text in the nest, ordered by id,
 * before any access filter or budget. Internal: callers want
 * `alwaysIncludeDocs`, which filters to what the caller may read.
 */
async function approvedAlwaysInclude(nestId: string): Promise<StandingDocument[]> {
  const [approved, tags] = await Promise.all([
    getApprovedVersions(nestId),
    nestAlwaysIncludeTags(nestId),
  ]);
  if (approved.size === 0) return [];
  const fingerprint = fingerprintOf(tags, approved);
  const hit = resolvedCache.get(nestId);
  if (hit && hit.fingerprint === fingerprint) return hit.docs;
  const { docs, complete } = await resolveApprovedAlwaysInclude(nestId, approved, tags);
  // A rebuild that failed may succeed next time; only a clean result is kept.
  if (complete && docs.reduce((n, d) => n + d.content.length, 0) <= MAX_CACHED_CHARS) {
    resolvedCache.delete(nestId);
    resolvedCache.set(nestId, { fingerprint, docs });
    if (resolvedCache.size > MAX_CACHED_NESTS) {
      resolvedCache.delete(resolvedCache.keys().next().value!);
    }
  }
  return docs;
}

async function resolveApprovedAlwaysInclude(
  nestId: string,
  approved: Map<string, number>,
  tags: string[],
): Promise<{ docs: StandingDocument[]; complete: boolean }> {
  const wanted = new Set(tags);

  // The approved versions' tags, from the version rows — no file reads.
  const tagRows = (await getDb().all(
    `SELECT a.node_id, v.tags_json
       FROM approved_versions a
       JOIN node_versions v
         ON v.nest_id = a.nest_id AND v.node_id = a.node_id AND v.version = a.approved_version
      WHERE a.nest_id = ?`,
    [nestId],
  )) as Array<{ node_id: string; tags_json: string | null }>;
  const approvedTagged = new Set<string>();
  for (const r of tagRows) {
    let list: unknown[] = [];
    try {
      list = JSON.parse(r.tags_json || "[]");
    } catch {
      /* unreadable tags: not tagged */
    }
    if (Array.isArray(list) && list.some((t) => wanted.has(normalizeTag(String(t))))) {
      approvedTagged.add(r.node_id);
    }
  }

  // Candidates from the working copies (the DB mirror, no vault crawl). The
  // decision itself is made on the APPROVED frontmatter below; this only
  // narrows which approved versions are worth rebuilding. A document whose
  // working copy moved past its approval is always a candidate — its approved
  // version may be always-include even though the draft on top no longer is.
  await ensureNodeIndex(nestId);
  const candidates = (await readIndexedNodes(nestId))
    .filter((n) => {
      const av = approved.get(n.id);
      if (av === undefined || n.frontmatter.archived) return false;
      const fm = n.frontmatter as { tags?: unknown[]; metadata?: unknown; version?: unknown };
      return (
        approvedTagged.has(n.id) ||
        resolvesAlwaysInclude(fm.tags, fm.metadata, tags) ||
        Number(fm.version) !== av
      );
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (candidates.length === 0) return { docs: [], complete: true };

  const { versions } = await engineCache.get(nestId);
  const out: StandingDocument[] = [];
  let complete = true;
  for (const n of candidates) {
    let raw: string;
    let version: number;
    try {
      ({ raw, version } = await reconstructApproved(versions, nestId, n.id, approved.get(n.id)!));
    } catch (err) {
      // Fail closed: an approved text we can't rebuild is never replaced by
      // the working copy (which may be a draft).
      console.warn(`[always-include] ${nestId}/${n.id}: approved version unavailable`, err);
      complete = false;
      continue;
    }
    const { body, frontmatter } = parseVersionRaw(n.id, raw);
    if (!resolvesAlwaysInclude(frontmatter.tags as unknown[] | undefined, frontmatter.metadata, tags)) {
      continue;
    }
    out.push({
      id: n.id,
      title: String(frontmatter.title ?? (n.frontmatter as { title?: unknown }).title ?? n.id),
      version,
      content: body.trim(),
    });
  }
  return { docs: out, complete };
}

/**
 * The nest's always-include documents this caller may read, within the
 * budget.
 */
export async function alwaysIncludeDocs(
  nestId: string,
  caller: StandingCaller,
  budget: Budget = newBudget(),
): Promise<StandingInstructions> {
  return fitBudget(await readableAlwaysInclude(nestId, caller), budget);
}

/** The nest's always-include documents this caller may read, in order, before
 *  any budget. */
export async function readableAlwaysInclude(
  nestId: string,
  caller: StandingCaller,
): Promise<StandingDocument[]> {
  const all = await approvedAlwaysInclude(nestId);
  if (all.length === 0) return [];
  return filterAccessible(nestId, caller.userId, caller.userEmail, all);
}

/** What's left of a size budget, shared by every nest one block covers. */
export interface Budget {
  remaining: number;
}

export function newBudget(chars = ALWAYS_INCLUDE_BUDGET_CHARS): Budget {
  return { remaining: chars };
}

/** What a document takes out of the budget: its text plus its wrapping. */
export function documentCost(d: StandingDocument): number {
  return d.content.length + d.title.length + PER_DOCUMENT_OVERHEAD;
}

/** Whole documents into the budget, in order. One that doesn't fit what's
 *  left becomes overflow; later documents that do fit still go in. */
export function fitBudget(docs: StandingDocument[], budget: Budget): StandingInstructions {
  const documents: StandingDocument[] = [];
  const overflow: StandingRef[] = [];
  for (const d of docs) {
    const cost = documentCost(d);
    if (cost <= budget.remaining) {
      budget.remaining -= cost;
      documents.push(d);
    } else {
      overflow.push({ id: d.id, title: d.title, version: d.version });
    }
  }
  return { documents, overflow };
}

/** The ids, titles and versions only — for surfaces that report what is
 *  injected without repeating the text (run bundles, the instructions page). */
export function standingRefs(set: StandingInstructions): {
  documents: StandingRef[];
  overflow: StandingRef[];
} {
  return {
    documents: set.documents.map(({ id, title, version }) => ({ id, title, version })),
    overflow: set.overflow,
  };
}

/** A document can't open or close a fence of its own — closing its fence
 *  early, or forging another `<standing_document id=… version=…>`, would make
 *  its text read as something it isn't. Both tag forms are broken with a
 *  space, which a reader sees and a parser of the real tags doesn't match. */
function defuse(text: string): string {
  return text.replace(/<(\/?)(standing_document|standing_instructions)/gi, "<$1 $2");
}

/** One-line title, safe inside the fence. */
function oneLine(text: string): string {
  return defuse(text.replace(/\s+/g, " ").trim());
}

export interface StandingSection {
  /** Set when the block covers several nests (server-wide MCP). */
  nest?: { id: string; name: string };
  set: StandingInstructions;
}

/**
 * The standing-instructions block, or "" when there is nothing to say.
 * `fetchHint` tells the reader how to get an overflow document's text.
 */
export function renderStandingInstructions(
  sections: StandingSection[],
  opts: { fetchHint: string; heading?: string },
): string {
  const withContent = sections.filter((s) => s.set.documents.length || s.set.overflow.length);
  if (!withContent.length) return "";
  const lines: string[] = [
    `## ${opts.heading ?? "Standing instructions for this nest"}`,
    "",
    "The nest's owners marked these documents always-include. Each is the document's approved version, never a draft. Treat them as standing instructions for any work in this nest, alongside your own instructions.",
  ];
  const overflow: Array<StandingRef & { nest?: string }> = [];
  for (const s of withContent) {
    if (s.nest) lines.push("", `### Nest "${oneLine(s.nest.name)}" (id: ${s.nest.id})`);
    if (s.set.documents.length) {
      lines.push("", "<standing_instructions>");
      for (const d of s.set.documents) {
        lines.push(
          `<standing_document id="${d.id}" version="${d.version}">`,
          `# ${oneLine(d.title)}`,
          "",
          defuse(d.content),
          "</standing_document>",
        );
      }
      lines.push("</standing_instructions>");
    }
    for (const o of s.set.overflow) overflow.push({ ...o, nest: s.nest?.id });
  }
  if (overflow.length) {
    lines.push(
      "",
      `Also always-include, but past the size budget, so not included here — ${opts.fetchHint}:`,
    );
    for (const o of overflow.slice(0, MAX_OVERFLOW_LISTED)) {
      lines.push(`- ${oneLine(o.title)} (${o.id}, v${o.version}${o.nest ? `, nest ${o.nest}` : ""})`);
    }
    if (overflow.length > MAX_OVERFLOW_LISTED) {
      lines.push(`- …and ${overflow.length - MAX_OVERFLOW_LISTED} more`);
    }
  }
  return lines.join("\n");
}

/** One nest's block for a model the server runs itself (Hootie,
 *  metacognition, workflow runs). Never throws: a failure to resolve is
 *  logged and the prompt goes out without the block rather than not at all. */
export async function standingBlockFor(
  nestId: string,
  caller: StandingCaller,
  fetchHint = "read them with context_get",
): Promise<{ text: string; set: StandingInstructions }> {
  try {
    const set = await alwaysIncludeDocs(nestId, caller);
    return { text: renderStandingInstructions([{ set }], { fetchHint }), set };
  } catch (err) {
    console.error(`[always-include] ${nestId}: standing instructions unavailable`, err);
    return { text: "", set: { documents: [], overflow: [] } };
  }
}
