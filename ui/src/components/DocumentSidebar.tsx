/**
 * DocumentSidebar — the always-there index beside an open document
 * (Notion-style): every nest the caller can see, the current one expanded
 * into its folder → document tree, the open document highlighted.
 *
 * The document page used to be a dead end — a form with a back arrow — so
 * moving between documents meant a round trip through the nest list. This
 * rail reuses the nest page's FolderTree (same rows, same synthesised
 * ancestors) over the body-free node listing, so it costs no extra shape and
 * stays consistent with the Documents tab.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  Building2,
  Lock,
  LayoutGrid,
  PanelLeftClose,
  Plus,
} from "lucide-react";
import { reads } from "../lib/queries";
import { ANON_USER_ID } from "../lib/constants";
import { folderAncestors, groupNodesByFolder } from "../lib/doc-page";
import { FolderTree, type KnownFolder } from "./FolderTree";
import { cn } from "@/lib/utils";

export interface SidebarNestTarget {
  nestId: string;
  nestName: string;
  isOwner: boolean;
  isAnonOwned: boolean;
}

interface Props {
  nestId: string;
  /** The open document; "new" while creating one. */
  nodeId: string;
  onCollapse: () => void;
  onOpenDocument: (target: SidebarNestTarget & { nodeId: string }) => void;
  onOpenNest: (target: SidebarNestTarget) => void;
  onOpenDashboard: () => void;
  /** Omit when the caller can't author in this nest. */
  onNewDocument?: () => void;
}

const nestTarget = (n: any): SidebarNestTarget => ({
  nestId: n.id,
  nestName: n.name,
  isOwner: n.is_owner ?? (n.permission ?? "owner") === "owner",
  isAnonOwned: n.user_id === ANON_USER_ID,
});

