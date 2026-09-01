import { useMemo, type CSSProperties, type ReactNode } from "react";

/** "gtm-deals" → "Gtm Deals" — a single folder segment, title-cased. */
export function prettyFolder(name: string) {
  if (name === "Root") return "Root";
  return name
    .split(/[-_]/)
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
    .join(" ");
}

/** "nodes/gtm/deals" → "Nodes / Gtm / Deals" — a full folder path. Kept for
 *  breadcrumbs and titles; the tree itself renders one segment per row. */
export function prettyFolderPath(path: string) {
  if (path === "Root") return "Root";
  return path.split("/").map(prettyFolder).join(" / ");
}

/** One folder in the rendered tree. `path` is the full storage path; `name` is
 *  just this level's segment. Root bucket (loose docs) has depth -1 and no row —
 *  its docs render at depth 0. */
export interface FolderTreeNode {
  /** Deepest folder this row represents (compact chains collapse into one row). */
  path: string;
  /** Raw segment of `path`'s leaf. */
  name: string;
  /** Display label — a merged chain reads "5 / 6 / 7 / 8". */
  label: string;
  depth: number;
  /** Docs directly in this folder. */
  count: number;
  /** Docs anywhere in this subtree (this folder + all descendants). */
  total: number;
  docs: any[];
  children: FolderTreeNode[];
}

/** A folder the caller knows exists, with its real subtree count, even when
 *  none of its documents are loaded yet (lazy expansion). */
export interface KnownFolder {
  path: string;
  total: number;
}

/**
 * Build a real folder hierarchy from a flat list of (folder → docs) groups.
 *
 * The groups only name folders that DIRECTLY hold documents, so a deep leaf like
 * `a/b/c/d` arrives with no rows for `a`, `a/b`, `a/b/c`. We synthesise those
 * intermediate ancestors here so the tree nests one segment per level instead of
 * collapsing to a single "a / b / c / d" breadcrumb.
 *
 * `baseFolder` scopes the tree: paths equal to it (or falsy / "Root") are the
 * loose root bucket; everything else nests beneath, with depth measured relative
 * to the base.
 */
export function buildFolderTree(
  groups: { folder: string; items: any[] }[],
  baseFolder = "",
  known?: KnownFolder[],
): FolderTreeNode {
  const root: FolderTreeNode = {
    path: baseFolder,
    name: "",
    label: "",
    depth: -1,
    count: 0,
    total: 0,
    docs: [],
    children: [],
  };
  const byPath = new Map<string, FolderTreeNode>([[baseFolder, root]]);

  // Walk up from a full path, creating any missing ancestor rows on the way.
  const ensure = (fullPath: string): FolderTreeNode => {
    const existing = byPath.get(fullPath);
    if (existing) return existing;
    const rel =
      baseFolder && fullPath.startsWith(`${baseFolder}/`)
        ? fullPath.slice(baseFolder.length + 1)
        : fullPath;
    const segs = rel.split("/");
    const parentPath =
      segs.length > 1
        ? `${baseFolder ? `${baseFolder}/` : ""}${segs.slice(0, -1).join("/")}`
        : baseFolder;
    const parent = ensure(parentPath);
    const node: FolderTreeNode = {
      path: fullPath,
      name: segs[segs.length - 1],
      label: prettyFolder(segs[segs.length - 1]),
      depth: parent.depth + 1,
      count: 0,
      total: 0,
      docs: [],
      children: [],
    };
    parent.children.push(node);
    byPath.set(fullPath, node);
    return node;
  };

  // Seed known folders first so a collapsed, never-fetched folder still gets
  // a row — otherwise the tree could only show what had already loaded.
  const knownTotals = new Map<string, number>();
  for (const k of known ?? []) {
    if (!k.path || k.path === baseFolder) continue;
    if (baseFolder && !k.path.startsWith(`${baseFolder}/`)) continue;
    ensure(k.path);
    knownTotals.set(k.path, k.total);
  }

  for (const g of groups) {
    const folder = g.folder;
    if (!folder || folder === baseFolder || folder === "Root") {
      root.docs.push(...g.items);
      continue;
    }
    ensure(folder).docs.push(...g.items);
  }

  // Sort children by segment, roll up subtree totals. Doc order is left as the
  // caller supplied it (they may sort by edited/comments, not just name).
  const finalize = (n: FolderTreeNode): number => {
    n.count = n.docs.length;
    n.children.sort((a, b) => a.name.localeCompare(b.name));
    let total = n.count;
    for (const c of n.children) total += finalize(c);
    // The server's count wins when it is larger: rolling up only what is
    // loaded would badge an unexpanded folder "0" and make it unexpandable.
    n.total = Math.max(total, knownTotals.get(n.path) ?? 0);
    return n.total;
  };
  finalize(root);

  // Compact single-child container chains into one row, file-explorer style:
  // a folder with no doc of its own and exactly one child folds into that
  // child, so "5 > 6 > 7 > 8" renders as a single "5 / 6 / 7 / 8" row that
  // collapses at the end. Display depth is recomputed from the fold, not the
  // original nesting, so folded rows indent one level per rendered row.
  const compact = (node: FolderTreeNode, displayDepth: number): FolderTreeNode => {
    const segs = [node.name];
    let cur = node;
    while (cur.count === 0 && cur.children.length === 1) {
      cur = cur.children[0];
      segs.push(cur.name);
    }
    return {
      path: cur.path,
      name: cur.name,
      label: segs.map(prettyFolder).join(" / "),
      depth: displayDepth,
      count: cur.count,
      total: cur.total,
      docs: cur.docs,
      children: cur.children.map((c) => compact(c, displayDepth + 1)),
    };
  };
  // Compaction is skipped once folders are lazily loaded: folding `a > b`
  // into one row removes `a`'s own row, and with it the expand that fetches
  // `a`. Every level keeps its row so every level can be opened.
  root.children = known
    ? root.children
    : root.children.map((c) => compact(c, 0));
  return root;
}

