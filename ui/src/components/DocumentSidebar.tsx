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
import { useQueries, useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  Building2,
  Home,
  LayoutGrid,
  Lock,
  PanelLeftClose,
  Plug,
  Plus,
  Search,
} from "lucide-react";
import { reads, useNestMeta } from "../lib/queries";
import { ANON_USER_ID } from "../lib/constants";
import { deriveNestCaps, isNestArchived } from "../lib/nest-caps";
import { useAuth } from "../auth/AuthContext";
import {
  folderAncestors,
  groupNodesByFolder,
  nestSidebarViews,
  readDocPagePrefs,
  writeDocPagePrefs,
  type NestSidebarView,
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
  /** Which of the nest's views is on screen, for the highlight. */
  activeView?: NestSidebarView["id"] | null;
  onCollapse: () => void;
  onOpenDocument: (target: SidebarNestTarget & { nodeId: string }) => void;
  onOpenNest: (target: SidebarNestTarget) => void;
  /** Open one of the current nest's views (review queue, board, graph…). */
  onOpenView: (target: SidebarNestTarget, view: NestSidebarView) => void;
  /** Connect this nest to a CLI / MCP client / API caller. */
  onConnect?: () => void;
  onOpenDashboard: () => void;
  /** Brand image for the top row — the same one the app header uses. */
  logoUrl: string;
  /** Dashboard only: the open page and how to switch. */
  dashboardTab?: string | null;
  onOpenDashboardTab?: (id: string) => void;
  /** New document, optionally inside a folder. Omit when the caller can't
   *  author in this nest. */
  onNewDocument?: (folder?: string) => void;
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
  activeView = null,
  onCollapse,
  onOpenDocument,
  onOpenNest,
  onOpenView,
  onConnect,
  onOpenDashboard,
  logoUrl,
  dashboardTab = null,
  onOpenDashboardTab,
  onNewDocument,
}: Props) {
  // Only inside a nest — the dashboard rail is app pages, not nests.
  const nests = useQuery({ ...reads.nestList(), enabled: nestId !== null });
  const { isAdmin, workflowPlaneEnabled } = useAuth();
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
      className="flex h-full flex-col bg-muted/30 text-sm"
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
          <img src={logoUrl} alt="ContextNest" className="h-7 w-7 object-contain" />
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
      {/* Inside a nest: the way back to every nest. On the dashboard the
          Nests row below is that. */}
      {nestId !== null && (
        <button
          type="button"
          onClick={onOpenDashboard}
          className={cn(ROW, ROW_IDLE, "mx-2 mt-3 w-auto")}
          title="All nests"
        >
          <LayoutGrid className={ROW_ICON} />
          All nests
        </button>
      )}
      {nestId !== null && (nests.data?.nests?.length ?? 0) > 1 && (
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {nestId === null && (
          <AppPagesNav
            active={dashboardTab}
            isAdmin={isAdmin}
            onOpen={onOpenDashboardTab}
          />
        )}
        {nestId !== null && nests.isLoading && (
          <div className="px-2 py-2 text-xs text-muted-foreground">Loading…</div>
        )}
        {nestId !== null && rows.map((n) => {
          const open = openNests.has(n.id);
          const current = n.id === nestId;
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
                  className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left text-xs font-semibold uppercase tracking-wide hover:text-foreground"
                  title={`Open ${n.name}`}
                >
                  <span className="truncate">{n.name}</span>
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
              {open && current && (
                <NestViews
                  nestId={n.id}
                  isOwner={nestTarget(n).isOwner}
                  isAdmin={isAdmin}
                  workflowPlaneEnabled={workflowPlaneEnabled}
                  activeView={activeView}
                  onOpen={(view) => onOpenView(nestTarget(n), view)}
                  onConnect={onConnect}
                />
              )}
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
    </nav>
  );
}

/** The dashboard's pages, straight from the registry, in their rail groups
 *  (Work, Workspace, Admin, Help). Ungrouped pages (Nests) sit on top. A
 *  group folds on click (remembered per browser) and opens itself when the
 *  page on screen is inside it, so the highlight is visible. Same row style
 *  as a nest's views so the rail reads as one. */
function AppPagesNav({
  active,
  isAdmin,
  onOpen,
}: {
  active: string | null;
  isAdmin: boolean;
  onOpen?: (id: string) => void;
}) {
  const rail = appRail({ isAdmin });
  const [closed, setClosedState] = useState<string[]>(
    () => readDocPagePrefs(localStorage).closedGroups,
  );
  const toggle = (id: string, open: boolean) => {
    const next = open ? closed.filter((g) => g !== id) : [...closed, id];
    setClosedState(next);
    writeDocPagePrefs(localStorage, { closedGroups: next });
  };
  return (
    <div className="mt-3 space-y-0.5" data-testid="document-sidebar-dashboard">
      {rail.top.map((page) => (
        <AppPageRow key={page.id} page={page} active={page.id === active} onOpen={onOpen} />
      ))}
      {rail.groups.map((g) => {
        const activeInGroup = g.pages.some((p) => p.id === active);
        const open = !closed.includes(g.id) || activeInGroup;
        return (
          <div key={g.id} className="pt-2">
            <button
              type="button"
              onClick={() => toggle(g.id, !open)}
              aria-expanded={open}
              className={HEADING}
              data-testid={`document-sidebar-group-${g.id}`}
            >
              {open ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate">{g.label}</span>
            </button>
            {open && (
              <div className="space-y-0.5">
                {g.pages.map((page) => (
                  <AppPageRow key={page.id} page={page} active={page.id === active} onOpen={onOpen} indent />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
function AppPageRow({
  page,
  active,
  indent = false,
  onOpen,
}: {
  page: AppPage;
  active: boolean;
  onOpen?: (id: string) => void;
  /** Inside a group: rows sit under the group header. */
  indent?: boolean;
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

// The nest page's own tabs; registry pages carry their icon in meta.
const TAB_ICONS: Record<string, typeof Home> = { overview: Home, review: ClipboardCheck };

/** The current nest's views — review queue, board, graph, definitions,
 *  workflows — under its name, so none of them is a trip back through the
 *  nest page away. Gated like the nest view switcher (see nestSidebarViews);
 *  the review queue carries its pending count. */
function NestViews({
  nestId,
  isOwner,
  isAdmin,
  workflowPlaneEnabled,
  activeView,
  onOpen,
  onConnect,
}: {
  nestId: string;
  isOwner: boolean;
  isAdmin: boolean;
  workflowPlaneEnabled: boolean;
  activeView: NestSidebarView["id"] | null;
  onOpen: (view: NestSidebarView) => void;
  onConnect?: () => void;
}) {
  const meta = useNestMeta(nestId);
  const caps = useMemo(() => {
    const m: any = meta.data;
    if (!m) return null;
    return deriveNestCaps({
      roles: m.roles ?? [],
      permission: m.permission ?? null,
      myStewards: m.myStewards ?? [],
      isOwner,
      isAdmin,
      readerMode: !!m.nest?.reader_mode,
      isArchived: isNestArchived(m.nest),
    });
  }, [meta.data, isOwner, isAdmin]);
  // The queue read is write-tier, so only writers ask; its count decides
  // whether an ungoverned nest gets the row at all (see nestSidebarViews).
  const queue = useQuery({
    ...reads.reviewQueue(nestId),
    enabled: !!caps && !caps.isReadOnly && !caps.isReaderView,
  });
  const pending = queue.data?.total ?? queue.data?.requests?.length ?? 0;
  const stewardshipEnabled = !!(meta.data as any)?.nest?.stewardship_enabled;
  const views = useMemo(
    () =>
      caps
        ? nestSidebarViews(caps, {
          workflowPlaneEnabled,
          stewardshipEnabled,
          hasPending: pending > 0,
        })
        : [],
    [caps, workflowPlaneEnabled, stewardshipEnabled, pending],
  );

  // The "Views" group folds by default (remembered per browser) and opens
  // itself when the view on screen is inside it, so the highlight is visible.
  const [viewsOpen, setViewsOpenState] = useState(
    () => readDocPagePrefs(localStorage).viewsOpen,
  );
  const setViewsOpen = (open: boolean) => {
    setViewsOpenState(open);
    writeDocPagePrefs(localStorage, { viewsOpen: open });
  };
  const activeInGroup = views.some((v) => v.group === "views" && v.id === activeView);
  const groupShown = viewsOpen || activeInGroup;
  const top = views.filter((v) => !v.group);
  const grouped = views.filter((v) => v.group === "views");

  if (views.length === 0) return null;

  const row = (v: NestSidebarView, indent = false) => {
    const Icon = v.icon ?? TAB_ICONS[v.id] ?? Home;
    const active = v.id === activeView;
    return (
      <button
        key={v.id}
        type="button"
        onClick={() => onOpen(v)}
        aria-current={active ? "page" : undefined}
        className={cn(
          ROW,
          indent && "pl-7",
          active ? ROW_ACTIVE : ROW_IDLE,
        )}
        data-testid={`document-sidebar-view-${v.id}`}
      >
        <Icon className={ROW_ICON} />
        <span className="truncate">{v.label}</span>
        {/* Something to review: a dot you can see from across the room,
            with the count — like an unread badge. Nothing at zero. */}
        {v.id === "review" && pending > 0 && (
          <span
            className="ml-auto inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-px text-[10px] font-semibold tabular-nums text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
            title={`${pending} awaiting review`}
            data-testid="document-sidebar-review-badge"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
            {pending}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="mb-1 ml-2 pl-1" data-testid="document-sidebar-views">
      {top.map((v) => row(v))}
      {grouped.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setViewsOpen(!groupShown)}
            aria-expanded={groupShown}
            className={cn(ROW, ROW_IDLE)}
            data-testid="document-sidebar-views-group"
          >
            {groupShown ? (
              <ChevronDown className={ROW_ICON} />
            ) : (
              <ChevronRight className={ROW_ICON} />
            )}
            <span className="truncate">Views</span>
          </button>
          {groupShown && grouped.map((v) => row(v, true))}
        </>
      )}
      {onConnect && (
        <button
          type="button"
          onClick={onConnect}
          className={cn(ROW, ROW_IDLE)}
          title="Connect a CLI, MCP client or API caller to this nest"
          data-testid="document-sidebar-connect"
        >
          <Plug className={ROW_ICON} />
          <span className="truncate">Connect</span>
        </button>
      )}
    </div>
  );
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
            <FileText className={ROW_ICON} />
            <span className="truncate">{doc.title || "Untitled"}</span>
          </button>
        );
      }}
    />
  );
}
