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
  /** Grid view: the whole nest's metadata. A flat grid has no folders to
   *  expand, so the loaded levels alone would hide every nested document. */
  gridNodes?: any[] | null;
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
  const unfiltered = input.gridNodes ?? input.levelNodes;
  const source = filtering ? (input.fullNodes ?? unfiltered) : unfiltered;

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

/**
 * Is the Documents tab genuinely empty, or does it just have nothing at THIS
 * folder level?
 *
 * Under lazy loading the two are not the same. An imported nest routinely
 * keeps every document one level down, so the root level holds none — and
 * treating that as "empty" replaced a browsable folder tree with a
 * drag-files-here dropzone over a nest full of content. The tree is the thing
 * worth showing; only a filter that matched nothing, or a nest with no folders
 * at all, is actually empty.
 */
export function documentsTabIsEmpty(input: {
  /** Documents visible after filtering at the current level. */
  visibleCount: number;
  /** Folders known to exist anywhere in the nest. */
  folderCount: number;
  filtering: boolean;
}): boolean {
  if (input.visibleCount > 0) return false;
  // A filter that matched nothing IS empty — the folder tree would be noise.
  return input.filtering || input.folderCount === 0;
}
