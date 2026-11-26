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
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  MessagesSquare,
} from "lucide-react";
import { NodeTypeGlyph } from "./nest/NodeTypeIcon";
import { reads } from "../lib/queries";
import { nestChat, railChatTarget } from "../lib/chat-harness";
import { ChatCount, useChatSummary } from "./chat/ChatEntry";
import { nestRelation, nestRelationText } from "../lib/dashboard-scope";
import { ANON_USER_ID } from "../lib/constants";
import { useAuth } from "../auth/AuthContext";
import { navRail, navRailStyle } from "../lib/nav-color";
import { ROW, ROW_ACTIVE, ROW_ICON, ROW_IDLE, RailBrand, RailFooter, RailNestHeading, RailRow } from "./rail/RailParts";
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
  /** Team chat (PO-1200): open a nest's chat. Its rows show only where chat
   *  is on and I am a member. */
  onOpenChat?: (target: SidebarNestTarget) => void;
  /** The nest whose chat is on screen, for the active row. */
  chatNestId?: string | null;
}

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
  onOpenChat,
  chatNestId = null,
}: Props) {
  const chat = useChatSummary();
  // One rail everywhere: the nest list is the same on the dashboard as inside
  // a nest. Only the current nest is unfolded.
  const nests = useQuery({ ...reads.nestList() });
  const { isAdmin, authMode, navColor } = useAuth();
  const rail = navRail(navColor);
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
      className="flex h-full flex-col text-sm text-foreground"
      // The rail's color: the admin's (Server settings → Basic, PO-1430) or
      // the default navy. One color re-points every token the rail reads.
      style={navRailStyle(navColor)}
      data-nav-color={rail.custom ? rail.background : "default"}
      data-testid="document-sidebar"
    >
      {/* Brand row — the same logo + badge the app header shows, so the rail
          and the header read as one surface (the header hides its own copy
          while the rail is open). Clicking it goes home. */}
      <RailBrand logoUrl={logoUrl} onOpen={onOpenDashboard} onCollapse={onCollapse} />
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
      <RailRow
        icon={LayoutGrid}
        label="All nests"
        active={nestId === null && dashboardTab === "nests"}
        onClick={onOpenDashboard}
        className="mx-2 mt-1.5 w-auto"
        title="All nests"
        data-testid="document-sidebar-all-nests"
      />
      {/* Chat across nests: when chat is on and I am in it somewhere, one row
          into the nest on screen, or where my mentions wait. */}
      {onOpenChat &&
        (() => {
          const target = railChatTarget(chat.data, nestId);
          if (!target) return null;
          const n = (nests.data?.nests ?? []).find((x: any) => x.id === target.nestId);
          return (
            <button
              type="button"
              onClick={() => onOpenChat(n ? nestTarget(n) : { nestId: target.nestId, nestName: target.nestName, isOwner: false, isAnonOwned: false })}
              className={cn(ROW, ROW_IDLE, "mx-2 mt-0.5 w-auto")}
              title={`Chat in ${target.nestName}`}
              data-testid="document-sidebar-chat"
            >
              <MessagesSquare className={ROW_ICON} />
              Chat
              {/* The sum of the per-nest numbers, so it always agrees with the rows below. */}
              <ChatCount
                counts={chat.data ? chat.data.nests.reduce((t, x) => ({ unread: t.unread + x.unread, mentions: t.mentions + x.mentions }), { unread: 0, mentions: 0 }) : null}
                className="ml-auto"
              />
            </button>
          );
        })()}
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
              <RailNestHeading
                name={n.name}
                open={open}
                current={current}
                onToggle={() =>
                  setOpenNests((prev) => {
                    const next = new Set(prev);
                    if (next.has(n.id)) next.delete(n.id);
                    else next.add(n.id);
                    return next;
                  })
                }
                onOpen={() => onOpenNest(nestTarget(n))}
                // Readable only through its visibility tier — not mine, not shared.
                nameClassName={relation === "discovered" ? "italic opacity-70" : undefined}
                title={[`Open ${n.name}`, nestRelationText(n)].filter(Boolean).join(" — ")}
                nameProps={{ "data-relation": relation }}
                glyphs={
                  <>
                    {relation === "shared" && (
                      <Users className="h-3 w-3 shrink-0 text-blue-600" aria-label="Shared with you" />
                    )}
                    <VisibilityGlyph visibility={n.visibility} />
                  </>
                }
                extra={
                  current && onNewDocument ? (
                    <button
                      type="button"
                      onClick={() => onNewDocument()}
                      className="rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100 focus:opacity-100"
                      title="New document"
                      aria-label="New document"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  ) : null
                }
              />
              {open && onOpenChat && nestChat(chat.data, n.id) && (
                <div className="ml-2 border-l border-border/60 pl-1">
                  <button
                    type="button"
                    onClick={() => onOpenChat(nestTarget(n))}
                    aria-current={chatNestId === n.id ? "page" : undefined}
                    className={cn(ROW, chatNestId === n.id ? ROW_ACTIVE : ROW_IDLE)}
                    title={`Chat in ${n.name}`}
                    data-testid="document-sidebar-nest-chat"
                  >
                    <MessagesSquare className={ROW_ICON} />
                    <span className="truncate">Chat</span>
                    <ChatCount counts={nestChat(chat.data, n.id)} className="ml-auto" />
                  </button>
                </div>
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
      {footer && <RailFooter>{footer}</RailFooter>}
    </nav>
  );
}


/** Pages that only show in the rail where the ribbon is hidden. */
const RIBBON_PAGE_IDS = new Set(["my-work", "my-drafts"]);

/** The "work" pages from the registry. My Work and My Drafts are in the
 *  header ribbon on tablets and up, so the rail lists them for phones only;
 *  any other work page (the Stream, when on) stays here on every screen.
 *  Settings and help pages live under the account menu, not here. */
export function WorkShortcuts({
  active,
  isAdmin,
  isSuperadmin,
  onOpen,
  preview = false,
}: {
  active: string | null;
  isAdmin: boolean;
  isSuperadmin: boolean;
  onOpen?: (id: string) => void;
  /** In the settings preview (PO-1430): no test ids, so the rail's stay unique. */
  preview?: boolean;
}) {
  const { mcpOauthEnabled, docStreamEnabled, surfacesEnabled } = useAuth();
  const rail = appRail({ isAdmin, isSuperadmin, mcpOauthEnabled, docStreamEnabled, surfacesEnabled });
  const pages = rail.groups.find((g) => g.id === "work")?.pages ?? [];
  if (pages.length === 0) return null;
  const alwaysShown = pages.some((p) => !RIBBON_PAGE_IDS.has(p.id));
  return (
    <div
      className={cn("mx-2 mt-3 space-y-0.5", !alwaysShown && "md:hidden")}
      data-testid={preview ? undefined : "document-sidebar-dashboard"}
    >
      {pages.map((page) => (
        <AppPageRow
          key={page.id}
          page={page}
          active={page.id === active}
          onOpen={onOpen}
          preview={preview}
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
  preview = false,
}: {
  preview?: boolean;
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
  return (
    <RailRow
      icon={page.icon}
      label={page.label}
      active={active}
      count={count}
      tone={page.badge?.tone === "primary" ? "primary" : "muted"}
      onClick={() => onOpen?.(page.id)}
      className={cn(indent && "pl-7", className)}
      data-testid={preview ? undefined : `document-sidebar-dashboard-${page.id}`}
    />
  );
}

export function VisibilityGlyph({ visibility }: { visibility?: string }) {
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
