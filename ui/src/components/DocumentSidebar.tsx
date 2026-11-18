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
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Globe,
  Building2,
  LayoutGrid,
  Lock,
  PanelLeftClose,
  Plus,
  Search,
  Users,
} from "lucide-react";
import { NodeTypeGlyph } from "./nest/NodeTypeIcon";
import { reads } from "../lib/queries";
import { nestRelation, nestRelationText } from "../lib/dashboard-scope";
import { ANON_USER_ID } from "../lib/constants";
import { useAuth } from "../auth/AuthContext";
import {
  folderAncestors,
  groupNodesByFolder,
} from "../lib/doc-page";
import { FolderTree, type KnownFolder } from "./FolderTree";
import { appRail, type AppPage } from "../lib/pages";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export interface SidebarNestTarget {
  nestId: string;
  nestName: string;
  isOwner: boolean;
  isAnonOwned: boolean;
}

interface Props {
  /** The nest on screen, or null on the dashboard (app pages listed, no
   *  nests). */
  nestId: string | null;
  /** The open document ("new" while creating one), or null on a nest page. */
  nodeId: string | null;
  onCollapse: () => void;
  onOpenDocument: (target: SidebarNestTarget & { nodeId: string }) => void;
  onOpenNest: (target: SidebarNestTarget) => void;
  onOpenDashboard: () => void;
  /** Brand image for the top row — the same one the app header uses. */
  logoUrl: string;
  /** Dashboard only: the open page and how to switch. */
  dashboardTab?: string | null;
  onOpenDashboardTab?: (id: string) => void;
  /** New document, optionally inside a folder. Omit when the caller can't
   *  author in this nest. */
  onNewDocument?: (folder?: string) => void;
  /** Pinned to the bottom of the rail: Docs and the account menu. */
  footer?: ReactNode;
}

/* One row style for both rails (app pages and a nest's views / tree) so the
   sidebar reads the same wherever you are: same text size, icon, height. */
const ROW = "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted";
const ROW_IDLE = "text-foreground/80 hover:text-foreground";
const ROW_ACTIVE = "bg-muted font-medium text-foreground";
const ROW_ICON = "h-4 w-4 shrink-0";
/* Group / nest-name headings above a set of rows. */
const HEADING = "flex w-full items-center gap-1.5 rounded px-2.5 py-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground";

const nestTarget = (n: any): SidebarNestTarget => ({
  nestId: n.id,
  nestName: n.name,
  // The list endpoint always sets is_owner; the fallback reads the permission
  // field rather than assuming ownership.
  isOwner: n.is_owner ?? n.permission === "owner",
  isAnonOwned: n.user_id === ANON_USER_ID,
});