export function DocumentSidebar({
  nestId,
  nodeId,
  onCollapse,
  onOpenDocument,
  onOpenNest,
  onOpenDashboard,
  onNewDocument,
}: Props) {
  const nests = useQuery(reads.nestList());
  // Which nests are unfolded. The current one always is; others open on click
  // and load their tree on demand.
  const [openNests, setOpenNests] = useState<Set<string>>(() => new Set([nestId]));
  useEffect(() => {
    setOpenNests((prev) => (prev.has(nestId) ? prev : new Set([...prev, nestId])));
  }, [nestId]);

  const rows = useMemo(() => {
    const list: any[] = nests.data?.nests ?? [];
    // Current nest first so the tree you're in is never below the fold.
    return [...list].sort((a, b) => {
      if (a.id === nestId) return -1;
      if (b.id === nestId) return 1;
      return String(a.name).localeCompare(String(b.name));
    });
  }, [nests.data, nestId]);

  return (
    <nav
      aria-label="Nests and documents"
      className="flex h-full flex-col bg-muted/30 text-sm"
      data-testid="document-sidebar"
    >
      <div className="flex items-center justify-between gap-1 px-2 pt-2 pb-1">
        <button
          type="button"
          onClick={onOpenDashboard}
          className="flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          title="All nests"
        >
          <LayoutGrid className="h-3.5 w-3.5" />
          All nests
        </button>
        <button
          type="button"
          onClick={onCollapse}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Hide sidebar"
          aria-label="Hide sidebar"
          data-testid="document-sidebar-collapse"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {nests.isLoading && (
          <div className="px-2 py-2 text-xs text-muted-foreground">Loading…</div>
        )}
        {rows.map((n) => {
          const open = openNests.has(n.id);
          const current = n.id === nestId;
          return (
            <div key={n.id} className={cn("mb-1", current && "mb-3")}>
              <div
                className={cn(
                  "group flex items-center gap-1 rounded px-1 py-1",
                  current ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <button
                  type="button"
                  onClick={() =>
                    setOpenNests((prev) => {
                      const next = new Set(prev);
                      if (next.has(n.id)) next.delete(n.id);
                      else next.add(n.id);
                      return next;
                    })
                  }
                  className="rounded p-0.5 hover:bg-muted"
                  aria-label={open ? `Collapse ${n.name}` : `Expand ${n.name}`}
                  aria-expanded={open}
                >
                  {open ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onOpenNest(nestTarget(n))}
                  className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left text-xs font-semibold uppercase tracking-wide hover:text-foreground"
                  title={`Open ${n.name}`}
                >
                  <span className="truncate">{n.name}</span>
                  <VisibilityGlyph visibility={n.visibility} />
                </button>
                {current && onNewDocument && (
                  <button
                    type="button"
                    onClick={onNewDocument}
                    className="rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100 focus:opacity-100"
                    title="New document"
                    aria-label="New document"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {open && (
                <NestTree
                  nestId={n.id}
                  currentNodeId={current ? nodeId : null}
                  onOpen={(id) => onOpenDocument({ ...nestTarget(n), nodeId: id })}
                />
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

function VisibilityGlyph({ visibility }: { visibility?: string }) {
  if (visibility === "public")
    return <Globe className="h-3 w-3 shrink-0 text-green-600" aria-label="Public" />;
  if (visibility === "org")
    return <Building2 className="h-3 w-3 shrink-0 text-blue-600" aria-label="Organization" />;
  return <Lock className="h-3 w-3 shrink-0 opacity-60" aria-label="Private" />;
}

/** One nest's folder → document tree. Folders start closed except the ones
 *  on the way to the open document. */
function NestTree({
  nestId,
  currentNodeId,
  onOpen,
}: {
  nestId: string;
  currentNodeId: string | null;
  onOpen: (nodeId: string) => void;
}) {
  const meta = useQuery(reads.nodesMeta(nestId));
  const census = useQuery(reads.census(nestId));
  const groups = useMemo(
    () => groupNodesByFolder<any>(meta.data?.nodes ?? []),
    [meta.data],
  );
  // Every folder the nest has, empty ones included, so a folder with no
  // document still gets a row and every level keeps its own expander.
  const known = useMemo<KnownFolder[]>(() => {
    const totals = new Map<string, number>();
    for (const f of census.data?.census.folders ?? []) totals.set(f.path, f.total ?? 0);
    for (const g of groups)
      if (g.folder && !totals.has(g.folder)) totals.set(g.folder, g.items.length);
    return [...totals.entries()].map(([path, total]) => ({ path, total }));
  }, [census.data, groups]);

  const [toggled, setToggled] = useState<Map<string, boolean>>(() => new Map());
  const ancestors = useMemo(
    () => new Set(currentNodeId ? folderAncestors(currentNodeId) : []),
    [currentNodeId],
  );
  // A folder the user hasn't touched is open iff it leads to the open doc.
  const isCollapsed = (path: string) => toggled.get(path) ?? !ancestors.has(path);

  if (meta.isLoading)
    return <div className="px-3 py-1 text-xs text-muted-foreground">Loading…</div>;
  if (meta.isError)
    return <div className="px-3 py-1 text-xs text-muted-foreground">Couldn't load</div>;
  if ((meta.data?.nodes ?? []).length === 0 && known.length === 0)
    return <div className="px-3 py-1 text-xs text-muted-foreground">No documents yet</div>;

  return (
    <FolderTree
      groups={groups}
      known={known}
      indentRem={0.75}
      isCollapsed={isCollapsed}
      className="ml-2 border-l border-border/60 pl-1"
      renderFolder={(node, { collapsed }) => (
        <button
          type="button"
          onClick={() =>
            setToggled((prev) => new Map(prev).set(node.path, !collapsed))
          }
          className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-expanded={!collapsed}
          title={node.path}
        >
          {collapsed ? (
            <Folder className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="truncate">{node.label}</span>
          {node.total > 0 && (
            <span className="ml-auto text-[10px] tabular-nums opacity-70">{node.total}</span>
          )}
        </button>
      )}
      renderDoc={(doc) => {
        const active = doc.id === currentNodeId;
        return (
          <button
            type="button"
            onClick={() => onOpen(doc.id)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-muted",
              active
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            title={doc.title}
            data-testid="document-sidebar-doc"
          >
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{doc.title || "Untitled"}</span>
          </button>
        );
      }}
    />
  );
}
