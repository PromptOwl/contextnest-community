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
 *   - Within a size budget. Whole documents only: the first one that doesn't
 *     fit, and every one after it, is listed by title and id instead of being
 *     cut mid-text — the reader can fetch it, and nothing is silently dropped.
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
  const approved = await getApprovedVersions(nestId);
  if (approved.size === 0) return [];
  const tags = await nestAlwaysIncludeTags(nestId);
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
      if (av === undefined) return false;
      const fm = n.frontmatter as { tags?: unknown[]; metadata?: unknown; version?: unknown };
      return (
        approvedTagged.has(n.id) ||
        resolvesAlwaysInclude(fm.tags, fm.metadata, tags) ||
        Number(fm.version) !== av
      );
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (candidates.length === 0) return [];

  const { versions } = await engineCache.get(nestId);
  const out: StandingDocument[] = [];
  for (const n of candidates) {
    let raw: string;
    let version: number;
    try {
      ({ raw, version } = await reconstructApproved(versions, nestId, n.id, approved.get(n.id)!));
    } catch (err) {
      // Fail closed: an approved text we can't rebuild is never replaced by
      // the working copy (which may be a draft).
      console.warn(`[always-include] ${nestId}/${n.id}: approved version unavailable`, err);
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
  return out;
}

/**
 * The nest's always-include documents this caller may read, within the
 * budget. `budget` lets a caller resolving several nests share one budget.
 */
export async function alwaysIncludeDocs(
  nestId: string,
  caller: StandingCaller,
  budget: Budget = newBudget(),
): Promise<StandingInstructions> {
  const all = await approvedAlwaysInclude(nestId);
  if (all.length === 0) return { documents: [], overflow: [] };
  const readable = await filterAccessible(nestId, caller.userId, caller.userEmail, all);
  return fitBudget(readable, budget);
}

/** What's left of a size budget. Once one document overflows, it stays full:
 *  every later document is listed, so the order owners see is the order
 *  documents fall out of the budget. */
export interface Budget {
  remaining: number;
  full: boolean;
}

export function newBudget(chars = ALWAYS_INCLUDE_BUDGET_CHARS): Budget {
  return { remaining: chars, full: false };
}

/** Whole documents into the budget, in order; the rest become overflow. */
export function fitBudget(docs: StandingDocument[], budget: Budget): StandingInstructions {
  const documents: StandingDocument[] = [];
  const overflow: StandingRef[] = [];
  for (const d of docs) {
    if (!budget.full && d.content.length <= budget.remaining) {
      budget.remaining -= d.content.length;
      documents.push(d);
    } else {
      budget.full = true;
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

/** A document can't close its own fence (or the block's) and have what
 *  follows read as outside the fence. */
function defuse(text: string): string {
  return text.replace(/<\/(standing_document|standing_instructions)/gi, "</ $1");
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
      `Also always-include, but past the ${ALWAYS_INCLUDE_BUDGET_CHARS.toLocaleString("en-US")}-character budget, so not included here — ${opts.fetchHint}:`,
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
