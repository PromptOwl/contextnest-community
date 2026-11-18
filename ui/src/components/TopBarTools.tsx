/**
 * TopBarTools — Views and Connect, the two top-bar controls that act on a
 * nest. They sit beside My Work and My Drafts and are on every screen, so the
 * top bar never changes shape from one page to the next.
 *
 * Inside a nest, Views lists that nest's views and the two review surfaces
 * (Review queue, External edits). On the dashboard there is no nest yet, so
 * the same menu stays live and starts with a nest picker instead of going dead.
 * Connect is one quiet labelled item here and nowhere else. An open document's
 * edit actions (Publish, Save draft, Submit) follow New document.
 *
 * Gated exactly like the sidebar rows it replaced (see nestSidebarViews).
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, FileDiff, Home, LayoutGrid, Plug, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { reads, useNestMeta } from "../lib/queries";
import { deriveNestCaps, isNestArchived } from "../lib/nest-caps";
import { useAuth } from "../auth/AuthContext";
import { nestSidebarViews, type NestSidebarView } from "../lib/doc-page";

const MAX_PICKER = 12;

export function TopBarTools({
  nestId,
  isOwner,
  activeView,
  currentNodeId,
  onOpen,
  onOpenNode,
  onPickNest,
  onNewDocument,
  onConnect,
}: {
  /** The open nest, or undefined on the dashboard and other workspace pages. */
  nestId?: string;
  isOwner: boolean;
  /** "overview" / "review" / "external-edits" for the nest page's tabs, else a registry page id. */
  activeView: string | null;
  /** The document on screen, so its user view highlights. */
  currentNodeId: string | null;
  onOpen: (view: NestSidebarView) => void;
  onOpenNode: (nodeId: string) => void;
  onPickNest: (nest: { id: string; name: string; isOwner: boolean }) => void;
  /** Opens the New document dialog (blank page or import) on the open nest, or the last one open. */
  onNewDocument: () => void;
  /** With a nest open, its Connect dialog. Without one, the Docs page. */
  onConnect: () => void;
}) {
  const meta = useNestMeta(nestId ?? "");
  const { isAdmin, workflowPlaneEnabled, typeViewEnabled, agentStreamEnabled } = useAuth();
  const caps = useMemo(() => {
    const m: any = meta.data;
    if (!nestId || !m) return null;
    return deriveNestCaps({
      roles: m.roles ?? [],
      permission: m.permission ?? null,
      myStewards: m.myStewards ?? [],
      isOwner,
      isAdmin,
      readerMode: !!m.nest?.reader_mode,
      isArchived: isNestArchived(m.nest),
    });
  }, [nestId, meta.data, isOwner, isAdmin]);
  const queue = useQuery({
    ...reads.reviewQueue(nestId ?? ""),
    enabled: !!nestId && !!caps && !caps.isReadOnly && !caps.isReaderView,
  });
  const pending = queue.data?.total ?? queue.data?.requests?.length ?? 0;
  const viewNodes = useQuery({
    ...reads.viewNodes(nestId ?? ""),
    enabled: !!nestId && !!caps && !caps.isReaderView && typeViewEnabled,
  });
  const userViews: Array<{ id: string; title: string }> = useMemo(
    () =>
      (viewNodes.data?.nodes ?? [])
        .filter((n: any) => n?.type === "view")
        .map((n: any) => ({ id: String(n.id), title: String(n.title || n.id) })),
    [viewNodes.data],
  );
  const stewardshipEnabled = !!(meta.data as any)?.nest?.stewardship_enabled;
  // Channels are for people added to the nest; a share-only grantee or a
  // public reader gets no entry (GET /nests/:id `member`).
  const isMember = (meta.data as any)?.member === true;
  const views = useMemo(
    () =>
      caps
        ? nestSidebarViews(caps, {
          workflowPlaneEnabled,
          agentStreamEnabled,
          isMember,
          stewardshipEnabled,
          hasPending: pending > 0,
        })
        : [],
    [caps, workflowPlaneEnabled, agentStreamEnabled, isMember, stewardshipEnabled, pending],
  );
  // Dashboard: the nests to pick from.
  const nestList = useQuery({ ...reads.nestList(), enabled: !nestId });

  if (nestId && caps?.isReaderView) return null;

  const review = views.find((v) => v.id === "review");
  const grouped = views.filter((v) => v.group === "views");
  const viewActive =
    grouped.some((v) => v.id === activeView) ||
    activeView === "external-edits" ||
    userViews.some((v) => v.id === currentNodeId);
  const activeLabel =
    grouped.find((v) => v.id === activeView)?.label ??
    (activeView === "external-edits" ? "External edits" : undefined);
  const picker = (nestList.data?.nests ?? []).slice(0, MAX_PICKER);

  return (
    <div className="flex shrink-0 items-center gap-0.5" data-testid="top-bar-tools">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-9 gap-1.5 px-2 text-sm font-normal text-muted-foreground hover:text-accent-foreground lg:px-2.5",
              viewActive && "bg-accent font-medium text-accent-foreground",
            )}
            aria-label={activeLabel ? `Views, ${activeLabel}` : "Views"}
            data-testid="top-bar-views"
          >
            <LayoutGrid className="h-4 w-4 shrink-0" aria-hidden />
            <span className="hidden whitespace-nowrap lg:inline">{activeLabel ?? "Views"}</span>
            <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          {!nestId && (
            <>
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                Pick a nest to see its views
              </DropdownMenuLabel>
              {picker.length === 0 && (
                <DropdownMenuItem disabled>No nests yet</DropdownMenuItem>
              )}
              {picker.map((n: any) => (
                <DropdownMenuItem
                  key={n.id}
                  onSelect={() =>
                    onPickNest({ id: String(n.id), name: String(n.name ?? n.id), isOwner: !!n.is_owner })
                  }
                  className="cursor-pointer"
                  data-testid={`top-bar-nest-${n.id}`}
                >
                  <Home className="mr-2 h-3.5 w-3.5" />
                  {n.name ?? n.id}
                </DropdownMenuItem>
              ))}
            </>
          )}
          {nestId && (
            <>
              {views
                .filter((v) => v.id === "overview")
                .map((v) => (
                  <DropdownMenuItem
                    key={v.id}
                    onSelect={() => onOpen(v)}
                    className="cursor-pointer"
                    data-testid={`top-bar-view-${v.id}`}
                  >
                    <Home className="mr-2 h-3.5 w-3.5" />
                    Overview
                  </DropdownMenuItem>
                ))}
              {grouped.map((v) => {
                const Icon = v.icon ?? LayoutGrid;
                return (
                  <DropdownMenuItem
                    key={v.id}
                    onSelect={() => onOpen(v)}
                    className={cn("cursor-pointer", v.id === activeView && "bg-muted font-medium")}
                    data-testid={`top-bar-view-${v.id}`}
                  >
                    <Icon className="mr-2 h-3.5 w-3.5" />
                    {v.label}
                  </DropdownMenuItem>
                );
              })}
              {userViews.length > 0 && <DropdownMenuSeparator />}
              {userViews.map((v) => (
                <DropdownMenuItem
                  key={v.id}
                  onSelect={() => onOpenNode(v.id)}
                  className={cn("cursor-pointer", v.id === currentNodeId && "bg-muted font-medium")}
                  data-testid={`top-bar-userview-${v.id}`}
                >
                  <LayoutGrid className="mr-2 h-3.5 w-3.5" />
                  {v.title}
                </DropdownMenuItem>
              ))}
              {review && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => onOpen({ ...review, id: "external-edits" as any, label: "External edits", tab: "external-edits" as any })}
                    className={cn("cursor-pointer", activeView === "external-edits" && "bg-muted font-medium")}
                    data-testid="top-bar-view-external-edits"
                  >
                    <FileDiff className="mr-2 h-3.5 w-3.5" />
                    External edits
                  </DropdownMenuItem>
                </>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="sm"
        className="h-9 gap-1.5 px-2 text-sm font-normal text-muted-foreground hover:text-accent-foreground xl:px-2.5"
        onClick={onConnect}
        title="Connect a CLI, MCP client or API caller"
        aria-label="Connect"
        data-testid="top-bar-connect"
      >
        <Plug className="h-4 w-4 shrink-0" aria-hidden />
        <span className="hidden xl:inline">Connect</span>
      </Button>
      {/* Same button on every screen. With no nest open it acts on the one you
          last had open. Hidden only where the open nest is read-only. */}
      {(!nestId || (caps && !caps.isReadOnly && !caps.isReaderView && caps.canEditDocs)) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-9 gap-1.5 px-2 text-sm font-normal text-muted-foreground hover:text-accent-foreground xl:px-2.5"
          onClick={onNewDocument}
          title="New document — start blank or import files"
          aria-label="New document"
          data-testid="top-bar-new-document"
        >
          <Plus className="h-4 w-4 shrink-0" aria-hidden />
          <span className="hidden xl:inline">New document</span>
        </Button>
      )}
      {/* The open document's edit actions (Publish, Save draft, Submit) land
          here through a portal from DocumentEditor. */}
      <div id="top-bar-doc-actions" className="contents" />
    </div>
  );
}