interface FolderTreeProps {
  /** Folder → docs groups. Only folders with direct docs need appear; ancestors
   *  are synthesised. Use "" or "Root" for the loose root bucket. */
  groups: { folder: string; items: any[] }[];
  /** Scope the tree to this folder (drill-down). Defaults to the whole nest. */
  baseFolder?: string;
  /** Folders known to exist but whose documents may not be loaded yet. Supply
   *  this to render a lazily-expanded tree; omit it for an eager one. */
  known?: KnownFolder[];
  /** rem of indent added per nesting level. */
  indentRem?: number;
  /** Collapsed folders hide their subtree. Omit for an always-expanded tree. */
  isCollapsed?: (path: string) => boolean;
  renderFolder: (
    node: FolderTreeNode,
    ctx: { collapsed: boolean; depth: number },
  ) => ReactNode;
  renderDoc: (
    doc: any,
    ctx: { depth: number; parent: FolderTreeNode },
  ) => ReactNode;
  className?: string;
}

/**
 * Hierarchical folder tree — one indented row per folder segment, docs nested
 * under their folder. Shared by the Overview "Contents" card and the Documents
 * tab; each passes its own row UI (drag/drop + collapse in Documents, navigate
 * links in Overview) via the render props while this owns structure and indent.
 */
export function FolderTree({
  groups,
  baseFolder = "",
  known,
  indentRem = 1.25,
  isCollapsed,
  renderFolder,
  renderDoc,
  className,
}: FolderTreeProps) {
  const root = useMemo(
    () => buildFolderTree(groups, baseFolder, known),
    [groups, baseFolder, known],
  );

  const rows: ReactNode[] = [];
  const indent = (depth: number): CSSProperties | undefined =>
    depth > 0 ? { marginLeft: `${depth * indentRem}rem` } : undefined;

  const walk = (node: FolderTreeNode) => {
    const docDepth = node.depth + 1;
    for (const doc of node.docs) {
      rows.push(
        <div key={`doc:${doc.id}`} style={indent(docDepth)}>
          {renderDoc(doc, { depth: docDepth, parent: node })}
        </div>,
      );
    }
    for (const child of node.children) {
      const collapsed = isCollapsed ? isCollapsed(child.path) : false;
      rows.push(
        <div key={`folder:${child.path}`} style={indent(child.depth)}>
          {renderFolder(child, { collapsed, depth: child.depth })}
        </div>,
      );
      if (!collapsed) walk(child);
    }
  };
  walk(root);

  return <div className={className}>{rows}</div>;
}