export function DocumentSidebar({
  nestId,
  nodeId,
  onCollapse,
  onOpenDocument,
  onOpenNest,
  onOpenDashboard,
  logoUrl,
  dashboardTab = null,
  onOpenDashboardTab,
  onNewDocument,
  footer,
}: Props) {
  // One rail everywhere: the nest list is the same on the dashboard as inside
  // a nest. Only the current nest is unfolded.
  const nests = useQuery({ ...reads.nestList() });
  const { isAdmin, authMode } = useAuth();
  // Which nests are unfolded. The current one always is; others open on click
  // and load their tree on demand.
  const [openNests, setOpenNests] = useState<Set<string>>(
    () => new Set(nestId ? [nestId] : []),
  );
  useEffect(() => {
    if (!nestId) return;
    setOpenNests((prev) => (prev.has(nestId) ? prev : new Set([...prev, nestId])));
  }, [nestId]);

  // Nest-name filter; the current nest always stays so its tree never vanishes.
  const [nestFilter, setNestFilter] = useState("");
  const rows = useMemo(() => {
    const list: any[] = nests.data?.nests ?? [];
    const q = nestFilter.trim().toLowerCase();
    // Current nest first so the tree you're in is never below the fold.
    return list
      .filter((n) => !q || n.id === nestId || String(n.name).toLowerCase().includes(q))
      .sort((a, b) => {
        if (a.id === nestId) return -1;
        if (b.id === nestId) return 1;
        return String(a.name).localeCompare(String(b.name));
      });
  }, [nests.data, nestId, nestFilter]);

  return (
    <nav
      aria-label="Nests and documents"
      className="flex h-full flex-col bg-[hsl(228_73%_24%)] text-sm text-foreground"
      style={NAVY_RAIL_TOKENS}
      data-testid="document-sidebar"
    >
      {/* Brand row — the same logo + badge the app header shows, so the rail
          and the header read as one surface (the header hides its own copy
          while the rail is open). Clicking it goes home. */}
      <div className="flex h-16 shrink-0 items-center justify-between gap-1 border-b border-border px-4">
        <button
          type="button"
          onClick={onOpenDashboard}
          className="flex min-w-0 items-center gap-2 hover:opacity-80"
          title="Dashboard"
          data-testid="document-sidebar-brand"
        >
          {/* The owl is navy, so it sits on a white tile against the navy rail. */}
          <img src={logoUrl} alt="ContextNest" className="h-8 w-8 rounded-md bg-white object-contain p-1" />
          <span className="font-semibold">ContextNest</span>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            Community
          </Badge>
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
      {/* Work shortcuts: the ribbon carries My Work and My Drafts from
          tablet width up, so they only appear here in the phone drawer. */}
      <WorkShortcuts
        active={dashboardTab}
        isAdmin={isAdmin}
        isSuperadmin={isAdmin && authMode !== "open"}
        onOpen={onOpenDashboardTab}
      />
      {/* The nests page (create, import, archive, connect) is one row away
          from every page, in or out of a nest. */}
      <button
        type="button"
        onClick={onOpenDashboard}
        aria-current={nestId === null && dashboardTab === "nests" ? "page" : undefined}
        className={cn(
          ROW,
          nestId === null && dashboardTab === "nests" ? ROW_ACTIVE : ROW_IDLE,
          "mx-2 mt-1.5 w-auto",
        )}
        title="All nests"
        data-testid="document-sidebar-all-nests"
      >
        <LayoutGrid className={ROW_ICON} />
        All nests
      </button>
      {(nests.data?.nests?.length ?? 0) > 1 && (
        <div className="relative mx-2 mt-1 mb-2">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={nestFilter}
            onChange={(e) => setNestFilter(e.target.value)}
            placeholder="Filter nests"
            aria-label="Filter nests"
            className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            data-testid="document-sidebar-nest-filter"
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {nests.isLoading && (
          <div className="px-2 py-2 text-xs text-muted-foreground">Loading…</div>
        )}
        {rows.map((n) => {
          const open = openNests.has(n.id);
          const current = n.id === nestId;
          const relation = nestRelation(n);
          return (
            <div key={n.id} className={cn("mb-1", current && "mb-3")}>
              <div
                className={cn(
                  "group flex items-center gap-1 rounded px-1.5 py-1",
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
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-1.5 truncate text-left text-xs font-semibold uppercase tracking-wide hover:text-foreground",
                    // Readable only through its visibility tier — not mine, not shared.
                    relation === "discovered" && "italic opacity-70",
                  )}
                  title={[`Open ${n.name}`, nestRelationText(n)].filter(Boolean).join(" — ")}
                  data-relation={relation}
                >
                  <span className="truncate">{n.name}</span>
                  {relation === "shared" && (
                    <Users className="h-3 w-3 shrink-0 text-blue-600" aria-label="Shared with you" />
                  )}
                  <VisibilityGlyph visibility={n.visibility} />
                </button>
                {current && onNewDocument && (
                  <button
                    type="button"
                    onClick={() => onNewDocument()}
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
                  onNewDocument={current ? onNewDocument : undefined}
                />
              )}
            </div>
          );
        })}
      </div>
      {footer && (
        <div
          className="shrink-0 space-y-0.5 border-t border-border p-2"
          data-testid="document-sidebar-footer"
        >
          {footer}
        </div>
      )}
    </nav>
  );
}

/**
 * The rail is navy, like PromptOwl's. Every control inside reads the shared
 * color tokens, so re-pointing them here (light text, translucent-looking
 * hover and border surfaces, a brighter blue for the active item) restyles the
 * whole rail without touching each row. Menus portaled out of the rail keep
 * the normal light theme.
 */
const NAVY_RAIL_TOKENS = {
  "--foreground": "0 0% 100%",
  "--muted-foreground": "228 60% 84%",
  "--background": "228 73% 20%",
  "--muted": "228 60% 33%",
  "--accent": "228 60% 33%",
  "--accent-foreground": "0 0% 100%",
  "--secondary": "228 60% 36%",
  "--secondary-foreground": "0 0% 100%",
  "--border": "228 55% 34%",
  "--input": "228 55% 34%",
  "--primary": "228 80% 48%",
  "--primary-foreground": "0 0% 100%",
  "--ring": "228 90% 75%",
} as CSSProperties;

/** Pages that only show in the rail where the ribbon is hidden. */
const RIBBON_PAGE_IDS = new Set(["my-work", "my-drafts"]);

/** The "work" pages from the registry. My Work and My Drafts are in the
 *  header ribbon on tablets and up, so the rail lists them for phones only;
 *  any other work page (the Stream, when on) stays here on every screen.
 *  Settings and help pages live under the account menu, not here. */
function WorkShortcuts({
  active,
  isAdmin,
  isSuperadmin,
  onOpen,
}: {
  active: string | null;
  isAdmin: boolean;
  isSuperadmin: boolean;
  onOpen?: (id: string) => void;
}) {
  const { mcpOauthEnabled, docStreamEnabled, surfacesEnabled } = useAuth();
  const rail = appRail({ isAdmin, isSuperadmin, mcpOauthEnabled, docStreamEnabled, surfacesEnabled });
  const pages = rail.groups.find((g) => g.id === "work")?.pages ?? [];
  if (pages.length === 0) return null;
  const alwaysShown = pages.some((p) => !RIBBON_PAGE_IDS.has(p.id));
  return (
    <div
      className={cn("mx-2 mt-3 space-y-0.5", !alwaysShown && "md:hidden")}
      data-testid="document-sidebar-dashboard"
    >
      {pages.map((page) => (
        <AppPageRow
          key={page.id}
          page={page}
          active={page.id === active}
          onOpen={onOpen}
          className={RIBBON_PAGE_IDS.has(page.id) ? "md:hidden" : undefined}
        />
      ))}
    </div>
  );
}
function AppPageRow({
  page,
  active,
  indent = false,
  onOpen,
  className,
}: {
  page: AppPage;
  active: boolean;
  onOpen?: (id: string) => void;
  /** Inside a group: rows sit under the group header. */
  indent?: boolean;
  className?: string;
}) {
  // Badge: a one-row read whose total is the number — the page fetches its
  // own list when opened. Pages without a badge skip the query.
  const badge = useQuery({
    ...(page.badge?.options() ?? { queryKey: ["page-badge", page.id, "none"], queryFn: async () => null }),
    enabled: !!page.badge,
  });
  const count = page.badge ? page.badge.count(badge.data) : 0;
  const Icon = page.icon;
  return (
    <button
      type="button"
      onClick={() => onOpen?.(page.id)}
      aria-current={active ? "page" : undefined}
      className={cn(
        ROW,
        indent && "pl-7",
        active ? ROW_ACTIVE : ROW_IDLE,
        className,
      )}
      data-testid={`document-sidebar-dashboard-${page.id}`}
    >
      <Icon className={ROW_ICON} />
      <span className="truncate">{page.label}</span>
      {count > 0 && (
        <span
          className={cn(
            "ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums",
            page.badge?.tone === "primary"
              ? "bg-primary text-primary-foreground"
              : "bg-muted-foreground/15 text-muted-foreground",
          )}
        >
          {count}
        </span>
      )}
    </button>
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
  onNewDocument,
}: {
  nestId: string;
  currentNodeId: string | null;
  onOpen: (nodeId: string) => void;
  /** Present when the caller can author here: a + on every folder row. */
  onNewDocument?: (folder: string) => void;
}) {
  // Folders start closed except the ones on the way to the open document; a
  // folder the user hasn't touched is open iff it leads to that document.
  const [toggled, setToggled] = useState<Map<string, boolean>>(() => new Map());
  const ancestors = useMemo(
    () => new Set(currentNodeId ? folderAncestors(currentNodeId) : []),
    [currentNodeId],
  );
  const isCollapsed = (path: string) => toggled.get(path) ?? !ancestors.has(path);

  // Every folder the nest has (with totals), empty ones included, so a folder
  // with no document still gets a row and its own expander.
  const census = useQuery(reads.census(nestId));
  const known = useMemo<KnownFolder[]>(
    () => (census.data?.census.folders ?? []).map((f) => ({ path: f.path, total: f.total ?? 0 })),
    [census.data],
  );

  // Documents come one folder level at a time — the root plus every open
  // folder — the same reads the nest page's Documents tab makes (shared cache),
  // instead of one whole-nest listing that was the heaviest read on the page.
  const openLevels = useMemo(() => {
    const open = known.map((k) => k.path).filter((p) => !isCollapsed(p));
    return ["", ...open];
    // isCollapsed is derived from toggled + ancestors
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [known, toggled, ancestors]);
  const levels = useQueries({
    queries: openLevels.map((folder) => reads.folderNodes(nestId, folder)),
  });
  const root = levels[0];
  // useQueries hands back new result objects every render; group only when
  // the loaded documents actually change (keyed by their ids).
  const loadedNodes = levels.flatMap((l) => l.data?.nodes ?? []);
  const loadedKey = loadedNodes.map((n) => n.id).join("|");
  const groups = useMemo(
    () => groupNodesByFolder<any>(loadedNodes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadedKey],
  );

  if (root?.isLoading && census.isLoading)
    return <div className="px-3 py-1 text-xs text-muted-foreground">Loading…</div>;
  if (root?.isError)
    return <div className="px-3 py-1 text-xs text-muted-foreground">Couldn't load</div>;
  if (!root?.isLoading && (root?.data?.nodes ?? []).length === 0 && known.length === 0)
    return <div className="px-3 py-1 text-xs text-muted-foreground">No documents yet</div>;

  return (
    <FolderTree
      groups={groups}
      known={known}
      indentRem={0.75}
      isCollapsed={isCollapsed}
      className="ml-2 border-l border-border/60 pl-1"
      renderFolder={(node, { collapsed }) => (
        <div className="group flex items-center">
        <button
          type="button"
          onClick={() =>
            setToggled((prev) => new Map(prev).set(node.path, !collapsed))
          }
          className={cn(ROW, ROW_IDLE)}
          aria-expanded={!collapsed}
          title={node.path}
        >
          {collapsed ? (
            <Folder className={ROW_ICON} />
          ) : (
            <FolderOpen className={ROW_ICON} />
          )}
          <span className="truncate">{node.label}</span>
          {node.total > 0 && (
            <span className="ml-auto text-[10px] tabular-nums opacity-70">{node.total}</span>
          )}
        </button>
          {onNewDocument && (
            <button
              type="button"
              onClick={() => onNewDocument(node.path)}
              className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
              title={`New document in ${node.label}`}
              aria-label={`New document in ${node.label}`}
              data-testid="document-sidebar-folder-new"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      renderDoc={(doc) => {
        const active = doc.id === currentNodeId;
        return (
          <button
            type="button"
            onClick={() => onOpen(doc.id)}
            aria-current={active ? "page" : undefined}
            className={cn(
              ROW,
              active ? ROW_ACTIVE : ROW_IDLE,
            )}
            title={doc.title}
            data-testid="document-sidebar-doc"
          >
            <NodeTypeGlyph type={doc.type} className={ROW_ICON} />
            <span className="truncate">{doc.title || "Untitled"}</span>
          </button>
        );
      }}
    />
  );
}
