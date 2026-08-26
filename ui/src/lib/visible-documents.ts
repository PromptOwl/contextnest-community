/**
 * Which documents the Documents tab should show — pure, so the interaction
 * between lazy folder loading and nest-wide filtering is testable without a
 * browser.
 *
 * The subtlety worth pinning: documents arrive one folder level at a time, but
 * a filter or a search is a question about the WHOLE nest. Answering one from
 * the loaded levels alone would quietly report "no matches" for a document
 * sitting in a folder nobody expanded. So when a filter is on we answer from
 * the full listing instead — and until it arrives we answer from what we have,
 * which is incomplete but never wrong about the documents it does show.
 */
import { matchesFilters } from "./node-filter";

export interface VisibleDocumentsInput {
  /** Documents from the folder levels currently loaded. */
  levelNodes: any[];
  /** The whole nest, fetched on demand once a filter is switched on. */
  fullNodes: any[] | null;
  /** Scoped folder ("" is the nest root); null means the whole nest. */
  folderFilter: string | null;
  search: string;
  status: string;
  type: string;
  author: string;
  tags: string[];
  updatedAfter?: number;
  /** Ids the server's full-text search matched, unioned with client matches. */
  contentHits: Set<string>;
}

/** Folder path of a node id ("" for documents directly under the root). */
export function folderOfNode(id: string): string {
  const rel = id.startsWith("nodes/") ? id.slice(6) : id;
  const slash = rel.lastIndexOf("/");
  return slash > 0 ? rel.slice(0, slash) : "";
}

/** True when any filter or search is narrowing the list. */
export function hasActiveFilters(f: {
  search: string;
  status: string;
  type: string;
  author: string;
  tags: string[];
  datePreset: string;
}): boolean {
  return (
    !!f.search ||
    f.status !== "all" ||
    f.type !== "all" ||
    f.tags.length > 0 ||
    f.author !== "all" ||
    f.datePreset !== "any"
  );
}

export function visibleDocuments(input: VisibleDocumentsInput): any[] {
  const filtering = hasActiveFilters({
    search: input.search,
    status: input.status,
    type: input.type,
    author: input.author,
    tags: input.tags,
    // The caller already resolved the preset into a timestamp; any value here
    // means the date filter is on.
    datePreset: input.updatedAfter ? "on" : "any",
  });
  const source = filtering ? (input.fullNodes ?? input.levelNodes) : input.levelNodes;

  return source.filter((n) => {
    // Folder scope: the doc's folder must be the scoped folder or inside it.
    if (input.folderFilter !== null) {
      const f = folderOfNode(n.id || "");
      if (f !== input.folderFilter && !f.startsWith(`${input.folderFilter}/`)) {
        return false;
      }
    }
    if (
      !matchesFilters(n, {
        status: input.status,
        tags: input.tags,
        author: input.author,
        updatedAfter: input.updatedAfter,
        type: input.type,
      })
    ) {
      return false;
    }
    if (!input.search) return true;
    return matchesFilters(n, { search: input.search }) || input.contentHits.has(n.id);
  });
}
