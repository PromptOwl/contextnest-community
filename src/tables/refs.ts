/**
 * Table `:ref` columns, resolved against the nest.
 *
 * Ref cells are parsed in service.ts (pure); this module answers "which node
 * does this ref name?" for a given caller. Resolution is the graph's own
 * [[wikilink]] rule — exact id, then case-folded title (first doc wins), then
 * bare slug — run ONLY over documents the caller can read. A target the caller
 * can't see resolves to nothing, exactly like a missing one, so no edge, query
 * match or report ever tells them a hidden node exists or what it is called.
 */
import type { ContextNode } from "@promptowl/contextnest-engine";
import { filterAccessible } from "../governance/access-guard.js";
import { isDerivedAnnotationsNode } from "../nodes/service.js";
import { engineCache } from "../nodes/engine.js";
import {
  extractTableRefs,
  parseTable,
  type RefResolver,
  type TableRef,
} from "./service.js";

/** Bare slug of an id/target: the part after the last "/". */
function bareSlug(idOrTarget: string): string {
  const idx = idOrTarget.lastIndexOf("/");
  return idx >= 0 ? idOrTarget.slice(idx + 1) : idOrTarget;
}

/**
 * Resolver over an already access-filtered document list. Same order as
 * buildNestGraph's wikilink pass: exact id, title, bare slug.
 */
export function makeRefResolver(docs: Array<Pick<ContextNode, "id" | "frontmatter">>): RefResolver {
  const idSet = new Set<string>();
  const titleToId = new Map<string, string>();
  const slugToId = new Map<string, string>();
  for (const d of docs) {
    idSet.add(d.id);
    const t = String(d.frontmatter?.title ?? "").toLowerCase().trim();
    // First occurrence wins — a duplicate case-folded title is ambiguous.
    if (t && !titleToId.has(t)) titleToId.set(t, d.id);
    const slug = bareSlug(d.id).toLowerCase();
    if (slug && !slugToId.has(slug)) slugToId.set(slug, d.id);
  }
  return (raw: string) => {
    const t = raw.trim();
    if (!t) return null;
    if (idSet.has(t)) return t;
    return titleToId.get(t.toLowerCase()) ?? slugToId.get(bareSlug(t).toLowerCase()) ?? null;
  };
}

/** The resolver for one caller: every document of the nest they can read. */
export async function callerRefResolver(
  nestId: string,
  userId: string,
  userEmail: string,
): Promise<RefResolver> {
  const { storage } = await engineCache.get(nestId);
  const docs = (await storage.discoverDocuments()).filter(
    (d) => !isDerivedAnnotationsNode(d.id),
  );
  return makeRefResolver(await filterAccessible(nestId, userId, userEmail, docs));
}

/** What a save reports about a table's refs. */
export interface TableRefReport {
  /** Non-empty ref cells. */
  total: number;
  /** Refs naming no node the writer can read — reported, never blocking. */
  unresolved: TableRef[];
}

/**
 * The ref report for a just-written node, or undefined when there is nothing
 * to report: not a table, no `:ref` column, or a body that doesn't parse (a
 * save never failed on a bad table body before, and this must not start
 * failing it — or 500ing the response after the write already landed).
 */
export async function tableRefReport(
  nestId: string,
  node: Pick<ContextNode, "body" | "frontmatter">,
  userId: string,
  userEmail: string,
): Promise<TableRefReport | undefined> {
  if ((node.frontmatter?.type as string | undefined) !== "table") return undefined;
  try {
    const parsed = parseTable(node.body || "");
    if (!parsed.columns.some((c) => c.ref)) return undefined;
    const refs = extractTableRefs(parsed);
    const resolve = refs.length ? await callerRefResolver(nestId, userId, userEmail) : null;
    return {
      total: refs.length,
      unresolved: resolve ? refs.filter((r) => !resolve(r.target)) : [],
    };
  } catch {
    return undefined;
  }
}

/** One prose line for agents; "" when every ref resolved. */
export function tableRefProse(report: TableRefReport | undefined): string {
  if (!report || report.unresolved.length === 0) return "";
  const n = report.unresolved.length;
  const list = report.unresolved
    .slice(0, 10)
    .map((r) => `[[${r.target}]] (${r.column} · ${r.row})`)
    .join(", ");
  const more = n > 10 ? `, and ${n - 10} more` : "";
  return `\n\n${n} unresolved ref${n === 1 ? "" : "s"} (saved anyway; no node by that name or id that you can read): ${list}${more}.`;
}
