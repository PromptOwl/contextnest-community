/**
 * NestView — governance dashboard for a single nest.
 * Uses ported PromptOwl components for the UI, wired to REST API.
 */
import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from "react";
import * as api from "../lib/api";
import { matchesFilters } from "../lib/node-filter";
import { linkHealth } from "../lib/link-health";
import { parseServerDate, formatServerDate } from "../lib/dates";
import {
  datePresetToEpoch, upsertFilter, removeFilter,
  parseSavedFilters, serializeSavedFilters,
  type DatePreset, type SavedFilter,
} from "../lib/saved-filters";
import {
  FileText, FileCode2, Plus, ArrowLeft, History, Shield, Search, Upload, Sparkles,
  Clock, CheckCircle2, Send, Loader2, RefreshCw, Link2, Settings as SettingsIcon,
  Pencil, Trash2, FileWarning, Globe, Lock, FolderInput, Users,
  LayoutGrid, List as ListIcon, Star, X, MoreVertical,
  FolderOpen, ChevronRight, FileStack, Bot, Zap, FolderPlus, Wrench, Table2,
  Activity,
} from "lucide-react";
import { ConnectModal } from "./ConnectModal";
import { FolderTree, prettyFolder, prettyFolderPath } from "./FolderTree";
import { AuthorshipChips } from "./AuthorshipChips";

/** One icon per node type — agent/skill/artifact/document each read distinctly. */
export function NodeTypeIcon({
  type,
  className = "h-4 w-4",
}: {
  type?: string;
  className?: string;
}) {
  // Tinted chip per node type so the type reads at a glance in dense lists —
  // a bare gray glyph wasn't distinguishable when most rows are documents.
  const spec =
    type === "agent"
      ? { Icon: Bot, cls: "text-violet-600 dark:text-violet-400 bg-violet-500/10", label: "Agent" }
      : type === "skill"
        ? { Icon: Zap, cls: "text-blue-600 dark:text-blue-400 bg-blue-500/10", label: "Skill" }
        : type === "artifact"
          ? { Icon: FileCode2, cls: "text-amber-600 dark:text-amber-400 bg-amber-500/10", label: "Artifact" }
          : type === "tool"
            ? { Icon: Wrench, cls: "text-teal-600 dark:text-teal-400 bg-teal-500/10", label: "Tool" }
            : type === "table"
              ? { Icon: Table2, cls: "text-cyan-600 dark:text-cyan-400 bg-cyan-500/10", label: "Table" }
              : { Icon: FileText, cls: "text-slate-500 dark:text-slate-400 bg-slate-500/10", label: "Document" };
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md p-1 shrink-0 ${spec.cls}`}
      title={spec.label}
    >
      <spec.Icon className={className} />
    </span>
  );
}
import { GenerateContextModal } from "./GenerateContextModal";
import { NestSettingsModal } from "./NestSettingsModal";
import { ShareNestDialog } from "./ShareNestDialog";
import { DeleteNestDialog } from "./DeleteNestDialog";
import { RenameNestDialog } from "./RenameNestDialog";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Tabs, TabsList, TabsTrigger, TabsContent,
} from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OverflowMenu, type OverflowAction } from "@/components/ui/overflow-menu";
import {
  StewardList, StewardModal,
  ReviewQueue, ReviewActions,
  SubmitForReviewModal, ReasonDialog, VersionHistoryModal, LifecycleStatusBadge,
  type Steward, type StewardRole, type ReviewRequest, type Version,
  type DocumentLifecycleStatus,
} from "./governance";
import { useAuth } from "../auth/AuthContext";
import { MarkdownEditor } from "./MarkdownEditor";
import { CollaboratorManager } from "./CollaboratorManager";
import { toast } from "sonner";

function timeAgo(dateStr: string) {
  // See lib/dates — SQL-default timestamps carry no zone.
  const date = parseServerDate(dateStr);
  if (!date) return "";
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Compare paths segment-by-segment (not as flat strings) so children always
 *  sort directly under their parent — a sibling like "nodes-extra" would
 *  otherwise wedge between "nodes" and "nodes/a". */
function byPathSegments(a: string, b: string) {
  const as = a.split("/");
  const bs = b.split("/");
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const cmp = as[i].localeCompare(bs[i]);
    if (cmp !== 0) return cmp;
  }
  return as.length - bs.length;
}

interface NestViewProps {
  nestId: string;
  nestName: string;
  isOwner: boolean;
  isAnonOwned: boolean;
  onBack: () => void;
  onOpenDocument: (
    nodeId: string | "new",
    opts?: {
      folder?: string;
      /** Open the document with this comment thread focused (feed deep-link). */
      thread?: string;
    },
  ) => void;
  /** Open this nest's activity trace (owner/nest-admin only). */
  onOpenTrace?: () => void;
  /** Seed the search filter on mount. Used when arriving from a tag
   *  click on a document detail page. */
  initialSearch?: string;
}

export function NestView({
  nestId,
  nestName,
  isOwner,
  isAnonOwned,
  onBack,
  onOpenDocument,
  onOpenTrace,
  initialSearch,
}: NestViewProps) {
  const { isAdmin, adminStatus, authMode } = useAuth();
  // Mirror server delete rule (see src/nests/routes.ts DELETE /:nestId):
  //   - real-owner nest → only that owner
  //   - anon-owned + open mode → any caller (server treats anon as commons)
  //   - anon-owned + key mode → license-admin caretaker only
  const canDeleteNest =
    isOwner || (isAnonOwned && authMode !== "open" && isAdmin);
  const currentEmail = adminStatus?.me?.email?.toLowerCase() ?? "";

  // Local mirror of the nest name so inline rename feels instant while the
  // backend autosave lands. Resets if the parent passes a different nest.
  const [editableName, setEditableName] = useState(nestName);
  const lastSavedName = useRef(nestName);
  useEffect(() => {
    setEditableName(nestName);
    lastSavedName.current = nestName;
  }, [nestName, nestId]);
  const renameTimer = useRef<number | null>(null);
  const renameRef = useRef<() => void>(() => { });
  const [renameError, setRenameError] = useState<string | null>(null);
  renameRef.current = async () => {
    const trimmed = editableName.trim();
    if (!trimmed) return;
    if (trimmed === lastSavedName.current.trim()) return;
    try {
      await api.updateNest(nestId, { name: trimmed });
      lastSavedName.current = trimmed;
      setRenameError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to rename nest";
      setRenameError(msg);
    }
  };
  const scheduleRename = useCallback(() => {
    if (renameTimer.current) window.clearTimeout(renameTimer.current);
    renameTimer.current = window.setTimeout(() => {
      renameTimer.current = null;
      void renameRef.current();
    }, 1200);
  }, []);
  const flushRename = useCallback(() => {
    if (renameTimer.current) {
      window.clearTimeout(renameTimer.current);
      renameTimer.current = null;
    }
    void renameRef.current();
  }, []);
  useEffect(
    () => () => {
      if (renameTimer.current) window.clearTimeout(renameTimer.current);
    },
    [],
  );
  const [nodes, setNodes] = useState<any[]>([]);
  // Full roster — admin-only (listStewards 403s for non-admins → stays []).
  const [stewards, setStewards] = useState<Steward[]>([]);
  // Caller's OWN steward rows (scoped), from GET /nests/:id. Drives per-node
  // affordances for non-admin reviewers/editors who can't read the roster.
  const [myStewards, setMyStewards] = useState<Steward[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewRequest[]>([]);
  // Pending "please delete this" flags raised by people below admin.
  const [deletionRequests, setDeletionRequests] = useState<api.DeletionRequest[]>([]);
  // Node being flagged (dialog open when set), and the queue row being resolved
  // — `action` picks between the confirm and the decline-with-note dialog.
  const [deletionTarget, setDeletionTarget] = useState<any | null>(null);
  // Node pending a plain delete confirm (for callers who can delete outright).
  const [deleteNodeTarget, setDeleteNodeTarget] = useState<any | null>(null);
  const [removeStewardId, setRemoveStewardId] = useState<string | null>(null);
  // Folder pending deletion (admin) or a deletion request (everyone else).
  const [folderTarget, setFolderTarget] = useState<
    { path: string; label: string; total: number } | null
  >(null);
  // Non-owner asking for the whole nest to be deleted.
  const [nestFlagOpen, setNestFlagOpen] = useState(false);
  // Latest flag per node (the list arrives newest-first, so the first wins).
  // Pending drops the flag action and badges red; declined badges amber with
  // the resolver's note, and the doc can be flagged again. Document targets
  // only — a folder path could otherwise collide with a node id.
  const flagByNode = useMemo(() => {
    const map = new Map<string, api.DeletionRequest>();
    for (const r of deletionRequests)
      if ((r.targetType ?? "document") === "document" && !map.has(r.nodeId))
        map.set(r.nodeId, r);
    return map;
  }, [deletionRequests]);
  const pendingFolderFlags = useMemo(
    () =>
      new Set(
        deletionRequests
          .filter((r) => r.targetType === "folder" && r.status === "pending")
          .map((r) => r.nodeId),
      ),
    [deletionRequests],
  );
  const folderFlagPending = (path: string) => pendingFolderFlags.has(path);
  const nestFlagPending = deletionRequests.some(
    (r) => r.targetType === "nest" && r.status === "pending",
  );
  const pendingDeletions = useMemo(
    () => deletionRequests.filter((r) => r.status === "pending"),
    [deletionRequests],
  );
  const [resolveTarget, setResolveTarget] = useState<
    { request: api.DeletionRequest; action: "delete" | "decline" } | null
  >(null);
  // Comment activity (annotation threads + replies) for the feed, already
  // access-filtered server-side to docs the caller can read. Paged: the array
  // holds the pages fetched so far; feedCommentsTotal is the server's
  // authoritative counts.comments (array length undercounts once a nest
  // outgrows one page — the default limit caps a page at 50).
  const [feedComments, setFeedComments] = useState<api.FeedCommentItem[]>([]);
  const [feedCommentsTotal, setFeedCommentsTotal] = useState(0);
  const [feedLoadingMore, setFeedLoadingMore] = useState(false);
  // Feed filter chips: All (default) / Changes / Comments.
  const [feedFilter, setFeedFilter] = useState<"all" | "changes" | "comments">(
    "all",
  );
  const [externalEdits, setExternalEdits] = useState<api.ExternalEditEntry[]>([]);
  const [externalEditsLoading, setExternalEditsLoading] = useState(false);
  const [stewardshipEnabled, setStewardshipEnabled] = useState(false);
  const [allowSelfApprove, setAllowSelfApprove] = useState(false);
  const [primeOnlyReview, setPrimeOnlyReview] = useState(false);
  const [primeTags, setPrimeTags] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [visibilitySaving, setVisibilitySaving] = useState(false);
  const [isImported, setIsImported] = useState(false);
  // Caller's nest-level permission (from GET /nests/:id).
  const [permission, setPermission] = useState<string | null>(null);
  // Stewardship is governance of the commons / one's own nests, not a tool
  // server admins impose on other users' nests. So the steward roster,
  // assign-steward UI, and Settings modal are hidden when an admin views a
  // real user's nest. Delegation (mirrors server canManageStewards): the
  // nest owner or an admin collaborator also manages governance, so owners
  // can hand people-management to other admins.
  // Server admins resolve to "admin" on EVERY nest (resolveNestPermission),
  // so gate the delegated branch on !isAdmin — otherwise the roster/settings
  // UI would reappear for admins viewing other users' nests, which the rule
  // above deliberately hides.
  // `isOwner` is known synchronously (prop); include it so a non-admin owner
  // sees the governance UI on first render instead of flickering until the
  // async `permission` from GET /nests/:id resolves.
  const canManageGovernance =
    (isAdmin && (isOwner || isAnonOwned)) ||
    (!isAdmin && (isOwner || permission === "owner" || permission === "admin"));
  // Caller's merged effective roles (collaborator + steward), nest-wide.
  const [roles, setRoles] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [stewardScope, setStewardScope] = useState<
    "all" | "document" | "tag" | "nest"
  >("all");
  const [stewardRoleFilter, setStewardRoleFilter] = useState<
    "all" | StewardRole
  >("all");
  const [editingSteward, setEditingSteward] = useState<Steward | null>(null);
  const [loading, setLoading] = useState(true);
  // True only until the first successful fetch. Tab CONTENT gates on this, not
  // `loading`, so a background refetch (fired by the many mutation handlers)
  // never blanks already-rendered tabs back to a spinner.
  const [initialLoad, setInitialLoad] = useState(true);
  const [search, setSearch] = useState(initialSearch ?? "");
  // Multi-tag AND filter; toggled by clicking tag chips on list rows.
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const toggleTagFilter = (tag: string) =>
    setTagFilters((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [authorFilter, setAuthorFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<DatePreset>("any");
  // Document list sort: by title, last edited, or comment (annotation) count.
  const [sortMode, setSortMode] = useState<"name" | "edited" | "comments">(
    "name",
  );
  // Per-node comment (annotation thread) counts, for the "Most comments" sort.
  const [commentCounts, setCommentCounts] = useState<
    Record<string, { count: number; lastAt: string | null }>
  >({});
  // List vs cards, persisted per-browser (not per-nest — it's a reading pref).
  const [viewMode, setViewMode] = useState<"list" | "cards">(() => {
    try {
      return localStorage.getItem("nest:viewMode") === "cards"
        ? "cards"
        : "list";
    } catch {
      return "list";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("nest:viewMode", viewMode);
    } catch {
      /* ignore quota/availability */
    }
  }, [viewMode]);
  // Saved filters, persisted per nest.
  const savedKey = `nest:${nestId}:savedFilters`;
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>([]);
  useEffect(() => {
    try {
      setSavedFilters(parseSavedFilters(localStorage.getItem(savedKey)));
    } catch {
      setSavedFilters([]);
    }
  }, [savedKey]);
  const persistSaved = (next: SavedFilter[]) => {
    setSavedFilters(next);
    try {
      localStorage.setItem(savedKey, serializeSavedFilters(next));
    } catch {
      /* ignore quota/availability */
    }
  };
  const [showSaveFilter, setShowSaveFilter] = useState(false);
  const [saveFilterName, setSaveFilterName] = useState("");
  const saveCurrentFilter = () => {
    const name = saveFilterName.trim();
    if (!name) return;
    persistSaved(
      upsertFilter(savedFilters, {
        name,
        search: search || undefined,
        status: statusFilter !== "all" ? statusFilter : undefined,
        tags: tagFilters.length ? tagFilters : undefined,
        author: authorFilter !== "all" ? authorFilter : undefined,
        datePreset: dateFilter !== "any" ? dateFilter : undefined,
        type: typeFilter !== "all" ? typeFilter : undefined,
      }),
    );
    setSaveFilterName("");
    setShowSaveFilter(false);
  };
  const applySavedFilter = (f: SavedFilter) => {
    setSearch(f.search ?? "");
    setStatusFilter(f.status ?? "all");
    setTagFilters(f.tags ?? []);
    setAuthorFilter(f.author ?? "all");
    setDateFilter(f.datePreset ?? "any");
    setTypeFilter(f.type ?? "all");
  };
  const [reviewNode, setReviewNode] = useState<any | null>(null);
  const [submitNode, setSubmitNode] = useState<any | null>(null);
  const [versionNode, setVersionNode] = useState<any | null>(null);
  const [versionData, setVersionData] = useState<{
    versions: Version[];
    approvedVersion: number | null;
    currentVersion: number;
  }>({ versions: [], approvedVersion: null, currentVersion: 0 });
  const [showAssignSteward, setShowAssignSteward] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const importDirRef = useRef<HTMLInputElement>(null);
  const [newFolderPath, setNewFolderPath] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Folder-nesting ceiling. Mirrors the server's folderToSegments guard
  // (src/nodes/service.ts) — the leaf document doesn't count, only the folder
  // segments. Kept in sync by hand; the server stays authoritative.
  const MAX_FOLDER_DEPTH = 8;
  const newFolderDepth = newFolderPath
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean).length;
  const newFolderTooDeep = newFolderDepth > MAX_FOLDER_DEPTH;

  const createFolder = async () => {
    const folder = newFolderPath.trim().replace(/^\/+|\/+$/g, "");
    if (!folder) return;
    // Block deeper than the server allows before the round-trip, so the user
    // gets the reason inline instead of a swallowed 400.
    if (newFolderTooDeep) return;
    setCreatingFolder(true);
    try {
      // Folders are path-derived — seed one with a starter node so it appears
      // and is immediately usable. Nesting works via "parent/child".
      await api.createNode(nestId, {
        title: "Overview",
        content: `# ${folder.split("/").pop()}\n\nStart here.\n`,
        folder,
      });
      setNewFolderPath("");
      setShowNewFolder(false);
      fetchData();
    } catch (e: any) {
      console.error("[NestView] createFolder failed", e);
      toast.error(e?.message || "Failed to create folder");
    } finally {
      setCreatingFolder(false);
    }
  };
  const [showShare, setShowShare] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  // Rename dialog (name + description) — complements the inline header
  // rename, which only covers the name.
  const [showRename, setShowRename] = useState(false);
  const [nestDescription, setNestDescription] = useState<string | null>(null);

  // Documents-as-a-repo state: controlled tab (Overview folder clicks jump to
  // Documents), the folder the list is scoped to (null = whole nest, "" would
  // mean root-only but we scope by subtree), collapsed folder paths, and
  // drag-and-drop bookkeeping for moving docs between folders.
  const [activeTab, setActiveTab] = useState("overview");
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);

  /** Folder path of a node id ("" for docs directly under nodes/). */
  const folderOfNode = (id: string) => {
    const rel = id.startsWith("nodes/") ? id.slice(6) : id;
    const slash = rel.lastIndexOf("/");
    return slash > 0 ? rel.slice(0, slash) : "";
  };

  const openFolderInDocuments = (folder: string) => {
    setFolderFilter(folder);
    setActiveTab("documents");
  };

  const toggleFolderCollapsed = (path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  // Dragging over a collapsed folder header for a beat expands it, so a doc
  // can be dropped into a subfolder without aborting the drag to click.
  const dragExpandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelDragExpand = () => {
    if (dragExpandTimer.current) {
      clearTimeout(dragExpandTimer.current);
      dragExpandTimer.current = null;
    }
  };
  // Don't let a pending spring-open fire (and set state) after unmount.
  useEffect(() => cancelDragExpand, []);
  const scheduleDragExpand = (path: string) => {
    cancelDragExpand();
    dragExpandTimer.current = setTimeout(() => {
      dragExpandTimer.current = null;
      setCollapsedFolders((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }, 600);
  };

  /**
   * Move a document to another folder — the ONE mover behind both the
   * drag-and-drop drop handlers and the "Move to folder" menu dialog. The
   * server returns the node under its NEW id (moving rewrites the id); we
   * refetch the list rather than patching state, same as every other
   * mutation in this view, so the tree, folder groups, and counts all pick
   * up the new id in one pass. Returns true on success so the dialog knows
   * to close.
   */
  const handleMoveNode = async (nodeId: string, targetFolder: string) => {
    if (folderOfNode(nodeId) === targetFolder) return true; // already there
    const dest = targetFolder ? prettyFolderPath(targetFolder) : "nest root";
    // Processing indicator while the move is in flight — the drop can take a
    // beat (id rewrite + refetch), so show it on both the drop and dialog
    // paths. Reuse the same toast id so it swaps to success/error in place.
    const toastId = toast.loading(`Moving to ${dest}…`);
    try {
      const { node: moved, previousId } = await api.moveNode(
        nestId,
        nodeId,
        targetFolder,
      );
      const previousFolder = folderOfNode(previousId);
      toast.success(
        targetFolder ? `Moved to ${dest}` : "Moved to nest root",
        {
          id: toastId,
          // Undo = the same move call, back to where it came from. Must use
          // the NEW id (moved.id) — the old id no longer exists.
          action: {
            label: "Undo",
            onClick: async () => {
              try {
                await api.moveNode(nestId, moved.id, previousFolder);
                toast.success("Move undone");
                fetchData();
              } catch (err: any) {
                console.error("[NestView] undo move failed", nestId, moved.id, err);
                toast.error(err?.message || "Undo failed");
              }
            },
          },
          duration: 6000,
        },
      );
      fetchData();
      return true;
    } catch (err: any) {
      console.error("[NestView] moveNode failed", nestId, nodeId, targetFolder, err);
      toast.error(err?.message || "Move failed", { id: toastId });
      return false;
    }
  };

  const handleDropOnFolder = (targetFolder: string) => {
    const nodeId = dragNodeId;
    setDragNodeId(null);
    setDropFolder(null);
    cancelDragExpand();
    if (!nodeId) return;
    // Defer the move+refetch one tick. The move rewrites the node id, so the
    // refetch unmounts the row we just dragged; if that happens before the
    // browser fires `dragend` and tears down its drag session (which races
    // the move on a fast/local server), Chrome leaves the session half-open
    // and silently ignores the NEXT dragstart — drag "randomly" dies after a
    // successful move. Letting the current event loop finish first makes it
    // deterministic — a plain setTimeout(0) is enough; no drag library needed.
    setTimeout(() => void handleMoveNode(nodeId, targetFolder), 0);
  };

  // "Move to folder" menu dialog — the accessible, keyboard-reachable path
  // to the same move as drag-and-drop.
  const [moveTarget, setMoveTarget] = useState<any | null>(null);
  const [moveDest, setMoveDest] = useState("");
  const [movingDoc, setMovingDoc] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    // Each request is independently swallowed — if listNodes throws, we must
    // still apply stewardshipEnabled from the settings response. Previously a
    // single Promise.all + outer try/catch meant a node-list error silently
    // dropped the settings update, so toggling stewardship appeared to revert.
    const [nodesData, stewardsData, queueData, deletionData, settingsData, externalData, nestMeta, countsData, feedData] =
      await Promise.all([
        api.listNodes(nestId).catch((e) => {
          console.error("[NestView] listNodes failed", nestId, e);
          return { nodes: [] };
        }),
        api.listStewards(nestId).catch((e) => {
          console.error("[NestView] listStewards failed", nestId, e);
          return { stewards: [] };
        }),
        api.getReviewQueue(nestId).catch((e) => {
          console.error("[NestView] getReviewQueue failed", nestId, e);
          toast.error(e?.message || "Failed to load review queue");
          return { requests: [], total: 0 };
        }),
        // Pending AND declined in one call: pending drives the admin queue,
        // declined is how the person who asked learns the verdict.
        api.getDeletionRequests(nestId, "all").catch((e) => {
          console.error("[NestView] getDeletionRequests failed", nestId, e);
          return { requests: [] as api.DeletionRequest[], total: 0 };
        }),
        api.getNestSettings(nestId).catch((e) => {
          console.error("[NestView] getNestSettings failed", nestId, e);
          return {
            stewardship_enabled: false,
            allow_self_approve: false,
            prime_only_review: false,
            prime_tags: [] as string[],
          };
        }),
        api.listExternalEdits(nestId).catch((e) => {
          console.error("[NestView] listExternalEdits failed", nestId, e);
          return { entries: [], total: 0 };
        }),
        api.getNest(nestId).catch((e) => {
          console.error("[NestView] getNest failed", nestId, e);
          return null;
        }),
        api.getCommentCounts(nestId).catch((e) => {
          console.error("[NestView] getCommentCounts failed", nestId, e);
          return { counts: {} };
        }),
        // Comment side of the activity feed — deliberately NOT filter=all.
        // The server's change items are the RAW pending set, but this view
        // renders reviewableQueue: the review-queue response post-filtered
        // client-side by canReview + separation-of-duties (own submissions
        // get their own card). Fetching filter=all would return change rows
        // we'd have to re-filter and dedupe against that queue state, so the
        // client pulls comments only and lets ReviewQueue interleave them
        // with the already-filtered changes, using the same (createdAt, id)
        // ordering as the server merge. If reviewable filtering ever moves
        // server-side, collapse this into a single filter=all call.
        api.getNestFeed(nestId, "comments").catch((e) => {
          console.error("[NestView] getNestFeed failed", nestId, e);
          return {
            items: [] as api.FeedItem[],
            counts: { changes: 0, comments: 0 },
          };
        }),
      ]);
    setCommentCounts(countsData.counts);
    setNodes(nodesData.nodes);
    setStewards(stewardsData.stewards);
    setReviewQueue(queueData.requests);
    setDeletionRequests(deletionData.requests);
    const commentItems = feedData.items.filter(
      (i): i is api.FeedCommentItem => i.type === "comment",
    );
    setFeedComments(commentItems);
    // Authoritative total (an older server without counts falls back to the
    // page length, which is at least not wrong for single-page nests).
    setFeedCommentsTotal(feedData.counts?.comments ?? commentItems.length);
    setStewardshipEnabled(settingsData.stewardship_enabled);
    setAllowSelfApprove(settingsData.allow_self_approve);
    setPrimeOnlyReview(!!settingsData.prime_only_review);
    setPrimeTags(settingsData.prime_tags ?? []);
    setExternalEdits(externalData.entries);
    if (nestMeta?.nest?.visibility) {
      setVisibility(nestMeta.nest.visibility);
    }
    if (nestMeta?.nest) {
      setIsImported(!!(nestMeta.nest as any).is_imported);
      setNestDescription((nestMeta.nest as any).description ?? null);
    }
    if (nestMeta?.permission) {
      setPermission(nestMeta.permission);
    }
    setRoles(nestMeta?.roles ?? []);
    setMyStewards((nestMeta?.myStewards ?? []) as Steward[]);
    setLoading(false);
    setInitialLoad(false);
  }, [nestId]);

  // Next page of comment activity, appended under the feed. Offset by the
  // rows already shown; a dedupe guard drops any row that slid into the next
  // page because new comments landed above it between fetches.
  const loadMoreComments = useCallback(async () => {
    setFeedLoadingMore(true);
    try {
      const res = await api.getNestFeed(
        nestId,
        "comments",
        50,
        feedComments.length,
      );
      const fresh = res.items.filter(
        (i): i is api.FeedCommentItem => i.type === "comment",
      );
      setFeedComments((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...fresh.filter((c) => !seen.has(c.id))];
      });
      setFeedCommentsTotal(res.counts?.comments ?? res.total);
    } catch (e: any) {
      console.error("[NestView] getNestFeed load-more failed", nestId, e);
      toast.error(e?.message || "Failed to load more comments");
    } finally {
      setFeedLoadingMore(false);
    }
  }, [nestId, feedComments.length]);

  const refreshExternalEdits = useCallback(async () => {
    setExternalEditsLoading(true);
    try {
      await api.scanExternalEdits(nestId).catch((e) => {
        console.error("[NestView] scanExternalEdits failed", nestId, e);
        return null;
      });
      const { entries } = await api.listExternalEdits(nestId);
      setExternalEdits(entries);
    } finally {
      setExternalEditsLoading(false);
    }
  }, [nestId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // stats are built later (after reviewableQueue is computed) so the
  // Review Queue card can bind to the count the user can actually act
  // on — not the raw queue size.

  // Full-text CONTENT hits from the server search endpoint, unioned with
  // the instant client title/tag match below. Debounced; best-effort.
  const [contentHits, setContentHits] = useState<Set<string>>(new Set());
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) {
      setContentHits(new Set());
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const { nodes: hits } = await api.searchNodes(nestId, q);
        if (!cancelled) {
          setContentHits(new Set((hits as any[]).map((n) => n.id)));
        }
      } catch {
        /* fall back to client-side matching only */
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [nestId, search]);

  // Status + tag filters always apply; with a query, a doc passes on an
  // instant client title/tag match OR a server content hit. Semantics of
  // the client match live in lib/node-filter (unit-tested).
  const updatedAfter = datePresetToEpoch(dateFilter, Date.now());
  const filtered = nodes.filter((n) => {
    // Folder scope: the doc's folder must be the scoped folder or inside it.
    if (folderFilter !== null) {
      const f = folderOfNode(n.id || "");
      if (f !== folderFilter && !f.startsWith(`${folderFilter}/`)) return false;
    }
    if (
      !matchesFilters(n, {
        status: statusFilter,
        tags: tagFilters,
        author: authorFilter,
        updatedAfter,
        type: typeFilter,
      })
    )
      return false;
    if (!search) return true;
    return matchesFilters(n, { search }) || contentHits.has(n.id);
  });

  // Sort the filtered list. "name" = title A–Z; "edited" = most-recently
  // edited first (updated_at already on each node); "comments" = most comment
  // threads first, tie-broken by most recent comment then title.
  const sorted = [...filtered];
  if (sortMode === "edited") {
    sorted.sort((a, b) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
    );
  } else if (sortMode === "comments") {
    sorted.sort((a, b) => {
      const cb = commentCounts[b.id]?.count || 0;
      const ca = commentCounts[a.id]?.count || 0;
      if (cb !== ca) return cb - ca;
      const lb = commentCounts[b.id]?.lastAt || "";
      const la = commentCounts[a.id]?.lastAt || "";
      if (lb !== la) return String(lb).localeCompare(String(la));
      return String(a.title || "").localeCompare(String(b.title || ""));
    });
  } else {
    sorted.sort((a, b) =>
      String(a.title || "").localeCompare(String(b.title || "")),
    );
  }

  // Folder tree for the Documents list: sorted docs grouped by their FULL
  // folder path, groups ordered parent-before-child. depth drives indentation
  // (relative to the scoped folder when one is set); rendering skips any
  // group living under a collapsed ancestor.
  const baseFolder = folderFilter ?? "";
  const baseDepth = baseFolder ? baseFolder.split("/").length : 0;
  const docGroups = (() => {
    const groups = new Map<string, any[]>();
    for (const n of sorted) {
      const f = folderOfNode(n.id || "");
      if (!groups.has(f)) groups.set(f, []);
      groups.get(f)!.push(n);
    }
    return [...groups.entries()]
      .map(([folder, items]) => ({
        folder,
        depth: folder ? folder.split("/").length - baseDepth : 0,
        items,
      }))
      .sort((a, b) =>
        a.folder === "" ? -1 : b.folder === "" ? 1 : byPathSegments(a.folder, b.folder),
      );
  })();

  // Orphans + broken [[links]], client-side from the loaded list.
  const wikiHealth = useMemo(() => linkHealth(nodes), [nodes]);

  // Every folder path in use (all prefixes, so intermediate levels with no
  // direct docs still appear) — options for the Move-to-folder dialog.
  const allFolders = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) {
      const f = folderOfNode(n.id || "");
      if (!f) continue;
      const segs = f.split("/");
      for (let i = 1; i <= segs.length; i++) set.add(segs.slice(0, i).join("/"));
    }
    return [...set].sort(byPathSegments);
  }, [nodes]);

  // Distinct authors for the author filter dropdown.
  const authors = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) if (n.author) set.add(n.author);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [nodes]);

  // Distinct node types present (missing type = "document"), for the type
  // filter dropdown. Only offered when the nest actually mixes types.
  const typesPresent = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) set.add(n.type || "document");
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [nodes]);

  const hasActiveFilters =
    !!search ||
    statusFilter !== "all" ||
    typeFilter !== "all" ||
    tagFilters.length > 0 ||
    authorFilter !== "all" ||
    dateFilter !== "any";
  const clearAllFilters = () => {
    setSearch("");
    setStatusFilter("all");
    setTypeFilter("all");
    setTagFilters([]);
    setAuthorFilter("all");
    setDateFilter("any");
  };

  // Human-readable chips for every active filter, each with its own clear.
  // Tags keep their dedicated bar below, so they're not duplicated here.
  const STATUS_LABELS: Record<string, string> = {
    draft: "Draft",
    pending_review: "Pending",
    approved: "Approved",
    published: "Published",
    rejected: "Rejected",
  };
  const DATE_LABELS: Record<string, string> = {
    "7d": "Last 7 days",
    "30d": "Last 30 days",
    "90d": "Last 90 days",
    "1y": "Last year",
  };
  const TYPE_LABELS: Record<string, string> = {
    document: "Document",
    artifact: "Artifact",
    agent: "Agent",
    skill: "Skill",
  };
  // Colored pill for a non-document node type, shown on each list/card row so
  // the kind is scannable. `document` returns null (the default — no pill).
  const typePill = (
    t: string,
  ): { label: string; cls: string; title: string } | null => {
    switch (t) {
      case "artifact":
        return {
          label: "HTML",
          title: "Hosted HTML artifact",
          cls: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
        };
      case "agent":
        return {
          label: "Agent",
          title: "Runnable agent node",
          cls: "bg-violet-100 text-violet-800 dark:bg-violet-950/40 dark:text-violet-300",
        };
      case "skill":
        return {
          label: "Skill",
          title: "Runnable skill node",
          cls: "bg-sky-100 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
        };
      default:
        return null;
    }
  };
  const activeFilterChips: Array<{ label: string; clear: () => void }> = [];
  if (search)
    activeFilterChips.push({ label: `Search: ${search}`, clear: () => setSearch("") });
  if (statusFilter !== "all")
    activeFilterChips.push({
      label: `Status: ${STATUS_LABELS[statusFilter] ?? statusFilter}`,
      clear: () => setStatusFilter("all"),
    });
  if (typeFilter !== "all")
    activeFilterChips.push({
      label: `Type: ${TYPE_LABELS[typeFilter] ?? typeFilter}`,
      clear: () => setTypeFilter("all"),
    });
  if (authorFilter !== "all")
    activeFilterChips.push({
      label: `Author: ${authorFilter}`,
      clear: () => setAuthorFilter("all"),
    });
  if (dateFilter !== "any")
    activeFilterChips.push({
      label: `Edited: ${DATE_LABELS[dateFilter] ?? dateFilter}`,
      clear: () => setDateFilter("any"),
    });

  // All tags in the nest with usage counts — the always-visible filter bar.
  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of nodes) {
      for (const t of (n.tags ?? []) as string[]) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([tag, count]) => ({ tag, count }));
  }, [nodes]);

  // Quick-access strip; shown on the Overview tab as recently-edited rows.
  const recentlyEdited = useMemo(() => {
    return [...nodes]
      .filter((n) => n.updated_at)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, 3);
  }, [nodes]);

  // Genuine, non-capped metric for the Overview stat tile: how many documents
  // were edited in the last 7 days across the whole nest. The recentlyEdited
  // strip above is sliced to 3 for display, so its length is not a real count.
  const recentlyEditedCount = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return nodes.filter((n) => {
      if (!n.updated_at) return false;
      const t = Date.parse(String(n.updated_at));
      return !Number.isNaN(t) && t >= cutoff;
    }).length;
  }, [nodes]);

  // myStewards (caller's own scoped rows) comes from GET /nests/:id, so
  // non-admin reviewers/editors keep per-node affordances without reading the
  // admin-only roster.
  // All capability flags derived in one place from the caller's nest-wide
  // effective roles (collaborator + steward, merged server-side and returned
  // by GET /nests/:id) plus their collaborator permission. Coarse gating
  // reads these; the server still enforces per node.
  //   canManage     — assign stewards + share with collaborators (owner/admin)
  //   collabCanWrite — nest-wide write via a collaborator grant
  //   canReviewDocs  — approve/reject (owner/admin or reviewer steward)
  //   canEditDocs    — "New Document" (nest-wide write or nest-scope editor)
  //   isReadOnly     — no write/review/manage (public + plain 'read' collabs)
  const caps = (() => {
    const hasRole = (...r: string[]) => roles.some((x) => r.includes(x));
    const canManage = isOwner || isAdmin || hasRole("owner", "admin");
    const collabCanWrite =
      permission === "owner" || permission === "admin" || permission === "write";
    const canReviewDocs =
      canManage || myStewards.some((s) => s.role === "reviewer");
    const canEditDocs =
      canManage ||
      collabCanWrite ||
      myStewards.some((s) => s.role === "editor" && s.scope === "nest");
    const isReadOnly = !canEditDocs && !canReviewDocs && !canManage;
    return { canManage, collabCanWrite, canReviewDocs, canEditDocs, isReadOnly };
  })();
  // canReviewDocs is folded into isReadOnly inside caps; per-row review uses
  // canReviewNode for scope resolution, so it isn't destructured here.
  const { canManage, collabCanWrite, canEditDocs, isReadOnly } = caps;

  // Map nodeId → submitter so the per-row Review button can hide on
  // docs the current user submitted (separation-of-duties: authors must
  // not approve their own work). The server already rejects the call,
  // but hiding the affordance keeps the UI honest.
  const submitterByNode = new Map<string, string>();
  for (const r of reviewQueue) {
    submitterByNode.set(r.nodeId, r.requestedBy.toLowerCase());
  }
  // Does a steward row with `role` cover this node? Same scope-resolution
  // rules as the server: document scope matches by id, tag scope matches
  // when any of the node's tags match, nest scope matches everything.
  const hasRoleOnNode = (
    node: { id: string; tags?: string[] },
    role: string,
  ) =>
    myStewards.some((s) => {
      if (s.role !== role) return false;
      if (s.scope === "nest") return true;
      if (s.scope === "document") return s.nodePattern === node.id;
      if (s.scope === "tag") {
        const target = (s.tagName || "").toLowerCase().replace(/^#+/, "");
        return (node.tags || [])
          .map((t) => t.toLowerCase().replace(/^#+/, ""))
          .includes(target);
      }
      return false;
    });

  // Approval capability on a node (ignoring own-submission SoD, handled at
  // the call sites). Mirrors server canUserApprove:
  //   admin (collaborator/steward) -> approve anything
  //   reviewer steward (scoped)    -> approve covered nodes
  //   bare owner                   -> ONLY when the nest allows self-approve
  //                                   (else approvals go to reviewers)
  const canReviewNode = (node: { id: string; tags?: string[] }) => {
    if (!node) return false;
    if (isReadOnly) return false;
    if (isAdmin || roles.includes("admin")) return true;
    if (isOwner) return allowSelfApprove;
    if (hasRoleOnNode(node, "reviewer")) return true;
    return false;
  };

  // Per-node edit gate. Nest-wide writers (owner/admin or a write+
  // collaborator) edit any node; a doc/tag-scoped editor steward only edits
  // the nodes their scope covers — applying the coarse flag per row would
  // wrongly show Submit/Edit/Delete everywhere. Server still enforces.
  const canEditNode = (node: { id: string; tags?: string[] }) => {
    if (!node) return false;
    if (isReadOnly) return false;
    if (canManage || collabCanWrite) return true;
    return myStewards.some((s) => {
      if (s.role !== "editor") return false;
      if (s.scope === "nest") return true;
      if (s.scope === "document") return s.nodePattern === node.id;
      if (s.scope === "tag") {
        const target = (s.tagName || "").toLowerCase().replace(/^#+/, "");
        return (node.tags || [])
          .map((t) => t.toLowerCase().replace(/^#+/, ""))
          .includes(target);
      }
      return false;
    });
  };

  // Review queue: who can act on each request. The server stamps each request
  // with `canReview` via the authoritative canUserApprove (admin/owner/steward
  // scope + separation-of-duties), so we trust it rather than re-deriving
  // steward scope client-side — the client re-derivation diverged for a
  // reviewer-steward reaching the nest via public visibility, hiding the queue
  // and the Review button. Fall back to the client check only for an older
  // server that doesn't send the flag.
  const reviewableQueue = reviewQueue.filter((r) => {
    if (r.canReview !== undefined) return r.canReview;
    const node = nodes.find((n) => n.id === r.nodeId);
    if (!node) return false;
    if (!canReviewNode(node)) return false;
    const own = r.requestedBy.toLowerCase() === currentEmail;
    if (own && !(isOwner && allowSelfApprove)) return false;
    return true;
  });

  // Node ids the caller can review right now (authoritative, from the queue
  // annotation). Drives the per-row Review button so it stays in lockstep with
  // the in-document approve/reject affordance.
  const reviewableNodeIds = new Set(
    reviewableQueue.map((r) => r.nodeId),
  );

  // The caller's own pending submissions. SoD keeps these out of the
  // actionable queue above (authors can't approve their own work), which made
  // it look like "submit for review did nothing." Surface them in their own
  // section so the submitter sees their request IS queued. (CU-wdqcpztgwm)
  const myPendingSubmissions = reviewQueue.filter(
    (r) => r.requestedBy.toLowerCase() === currentEmail,
  );
  // Show the Review tab whenever stewardship is on, the caller can review
  // (reviewer steward / admin), OR there are pending requests at all —
  // otherwise a submitted edit is stranded with no tab (e.g. stewardship
  // later disabled, the submitter has no reviewer role, or a reviewer-steward
  // reached the nest via public visibility where the settings flag reads
  // false client-side).
  const showReviewTab =
    stewardshipEnabled ||
    caps.canReviewDocs ||
    reviewQueue.length > 0 ||
    // Deletion flags land in this tab too, and are raised on ungoverned nests
    // as often as governed ones.
    (caps.canManage && pendingDeletions.length > 0) ||
    // Comment activity renders in the same tab (the queue is now a feed) —
    // discussion must stay reachable even with stewardship off.
    feedCommentsTotal > 0;

  // Computed here so the Review Queue card binds to reviewableQueue.length
  // (what the user can actually act on) instead of reviewQueue.length
  // (raw size, which over-promised before — see CU-86ahn99fv).
  const stats = {
    total: nodes.length,
    pending: nodes.filter((n) => n.status === "pending_review").length,
    // "published" is the engine's terminal post-approve status (approve writes
    // 'published'; no-steward creates auto-publish) — both mean AI-visible,
    // so the AI Ready card counts them together.
    approved: nodes.filter(
      (n) => n.status === "approved" || n.status === "published",
    ).length,
    reviewQueue: reviewQueue.length,
    reviewable: reviewableQueue.length,
  };

  // Overview/index landing (CU-wdqcpztgwp): a grouped table-of-contents +
  // recently-edited, so opening a nest presents an index rather than only the
  // flat node list. Grouped by the node id's top-level folder.
  // NOTE: the engine also generates a canonical INDEX.md via regenerateIndex()
  // (excluded from the node list as a meta-file); surfacing that engine-built
  // index is a deeper follow-up — this is the lightweight UI overview.
  const tocGroups = (() => {
    // Group by the FULL folder path (everything before the leaf), not just
    // the first segment, so nested folders like nodes/gtm/deals each get
    // their own group. Sorting by path keeps children right under parents;
    // depth drives the header indent.
    const groups = new Map<string, any[]>();
    for (const n of nodes) {
      const id: string = n.id || "";
      // Strip the "nodes/" storage root — it's not a user folder. What's left
      // is the real folder path; a doc directly under nodes/ has none → Root.
      const rel = id.startsWith("nodes/") ? id.slice(6) : id;
      const slash = rel.lastIndexOf("/");
      const folder = slash > 0 ? rel.slice(0, slash) : "Root";
      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder)!.push(n);
    }
    return [...groups.entries()]
      .map(([folder, items]) => ({
        folder,
        depth: folder === "Root" ? 0 : folder.split("/").length,
        items: [...items].sort((a, b) =>
          String(a.title || a.id).localeCompare(String(b.title || b.id)),
        ),
      }))
      .sort((a, b) =>
        a.folder === "Root"
          ? -1
          : b.folder === "Root"
            ? 1
            : byPathSegments(a.folder, b.folder),
      );
  })();

  const openVersions = async (node: any) => {
    setVersionNode(node);
    try {
      const data = await api.getNodeVersions(nestId, node.id);
      setVersionData(data);
    } catch (e) {
      console.error("[NestView] getNodeVersions failed", nestId, node?.id, e);
    }
  };

  // Approve/reject/submit handlers used to await silently — a 403
  // (e.g. SoD block, no reviewer role, license required) threw past
  // setReviewNode(null), so the modal stayed open and the user saw
  // nothing happen. Surface the error via toast and refresh on success.
  const handleApprove = async (note?: string) => {
    if (!reviewNode) return;
    try {
      await api.approveNode(nestId, reviewNode.id, note);
      toast.success("Approved");
      setReviewNode(null);
      fetchData();
    } catch (err: any) {
      console.error("[NestView] approveNode failed", nestId, reviewNode?.id, err);
      toast.error(err?.message || "Approve failed");
    }
  };

  const handleReject = async (note: string) => {
    if (!reviewNode) return;
    try {
      await api.rejectNode(nestId, reviewNode.id, note);
      toast.success("Rejected");
      setReviewNode(null);
      fetchData();
    } catch (err: any) {
      console.error("[NestView] rejectNode failed", nestId, reviewNode?.id, err);
      toast.error(err?.message || "Reject failed");
    }
  };

  const handleSubmitReview = async (note: string, priority: string) => {
    if (!submitNode) return;
    try {
      await api.submitForReview(nestId, submitNode.id, note, priority);
      toast.success("Submitted for review");
      setSubmitNode(null);
      fetchData();
    } catch (err: any) {
      console.error("[NestView] submitForReview failed", nestId, submitNode?.id, err);
      toast.error(err?.message || "Submit failed");
    }
  };

  const handleRemoveSteward = async () => {
    const stewardId = removeStewardId!;
    try {
      await api.removeSteward(nestId, stewardId);
      fetchData();
    } catch (err: any) {
      console.error("[NestView] removeSteward failed", nestId, stewardId, err);
      throw err;
    }
  };

  const handleAssignSteward = async (data: any) => {
    // Modal returns scope + generic `target`. Backend's legacy shape expects
    // scope-specific fields: nodePattern (document) or tagName (tag).
    const { target, ...rest } = data;
    const payload: any = { ...rest };
    if (data.scope === "document") {
      payload.nodePattern = target;
    } else if (data.scope === "tag") {
      payload.tagName = target;
    }
    await api.assignSteward(nestId, payload);
    fetchData();
  };

  const handleSaveStewardRole = async (update: {
    scope: string;
    target?: string;
    role: StewardRole;
  }) => {
    if (!editingSteward) return;
    // Map the modal's generic `target` to the backend's scope-specific field.
    const payload: any = { role: update.role, scope: update.scope };
    if (update.scope === "document") payload.nodePattern = update.target;
    else if (update.scope === "tag") payload.tagName = update.target;
    await api.updateSteward(nestId, editingSteward.id, payload);
    toast.success("Steward updated");
    fetchData();
  };

  // Destructive and irreversible, so it confirms first — through the same
  // ReasonDialog the deletion-request flows use. Throwing keeps the failure
  // (423 review lock, 403) inside the dialog instead of a dead-end alert.
  const handleDeleteNode = async () => {
    const node = deleteNodeTarget;
    try {
      await api.deleteNode(nestId, node.id);
      fetchData();
    } catch (err: any) {
      console.error("[NestView] deleteNode failed", nestId, node?.id, err);
      throw err;
    }
  };

  // Flag a doc for deletion when you can't delete it yourself. Each handler
  // throws on failure so ReasonDialog shows the error and keeps the input.
  const handleRequestDeletion = async (reason: string) => {
    await api.requestNodeDeletion(nestId, deletionTarget!.id, reason);
    toast.success("Deletion requested — a nest admin will review it");
    fetchData();
  };

  // Folder: admins delete it outright (every doc under it), everyone else
  // raises a request. One handler — the dialog it came from set the mode.
  const handleFolderDeletion = async (reason: string) => {
    const folder = folderTarget!;
    if (canManage) {
      const { deleted } = await api.deleteFolder(nestId, folder.path);
      toast.success(
        `Deleted ${folder.label} — ${deleted} document${deleted === 1 ? "" : "s"}`,
      );
    } else {
      await api.requestTargetDeletion(nestId, "folder", folder.path, reason);
      toast.success("Deletion requested — a nest admin will review it");
    }
    fetchData();
  };

  const handleHonourDeletion = async () => {
    await api.approveDeletionRequest(nestId, resolveTarget!.request.id);
    toast.success("Document deleted");
    fetchData();
  };

  const handleDeclineDeletion = async (note: string) => {
    await api.declineDeletionRequest(nestId, resolveTarget!.request.id, note);
    toast.success("Request declined");
    fetchData();
  };

  // Inline visibility toggle from the header (owner/admin only). Optimistic
  // flip with revert on failure, mirroring ShareNestDialog so the control
  // never lies about server state. Surfaces the public/private switch outside
  // the Share dialog, where it was easy to miss. (CU-wdqcpztgwk)
  const handleVisibilityToggle = async () => {
    const next = visibility === "public" ? "private" : "public";
    setVisibility(next);
    setVisibilitySaving(true);
    try {
      const result = await api.setNestVisibility(nestId, next);
      if (result?.visibility) setVisibility(result.visibility);
    } catch (err: any) {
      setVisibility(next === "public" ? "private" : "public"); // revert
      toast.error(err?.message || "Failed to change visibility");
    } finally {
      setVisibilitySaving(false);
    }
  };

  // ── Drag-and-drop ingestion ────────────────────────────────────────────
  // Drop .md/.markdown/.txt → a markdown document; .html/.htm → a hosted HTML
  // artifact (commentable in the ArtifactViewer's Annotate pane). Title comes
  // from the filename. A single dropped file opens straight into its editor.
  const [dragOver, setDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const kindForFile = (name: string): "document" | "artifact" | null => {
    const ext = name.toLowerCase().split(".").pop() || "";
    if (ext === "html" || ext === "htm") return "artifact";
    if (ext === "md" || ext === "markdown" || ext === "txt") return "document";
    return null;
  };

  const importFiles = useCallback(
    async (fileList: FileList) => {
      const files = Array.from(fileList).filter((f) => kindForFile(f.name));
      const skipped = fileList.length - files.length;
      if (!files.length) {
        toast.error("Drop .md or .html files to add them to this vault.");
        return;
      }
      setImporting(true);
      const createdIds: string[] = [];
      try {
        for (const file of files) {
          const type = kindForFile(file.name)!;
          const title = file.name.replace(/\.(md|markdown|txt|html|htm)$/i, "");
          // Whole-vault import (webkitdirectory) carries relative paths —
          // keep the tree: strip the picked root dir + filename, the rest is
          // the folder. Hidden dirs (.versions, .context) are engine files.
          const rel = (file as any).webkitRelativePath as string | undefined;
          let folder: string | undefined;
          if (rel && rel.includes("/")) {
            const segs = rel.split("/").slice(1, -1);
            if (segs.some((seg) => seg.startsWith("."))) continue;
            // A vault's own "nodes/" root maps to our storage root, not a folder.
            folder = (segs[0] === "nodes" ? segs.slice(1) : segs).join("/") || undefined;
          }
          try {
            const text = await file.text();
            const res = await api.createNode(nestId, { title, content: text, type, folder });
            const id = (res as any)?.node?.id;
            if (id) createdIds.push(id);
          } catch (e: any) {
            toast.error(`${file.name}: ${e?.message || "failed to import"}`);
          }
        }
        if (createdIds.length) {
          toast.success(
            `Added ${createdIds.length} ${createdIds.length === 1 ? "item" : "items"}` +
            (skipped ? ` (skipped ${skipped} unsupported)` : ""),
          );
          await fetchData();
          if (createdIds.length === 1) onOpenDocument(createdIds[0]);
        }
      } finally {
        setImporting(false);
      }
    },
    [nestId, fetchData, onOpenDocument],
  );

  return (
    <div
      className="md:py-6 relative"
      onDragOver={(e) => {
        if (!canEditDocs) return;
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        // Only clear when leaving the whole region, not on child enter/leave.
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        if (!canEditDocs) return;
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files?.length) void importFiles(e.dataTransfer.files);
      }}
    >
      {/* Drop overlay — appears while dragging files over the vault. */}
      {dragOver && canEditDocs && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/5 backdrop-blur-[1px]">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="h-8 w-8" />
            <div className="text-sm font-medium">
              Drop to add to this vault
            </div>
            <div className="text-xs text-muted-foreground">
              .md → document · .html → hosted artifact
            </div>
          </div>
        </div>
      )}
      {importing && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-background/60">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Importing…
          </div>
        </div>
      )}
      {/* Header — PromptOwl ContextDashboard layout */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 sm:gap-4 mb-4">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} className="shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          {canManage ? (
            <div className="min-w-0 flex-1">
              <input
                value={editableName}
                onChange={(e) => {
                  setEditableName(e.target.value);
                  setRenameError(null);
                  scheduleRename();
                }}
                onBlur={flushRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    flushRename();
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === "Escape") {
                    setEditableName(lastSavedName.current);
                    setRenameError(null);
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                aria-label="Nest name"
                title="Click to rename — saved automatically"
                className="w-full min-w-0 truncate text-xl font-semibold bg-transparent outline-none border-b border-transparent hover:border-border focus:border-primary px-1 -ml-1 rounded-sm"
              />
              {renameError && (
                <p
                  role="alert"
                  className="mt-1 text-xs text-red-700"
                  title={renameError}
                >
                  {renameError}
                </p>
              )}
            </div>
          ) : (
            <h3 className="min-w-0 truncate text-xl font-semibold" title={nestName}>
              {nestName}
            </h3>
          )}
          {/* Visibility — an inline toggle for owner/admin (so the public/
              private switch isn't buried in the Share dialog), a read-only
              badge for everyone else. */}
          {canManage ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleVisibilityToggle}
              disabled={visibilitySaving}
              className={`shrink-0 h-7 gap-1.5 ${visibility === "public"
                ? "border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
                : ""
                }`}
              title={
                visibility === "public"
                  ? "Public — anyone with the URL can read. Click to make private."
                  : "Private. Click to make public (anyone with the URL can read)."
              }
            >
              {visibilitySaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : visibility === "public" ? (
                <Globe className="h-3.5 w-3.5" />
              ) : (
                <Lock className="h-3.5 w-3.5" />
              )}
              {visibility === "public" ? "Public" : "Private"}
            </Button>
          ) : (
            visibility === "public" && (
              <Badge
                variant="outline"
                className="shrink-0 gap-1 border-blue-200 bg-blue-50 text-blue-700"
                title="Anyone with the URL can read this nest"
              >
                <Globe className="h-3 w-3" />
                Public
              </Badge>
            )
          )}
          {isImported && (
            <Badge
              variant="outline"
              className="shrink-0 gap-1 border-blue-200 bg-blue-50 text-blue-700"
              title="Imported from a folder — its files were copied into the workspace"
            >
              <FolderInput className="h-3 w-3" />
              Imported
            </Badge>
          )}
        </div>
        {/* Action row: wraps onto multiple lines below sm-breakpoint instead
            of forcing a single horizontal scroll. `flex-wrap` + `justify-end`
            on wider screens keeps the spacing visually intentional rather
            than awkwardly clipped at the right edge. */}
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto sm:shrink-0 sm:justify-end">
          {/* Connect is the front door for every read/write surface (CLI,
              API, MCP, Add-with-AI) — a first-class button, not a menu item. */}
          <Button variant="outline" onClick={() => setShowConnect(true)}>
            <Link2 className="h-4 w-4 mr-2" />
            Connect
          </Button>
          {canManage && (
            <Button variant="outline" onClick={() => setShowShare(true)}>
              <Users className="h-4 w-4 mr-2" />
              Share
            </Button>
          )}
          {!isReadOnly && canEditDocs && (
            <>
              {/* Visible import affordance — same path as drag-and-drop.
                  Two inputs: loose files, or a whole vault folder (nested
                  paths preserved via webkitRelativePath). */}
              <input
                ref={importInputRef}
                type="file"
                multiple
                accept=".md,.markdown,.txt,.html,.htm"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.length) void importFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <input
                ref={importDirRef}
                type="file"
                className="hidden"
                // @ts-expect-error — non-standard but universal in practice
                webkitdirectory=""
                onChange={(e) => {
                  if (e.target.files?.length) void importFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" data-testid="nest-import-files">
                    <Upload className="h-4 w-4 mr-2" />
                    Import
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => importInputRef.current?.click()}>
                    Files (.md / .html)
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => importDirRef.current?.click()}>
                    Whole vault (folder, keeps structure)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button onClick={() => onOpenDocument("new")}>
                <Plus className="h-4 w-4 mr-2" />
                New Document
              </Button>
            </>
          )}
          {/* Secondary actions collapsed into an overflow menu at the end.
              Connect: view-only export/data-egress. Share: owner/admin only
              (server requires admin on /collaborators + /visibility). Delete:
              destructive, write+admin gated. */}
          {(() => {
            const actions: OverflowAction[] = [];
            // Same tier as the inline header rename (owner/nest-admin —
            // matches the server's PATCH /nests/:nestId guard); the dialog
            // additionally covers the description. Also gated on !loading:
            // isOwner is known synchronously (prop) but nestDescription only
            // lands with fetchData, so opening the dialog earlier would
            // prefill an empty description for a nest that has one.
            if (!isReadOnly && canManage && !loading)
              actions.push({
                label: "Rename nest",
                icon: Pencil,
                onSelect: () => {
                  // Flush any pending inline header rename first so the
                  // dialog primes from (and the server holds) the user's
                  // latest text instead of racing the 1200ms debounce.
                  flushRename();
                  setShowRename(true);
                },
              });
            if (!isReadOnly && canManageGovernance)
              actions.push({
                label: "Nest settings",
                icon: SettingsIcon,
                onSelect: () => setShowSettings(true),
              });
            // Gate on canManageGovernance (owner/admin on THIS nest), not the
            // server-admin flag — otherwise a license admin who is only an
            // editor collaborator here sees "Assign Steward" in the menu while
            // the Steward tab (also canManageGovernance-gated) stays hidden.
            if (!isReadOnly && stewardshipEnabled && canManageGovernance)
              actions.push({
                label: "Assign Steward",
                icon: Shield,
                onSelect: () => setShowAssignSteward(true),
              });
            // Nest-scoped activity trace — a read-only audit view, so not
            // gated on isReadOnly. Same owner/nest-admin rule as the server's
            // GET /nests/:id/trace (canManageStewards).
            if (canManageGovernance && onOpenTrace)
              actions.push({
                label: "Activity trace",
                icon: Activity,
                onSelect: onOpenTrace,
              });
            // One Delete entry, like a document's: the owner deletes the nest
            // outright, everyone else raises a request an owner/admin actions.
            // Hidden below owner once a nest flag is already pending.
            if (!isReadOnly && (canDeleteNest || !nestFlagPending))
              actions.push({
                label: "Delete",
                icon: Trash2,
                destructive: canDeleteNest,
                separatorBefore: true,
                onSelect: () =>
                  canDeleteNest ? setShowDelete(true) : setNestFlagOpen(true),
              });
            return <OverflowMenu actions={actions} variant="outline" />;
          })()}
        </div>
      </div>

      {/* Stats Cards — only governance-related stats when stewardship is on.
          In ungoverned mode every doc is auto-approved so the pending/review
          columns are always zero and just add noise. */}
      <div
        className={`grid grid-cols-1 gap-4 mb-6 ${stewardshipEnabled
          ? "md:grid-cols-4"
          : "md:grid-cols-1 max-w-sm"
          }`}
      >
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Documents</CardDescription>
            <CardTitle className="text-3xl">{stats.total}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <FileText className="h-4 w-4" />
              <span>
                {stewardshipEnabled ? "In your context" : "Auto-approved, AI-ready"}
              </span>
            </div>
          </CardContent>
        </Card>
        {stewardshipEnabled && (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Pending Review</CardDescription>
                <CardTitle className="text-3xl text-amber-600">{stats.pending}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  <span>Awaiting approval</span>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>AI Ready</CardDescription>
                <CardTitle className="text-3xl text-green-600">{stats.approved}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>Approved for AI</span>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Review Queue</CardDescription>
                <CardTitle className="text-3xl text-blue-600">
                  {stats.reviewable}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Shield className="h-4 w-4" />
                  <span>
                    Need your review
                    {stats.reviewQueue > stats.reviewable && (
                      <span className="ml-1 text-xs">
                        ({stats.reviewQueue} pending total,
                        {" "}
                        {stats.reviewQueue - stats.reviewable} outside your scope)
                      </span>
                    )}
                  </span>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Tabbed layout — Documents / Review Queue / Stewards.
          When stewardship is off the latter two tabs are hidden because
          their data is empty by definition. */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        {/* New Folder sits beside the tab row — it acts on the content area
            below (Overview/Documents), not on the nest as a whole. */}
        <div className="flex items-center gap-2 mb-4">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="documents">Documents</TabsTrigger>
            {/* Governance tabs hidden for view-only. */}
            {showReviewTab && !isReadOnly && (
              <TabsTrigger value="review" className="gap-2">
                Review Queue
                {reviewableQueue.length > 0 && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    {reviewableQueue.length}
                  </Badge>
                )}
              </TabsTrigger>
            )}
            {!isReadOnly && (
              <TabsTrigger value="external-edits" className="gap-2">
                External Edits
                {externalEdits.length > 0 && (
                  <Badge
                    variant="secondary"
                    className="text-[10px] px-1.5 py-0 bg-orange-100 text-orange-700"
                  >
                    {externalEdits.length}
                  </Badge>
                )}
              </TabsTrigger>
            )}
            {/* Steward roster is admin-only (list + manage), and hidden when
              the admin is viewing a real user's nest. */}
            {stewardshipEnabled && canManageGovernance && (
              <TabsTrigger value="stewards">Stewards</TabsTrigger>
            )}
            {/* Collaborators — plain access sharing, independent of
              stewardship. Owner/admin manage the full roster; write
              collaborators can invite (escalation-capped server-side), so
              they see the tab too. The roster controls cap themselves by the
              caller's permission (see CollaboratorManager). */}
            {(canManage || collabCanWrite) && (
              <TabsTrigger value="collaborators">Collaborators</TabsTrigger>
            )}
          </TabsList>
          {!isReadOnly && canEditDocs && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto text-muted-foreground"
              onClick={() => setShowNewFolder(true)}
              title="Create a folder (nest with parent/child)"
            >
              <FolderPlus className="h-4 w-4 mr-1.5" />
              New Folder
            </Button>
          )}
        </div>

        {/* Overview — the nest's index/landing: stat tiles, recently-edited
            rows, and a grouped table-of-contents grid so opening a nest
            presents an index rather than just the flat node list. */}
        <TabsContent value="overview" className="space-y-4">
          {initialLoad ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* Stat tiles — only the metrics NOT already in the top stat
                  cards (Total Documents / AI Ready live there). This row adds
                  folder + recency context, so nothing is repeated. */}
              <div className="grid gap-3 grid-cols-2">
                <Card className="border-muted/60">
                  <CardContent className="p-4 flex items-center gap-3">
                    <div className="rounded-md bg-blue-500/10 text-blue-600 p-2">
                      <FolderOpen className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="text-2xl font-semibold leading-none">
                        {tocGroups.length}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        Folder{tocGroups.length === 1 ? "" : "s"}
                      </div>
                    </div>
                  </CardContent>
                </Card>
                <Card className="border-muted/60">
                  <CardContent className="p-4 flex items-center gap-3">
                    <div className="rounded-md bg-amber-500/10 text-amber-600 p-2">
                      <Clock className="h-4 w-4" />
                    </div>
                    <div>
                      <div className="text-2xl font-semibold leading-none">
                        {recentlyEditedCount}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        Edited this week
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Recently edited */}
              {recentlyEdited.length > 0 && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Clock className="h-4 w-4 text-muted-foreground" />
                      Recently edited
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <ul className="divide-y">
                      {recentlyEdited.map((n) => (
                        <li key={n.id}>
                          <button
                            onClick={() => onOpenDocument(n.id)}
                            className="w-full flex items-center gap-3 py-2 px-1 -mx-1 rounded hover:bg-muted/50 text-left group"
                          >
                            <NodeTypeIcon type={n.type} />
                            <span className="text-sm truncate flex-1">
                              {n.title || n.id}
                            </span>
                            {(() => {
                              const p = typePill(n.type || "document");
                              return p ? (
                                <span
                                  className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${p.cls}`}
                                  title={p.title}
                                >
                                  {p.label}
                                </span>
                              ) : null;
                            })()}
                            {n.updated_at && (
                              <span className="text-xs text-muted-foreground shrink-0">
                                {timeAgo(n.updated_at)}
                              </span>
                            )}
                            <ChevronRight className="h-4 w-4 text-muted-foreground/40 group-hover:text-muted-foreground shrink-0" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}

              {/* Grouped table of contents */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <FolderOpen className="h-4 w-4 text-muted-foreground" />
                    Contents
                  </CardTitle>
                  <CardDescription>
                    Browse documents grouped by folder.
                  </CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                  {tocGroups.length === 0 ? (
                    <div className="py-8 text-center">
                      <FileText className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
                      <p className="text-sm text-muted-foreground">
                        No documents yet. Create one from the Documents tab.
                      </p>
                    </div>
                  ) : (
                    <FolderTree
                      className="space-y-1"
                      groups={tocGroups}
                      renderFolder={(node) => (
                        // Overview folders navigate into the Documents tab scoped to
                        // that folder — no collapse here; the whole tree stays open.
                        <button
                          type="button"
                          onClick={() => openFolderInDocuments(node.path)}
                          className="flex items-center gap-2 py-1 group/folder rounded px-1 -mx-1 hover:bg-muted/60 w-full text-left"
                          title={`Browse ${prettyFolderPath(node.path)} in Documents`}
                        >
                          <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                          <span className="text-sm font-medium group-hover/folder:underline">
                            {node.label}
                          </span>
                          <Badge
                            variant="secondary"
                            className="text-[10px] px-1.5 py-0 h-5"
                          >
                            {node.total}
                          </Badge>
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 group-hover/folder:text-muted-foreground" />
                          {canEditDocs && (
                            <span
                              role="button"
                              tabIndex={0}
                              className="rounded p-0.5 text-muted-foreground opacity-0 group-hover/folder:opacity-100 hover:text-primary hover:bg-primary/10"
                              title={`New document in ${prettyFolderPath(node.path)}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenDocument("new", { folder: node.path });
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.stopPropagation();
                                  onOpenDocument("new", { folder: node.path });
                                }
                              }}
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </span>
                          )}
                        </button>
                      )}
                      renderDoc={(n) => (
                        <button
                          onClick={() => onOpenDocument(n.id)}
                          className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-muted/50 text-left group min-w-0 w-full"
                          title={n.title || n.id}
                        >
                          <NodeTypeIcon type={n.type} className="h-3.5 w-3.5" />
                          <span className="text-sm truncate flex-1">
                            {n.title || n.id}
                          </span>
                          {(() => {
                            const p = typePill(n.type || "document");
                            return p ? (
                              <span
                                className={`shrink-0 rounded px-1 py-px text-[9px] font-semibold uppercase tracking-wide ${p.cls}`}
                                title={p.title}
                              >
                                {p.label}
                              </span>
                            ) : null;
                          })()}
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 group-hover:text-muted-foreground shrink-0" />
                        </button>
                      )}
                    />
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="documents" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3">
                <CardTitle className="text-lg">Documents</CardTitle>
                <div className="flex flex-wrap items-center gap-2 w-full">
                  <div className="relative flex-1 min-w-[12rem] sm:flex-none sm:w-80">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                    <Input
                      placeholder="Search title, tags, content…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="pl-9 pr-12 w-full h-8"
                    />
                    <kbd
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground border rounded px-1 pointer-events-none"
                      title="Quick open"
                    >
                      ⌘K
                    </kbd>
                  </div>
                  {stewardshipEnabled && (
                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                      <SelectTrigger className="w-[140px] h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Status</SelectItem>
                        <SelectItem value="draft">Draft</SelectItem>
                        <SelectItem value="pending_review">Pending</SelectItem>
                        <SelectItem value="approved">Approved</SelectItem>
                        <SelectItem value="published">Published</SelectItem>
                        <SelectItem value="rejected">Rejected</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                  {typesPresent.length > 1 && (
                    <Select value={typeFilter} onValueChange={setTypeFilter}>
                      <SelectTrigger className="w-[130px] h-8" title="Filter by type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All types</SelectItem>
                        {typesPresent.map((t) => (
                          <SelectItem key={t} value={t}>
                            {TYPE_LABELS[t] ?? t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {authors.length > 1 && (
                    <Select value={authorFilter} onValueChange={setAuthorFilter}>
                      <SelectTrigger className="w-[150px] h-8" title="Filter by author">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All authors</SelectItem>
                        {authors.map((a) => (
                          <SelectItem key={a} value={a}>
                            {a}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Select
                    value={dateFilter}
                    onValueChange={(v) => setDateFilter(v as DatePreset)}
                  >
                    <SelectTrigger className="w-[140px] h-8" title="Filter by last edited">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Any time</SelectItem>
                      <SelectItem value="7d">Last 7 days</SelectItem>
                      <SelectItem value="30d">Last 30 days</SelectItem>
                      <SelectItem value="90d">Last 90 days</SelectItem>
                      <SelectItem value="1y">Last year</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={sortMode}
                    onValueChange={(v) =>
                      setSortMode(v as "name" | "edited" | "comments")
                    }
                  >
                    <SelectTrigger className="w-[150px] h-8" title="Sort documents">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="name">Name (A–Z)</SelectItem>
                      <SelectItem value="edited">Recently edited</SelectItem>
                      <SelectItem value="comments">Most comments</SelectItem>
                    </SelectContent>
                  </Select>
                  {/* List vs cards density toggle. */}
                  <div className="flex items-center rounded-md border h-8">
                    <button
                      type="button"
                      title="List view"
                      aria-pressed={viewMode === "list"}
                      className={`px-2 h-full rounded-l-md ${viewMode === "list" ? "bg-muted" : "hover:bg-muted/50"
                        }`}
                      onClick={() => setViewMode("list")}
                    >
                      <ListIcon className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      title="Card view"
                      aria-pressed={viewMode === "cards"}
                      className={`px-2 h-full rounded-r-md ${viewMode === "cards" ? "bg-muted" : "hover:bg-muted/50"
                        }`}
                      onClick={() => setViewMode("cards")}
                    >
                      <LayoutGrid className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {/* Folder breadcrumb — shown when the list is scoped to a folder
                  (via an Overview folder click). Each crumb re-scopes; the
                  first crumb clears back to the whole nest. */}
              {folderFilter !== null && (
                <div className="flex items-center flex-wrap gap-1 mb-3 text-sm">
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => setFolderFilter(null)}
                  >
                    All documents
                  </button>
                  {folderFilter.split("/").map((seg, i, arr) => {
                    const path = arr.slice(0, i + 1).join("/");
                    const isLast = i === arr.length - 1;
                    return (
                      <Fragment key={path}>
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
                        {isLast ? (
                          <span className="font-medium flex items-center gap-1">
                            <FolderOpen className="h-4 w-4 text-blue-500" />
                            {prettyFolder(seg)}
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="text-primary hover:underline"
                            onClick={() => setFolderFilter(path)}
                          >
                            {prettyFolder(seg)}
                          </button>
                        )}
                      </Fragment>
                    );
                  })}
                  <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0 h-5">
                    {filtered.length}
                  </Badge>
                  {canEditDocs && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-muted-foreground ml-1"
                      onClick={() => onOpenDocument("new", { folder: folderFilter })}
                      title={`New document in this folder`}
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" /> New here
                    </Button>
                  )}
                </div>
              )}
              {/* Saved filters — one-click apply of a named filter snapshot.
                  Persisted per nest in localStorage. */}
              {savedFilters.length > 0 && (
                <div className="flex items-center flex-wrap gap-1.5 mb-2 text-xs">
                  <span className="text-muted-foreground">Saved:</span>
                  {savedFilters.map((f) => (
                    <span
                      key={f.name}
                      className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 hover:bg-muted"
                    >
                      <button
                        type="button"
                        className="inline-flex items-center gap-1"
                        onClick={() => applySavedFilter(f)}
                        title={`Apply saved filter "${f.name}"`}
                      >
                        <Star className="h-3 w-3 text-amber-500" />
                        {f.name}
                      </button>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() =>
                          persistSaved(removeFilter(savedFilters, f.name))
                        }
                        title={`Delete saved filter "${f.name}"`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {/* Active filters — what's currently narrowing the list, each
                  removable. Save the whole set, or clear it. */}
              {hasActiveFilters && (
                <div className="flex items-center flex-wrap gap-1.5 mb-3 text-xs">
                  <span className="text-muted-foreground">Active filters:</span>
                  {activeFilterChips.map((c) => (
                    <span
                      key={c.label}
                      className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5"
                    >
                      {c.label}
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={c.clear}
                        title="Remove this filter"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  {tagFilters.length > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                      Tags: {tagFilters.join(", ")}
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => setTagFilters([])}
                        title="Remove tag filters"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setShowSaveFilter(true)}
                  >
                    <Star className="h-3 w-3 mr-1" />
                    Save filter
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-muted-foreground"
                    onClick={clearAllFilters}
                  >
                    Clear all
                  </Button>
                </div>
              )}
              {/* Tag filter bar — every tag in the nest, clickable; active
                  tags AND together. The primary filter surface. */}
              {allTags.length > 0 && (
                <div className="flex items-center flex-wrap gap-1.5 mb-3 text-xs">
                  <span className="text-muted-foreground">Tags:</span>
                  {allTags.slice(0, 14).map(({ tag, count }) => {
                    const active = tagFilters.includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors ${active
                          ? "bg-primary text-primary-foreground border-primary"
                          : "text-foreground/80 hover:bg-muted"
                          }`}
                        onClick={() => toggleTagFilter(tag)}
                        title={
                          active
                            ? `Remove filter ${tag}`
                            : `Filter by ${tag}`
                        }
                      >
                        {tag}
                        <span
                          className={
                            active
                              ? "text-primary-foreground/80"
                              : "text-muted-foreground"
                          }
                        >
                          {active ? "×" : count}
                        </span>
                      </button>
                    );
                  })}
                  {allTags.length > 14 && (
                    <span className="text-muted-foreground">
                      +{allTags.length - 14} more
                    </span>
                  )}
                  {tagFilters.length > 0 && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:underline ml-1"
                      onClick={() => setTagFilters([])}
                    >
                      clear
                    </button>
                  )}
                </div>
              )}
              {recentlyEdited.length > 0 && (
                <div className="flex items-center flex-wrap gap-1.5 mb-3 text-xs">
                  <span className="text-muted-foreground">Recently edited:</span>
                  {recentlyEdited.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 hover:bg-muted truncate max-w-[180px] ${n.type === "artifact"
                          ? "border-amber-300 text-amber-700 dark:text-amber-300"
                          : "text-primary"
                        }`}
                      onClick={() => onOpenDocument(n.id)}
                    >
                      {n.type === "artifact" && (
                        <FileCode2 className="h-3 w-3 shrink-0" />
                      )}
                      <span className="truncate">{n.title}</span>
                    </button>
                  ))}
                </div>
              )}
              {initialLoad ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : filtered.length === 0 ? (
                hasActiveFilters || !canEditDocs ? (
                  <div className="text-center py-8 text-sm text-muted-foreground">
                    {hasActiveFilters ? "No matching documents" : "No documents yet"}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => importInputRef.current?.click()}
                    className="w-full flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border py-10 text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                  >
                    <Upload className="h-7 w-7" />
                    <div className="text-sm font-medium">
                      Drag files here, or click to import
                    </div>
                    <div className="text-xs">
                      .md → document · .html → hosted artifact
                    </div>
                  </button>
                )
              ) : (() => {
                // Shared row renderer: flat grid in cards mode, folder tree
                // (with drag-and-drop moves) in list mode.
                const renderDocRow = (node: any, indent = 0) => {
                  const cards = viewMode === "cards";
                  // Hosted HTML artifacts get a distinct icon + badge so they
                  // read differently from markdown documents in the list.
                  const nodeType = node.type || "document";
                  const nodePill = typePill(nodeType);
                  const canSubmit =
                    stewardshipEnabled &&
                    node.status === "draft" &&
                    canEditNode(node);
                  // Show Review when the server says this caller can review
                  // this node (authoritative reviewable set, from the queue's
                  // canUserApprove annotation — includes admin/owner/steward
                  // scope + separation-of-duties). This replaced a client-side
                  // steward-scope re-derivation that diverged for a reviewer-
                  // steward reaching the nest via public visibility, hiding the
                  // button even though the in-doc approve/reject showed it.
                  // Fall back to the client check for an older server that
                  // doesn't stamp canReview.
                  const canReview = reviewableNodeIds.has(node.id)
                    ? true
                    : node.status === "pending_review" &&
                    canReviewNode(node) &&
                    (submitterByNode.get(node.id) !== currentEmail ||
                      (isOwner && allowSelfApprove));
                  const canEdit =
                    node.status !== "pending_review" && canEditNode(node);
                  // Deleting is a nest admin/owner call — an editor who can
                  // write this doc still goes through the request queue. Same
                  // tier the document view uses for its Delete/Request split.
                  // Exception: your own document. Asking permission to delete
                  // work you wrote is the wrong default; the queue is for
                  // someone else's content.
                  const authoredByMe =
                    !!node.author &&
                    !!currentEmail &&
                    node.author.toLowerCase() === currentEmail;
                  const canDelete = canManage || authoredByMe;
                  const flag = flagByNode.get(node.id);
                  const flagPending = flag?.status === "pending";
                  // ONE Delete action for everyone. Admins get the delete
                  // confirm, everyone else gets the request dialog — which one
                  // opens is the dialog's job to explain, not two menu items'.
                  // Hidden below admin once a flag is open (a second 409s).
                  const showDeleteAction = canDelete || !flagPending;
                  const openDeleteFlow = () =>
                    canDelete ? setDeleteNodeTarget(node) : setDeletionTarget(node);
                  // Move (drag OR menu) mirrors the edit gate's stewardship
                  // scope. The pending-review freeze is NOT absolute: the
                  // server's move guard lets anyone approve-capable through
                  // (owner/admin/reviewer on the node, no self-approve check),
                  // so reorganizing an under-review doc stays possible.
                  const canMove =
                    canEditNode(node) &&
                    (node.status !== "pending_review" ||
                      isOwner ||
                      isAdmin ||
                      roles.includes("admin") ||
                      hasRoleOnNode(node, "reviewer"));
                  const openMoveDialog = () => {
                    setMoveDest(folderOfNode(node.id));
                    setMoveTarget(node);
                  };
                  // A doc row is a drop proxy for the folder it sits in: drag
                  // active, not onto itself, and the dragged doc isn't already
                  // in this row's folder. List mode only (cards aren't draggable).
                  const dropOntoRowValid = () =>
                    !cards &&
                    !!dragNodeId &&
                    dragNodeId !== node.id &&
                    folderOfNode(dragNodeId) !== folderOfNode(node.id);
                  // Cards: collapse every row action into a 3-dot menu kept on
                  // the title line. List keeps inline hover buttons below.
                  const actionMenu = (
                    <div onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 flex-shrink-0"
                            title="Actions"
                          >
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-40">
                          {canEdit && (
                            <DropdownMenuItem onSelect={() => onOpenDocument(node.id)}>
                              <Pencil className="h-3.5 w-3.5 mr-2" />
                              Edit
                            </DropdownMenuItem>
                          )}
                          {canMove && (
                            <DropdownMenuItem onSelect={openMoveDialog}>
                              <FolderInput className="h-3.5 w-3.5 mr-2" />
                              Move to folder
                            </DropdownMenuItem>
                          )}
                          {canSubmit && (
                            <DropdownMenuItem onSelect={() => setSubmitNode(node)}>
                              <Send className="h-3.5 w-3.5 mr-2" />
                              Submit for review
                            </DropdownMenuItem>
                          )}
                          {canReview && (
                            <DropdownMenuItem onSelect={() => setReviewNode(node)}>
                              <CheckCircle2 className="h-3.5 w-3.5 mr-2" />
                              Review
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onSelect={() => openVersions(node)}>
                            <History className="h-3.5 w-3.5 mr-2" />
                            History
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {showDeleteAction && (
                            <DropdownMenuItem
                              onSelect={openDeleteFlow}
                              className={
                                canDelete
                                  ? "text-destructive focus:text-destructive"
                                  : undefined
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  );
                  return (
                    <div
                      key={node.id}
                      onClick={() => onOpenDocument(node.id)}
                      className={`${cards
                        ? "flex flex-col gap-2"
                        : "flex items-center gap-3"
                        } p-3 rounded-lg border hover:bg-muted/50 transition-colors group cursor-pointer ${dragNodeId === node.id ? "opacity-40" : ""
                        }`}
                      style={!cards && indent ? { marginLeft: `${indent * 1.25}rem` } : undefined}
                      draggable={!cards && canMove}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", node.id);
                        e.dataTransfer.effectAllowed = "move";
                        setDragNodeId(node.id);
                      }}
                      onDragEnd={() => {
                        setDragNodeId(null);
                        setDropFolder(null);
                        cancelDragExpand();
                      }}
                      onDragOver={(e) => {
                        // Dropping onto a document means "into the folder that
                        // holds it" — a doc row is a proxy target for its own
                        // folder, so the drop zone isn't just the folder header.
                        if (!dropOntoRowValid()) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                      }}
                      onDragEnter={() => {
                        if (dropOntoRowValid()) setDropFolder(folderOfNode(node.id));
                      }}
                      onDrop={(e) => {
                        if (!dropOntoRowValid()) return;
                        e.preventDefault();
                        e.stopPropagation();
                        handleDropOnFolder(folderOfNode(node.id));
                      }}
                      data-testid={`document-row-${node.id}`}
                    >
                      {!cards && <NodeTypeIcon type={node.type} className="h-5 w-5" />}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          {cards && <NodeTypeIcon type={node.type} className="h-4 w-4" />}
                          <span
                            className="font-medium truncate min-w-0"
                            title={node.title}
                          >
                            {node.title}
                          </span>
                          {nodePill && (
                            <span
                              className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${nodePill.cls}`}
                              title={nodePill.title}
                            >
                              {nodePill.label}
                            </span>
                          )}
                          <LifecycleStatusBadge
                            status={(node.status as DocumentLifecycleStatus) || "draft"}
                            size="sm"
                            className="shrink-0 whitespace-nowrap"
                          />
                          {/* Pending only — see the note in DocumentEditor: a
                              declined flag is history, and history belongs in
                              the notification (dismissible), not a permanent
                              badge on a document that was kept. */}
                          {/* Prime — the doc always needs approval, whoever
                              edits it. Only meaningful in a governed nest. */}
                          {stewardshipEnabled &&
                            api.isPrimeNode(node, primeTags) && (
                            <span
                              className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide border bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/30"
                              title={
                                typeof node.prime === "boolean"
                                  ? "Prime: flagged on this document. Always requires steward approval."
                                  : "Prime: inherited from a prime tag. Always requires steward approval."
                              }
                              data-testid={`prime-badge-${node.id}`}
                            >
                              <Star className="h-3 w-3" />
                              Prime
                            </span>
                          )}
                          {flagPending && (
                            <span
                              className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide border bg-red-50 text-red-700 border-red-200"
                              title={`${flag!.requestedBy} asked for this to be deleted: "${flag!.reason}". A nest admin decides.`}
                              data-testid={`deletion-flag-${node.id}`}
                            >
                              <Trash2 className="h-3 w-3" />
                              Deletion requested
                            </span>
                          )}
                          {cards && <div className="ml-auto">{actionMenu}</div>}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                          <span>v{node.version || 1}</span>
                          {node.tags?.length > 0 && (
                            <>
                              <span>·</span>
                              <span className="flex items-center gap-1 truncate">
                                {node.tags.slice(0, 3).map((t: string) => (
                                  <button
                                    key={t}
                                    type="button"
                                    title={
                                      tagFilters.includes(t)
                                        ? `Remove filter ${t}`
                                        : `Filter by ${t}`
                                    }
                                    className={`rounded-full border px-1.5 py-px transition-colors ${tagFilters.includes(t)
                                      ? "bg-primary text-primary-foreground border-primary"
                                      : "hover:bg-muted"
                                      }`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleTagFilter(t);
                                    }}
                                  >
                                    {t}
                                  </button>
                                ))}
                              </span>
                            </>
                          )}
                          {(node.author || node.collaborators?.length > 0) && (
                            <>
                              <span>·</span>
                              <AuthorshipChips
                                author={node.author}
                                collaborators={node.collaborators}
                              />
                            </>
                          )}
                        </div>
                      </div>
                      {!cards && (
                        <div
                          className="flex items-center gap-1 transition-opacity opacity-0 group-hover:opacity-100"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {canSubmit && (
                            <Button variant="outline" size="sm" onClick={() => setSubmitNode(node)}>
                              <Send className="h-3.5 w-3.5 mr-1" />
                              Submit
                            </Button>
                          )}
                          {canReview && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setReviewNode(node)}
                              className="border-green-200 text-green-700 hover:bg-green-50"
                            >
                              Review
                            </Button>
                          )}
                          {canEdit && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => onOpenDocument(node.id)}
                              title="Edit"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {canMove && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={openMoveDialog}
                              title="Move to folder"
                              data-testid={`move-node-${node.id}`}
                            >
                              <FolderInput className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button variant="ghost" size="sm" onClick={() => openVersions(node)} title="History">
                            <History className="h-3.5 w-3.5" />
                          </Button>
                          {showDeleteAction && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={openDeleteFlow}
                              title={canDelete ? "Delete" : "Delete (needs admin approval)"}
                              data-testid={`delete-node-${node.id}`}
                              className={
                                canDelete
                                  ? "text-destructive hover:text-destructive hover:bg-destructive/10"
                                  : undefined
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                };

                if (viewMode === "cards") {
                  return (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                      {sorted.map((n) => renderDocRow(n))}
                    </div>
                  );
                }

                // List mode: nested folder tree. Folder headers collapse and
                // accept drops; doc rows drag. Groups under a collapsed
                // ancestor are skipped wholesale.
                return (
                  <div className="space-y-1">
                    {dragNodeId && folderOfNode(dragNodeId) !== baseFolder && (
                      <div
                        className={`flex items-center gap-2 rounded-md border-2 border-dashed px-3 py-2 text-sm ${dropFolder === baseFolder
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground"
                          }`}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                        }}
                        onDragEnter={() => setDropFolder(baseFolder)}
                        onDragLeave={() =>
                          setDropFolder((d) => (d === baseFolder ? null : d))
                        }
                        onDrop={(e) => {
                          e.preventDefault();
                          handleDropOnFolder(baseFolder);
                        }}
                      >
                        <FolderInput className="h-4 w-4" />
                        Move to {baseFolder ? prettyFolderPath(baseFolder) : "nest root"}
                      </div>
                    )}
                    <FolderTree
                      className="space-y-1"
                      groups={docGroups}
                      baseFolder={baseFolder}
                      isCollapsed={(p) => collapsedFolders.has(p)}
                      renderFolder={(node, { collapsed }) => {
                        // Valid drop = a doc is being dragged and this isn't
                        // its current folder. Invalid targets get no
                        // highlight and skip preventDefault, so the browser
                        // shows the no-drop cursor and the drop is a no-op.
                        // Folder rows themselves are NOT draggable: the
                        // server has no folder-move/rename endpoint (the
                        // move API relocates one document per call), so
                        // folder-onto-folder would be N non-atomic moves —
                        // document moves only until that lands server-side.
                        const validDrop =
                          !!dragNodeId && folderOfNode(dragNodeId) !== node.path;
                        const isDropTarget = validDrop && dropFolder === node.path;
                        // Only folders that DIRECTLY hold a document collapse.
                        // A pure container (subfolders only, no node file) has
                        // nothing of its own to hide, so it stays a static row
                        // — no chevron, matching a file-tree's leaf folders.
                        const collapsible = node.count > 0;
                        return (
                          <div
                            className={`group/fh flex items-center gap-1.5 py-1.5 px-2 rounded-md select-none transition-colors ${collapsible ? "cursor-pointer" : ""
                              } ${isDropTarget
                                ? "bg-primary/10 ring-1 ring-primary"
                                : "hover:bg-muted/50"
                              }`}
                            onClick={
                              collapsible
                                ? () => toggleFolderCollapsed(node.path)
                                : undefined
                            }
                            onDragOver={(e) => {
                              if (!validDrop) return;
                              e.preventDefault();
                              e.dataTransfer.dropEffect = "move";
                            }}
                            onDragEnter={(e) => {
                              // dragenter/dragleave bubble from the header's own
                              // children (count badge, "+" button). Ignore those
                              // inner crossings — relatedTarget still inside the
                              // header — so the 600ms spring-open timer isn't
                              // cancelled + rescheduled on every child hover.
                              if (
                                e.currentTarget.contains(e.relatedTarget as Node)
                              )
                                return;
                              // Spring a collapsed folder open on hover so its
                              // subfolders become reachable — even when this
                              // folder is the dragged doc's OWN folder (not a
                              // valid drop target itself). Otherwise a doc in a
                              // collapsed parent can never be dragged into one
                              // of that parent's subfolders: hovering the parent
                              // wouldn't expand it, so the subfolders never show.
                              if (dragNodeId && collapsible && collapsed)
                                scheduleDragExpand(node.path);
                              if (!validDrop) return;
                              setDropFolder(node.path);
                            }}
                            onDragLeave={(e) => {
                              // Only a true leave of the whole header counts —
                              // moving onto a child fires a spurious leave.
                              if (
                                e.currentTarget.contains(e.relatedTarget as Node)
                              )
                                return;
                              setDropFolder((d) => (d === node.path ? null : d));
                              cancelDragExpand();
                            }}
                            onDrop={(e) => {
                              if (!validDrop) return;
                              e.preventDefault();
                              handleDropOnFolder(node.path);
                            }}
                            data-testid={`folder-header-${node.path}`}
                          >
                            {collapsible ? (
                              <ChevronRight
                                className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${collapsed ? "" : "rotate-90"
                                  }`}
                              />
                            ) : (
                              // Spacer so names still line up under sibling
                              // collapsible folders.
                              <span className="h-3.5 w-3.5 shrink-0" />
                            )}
                            <FolderOpen className="h-4 w-4 text-blue-500" />
                            <span className="text-sm font-medium">
                              {node.label}
                            </span>
                            {/* Recursive subtree total (this folder + all
                                  descendants), matching the Overview Contents
                                  card. Direct-count-only made a folder holding
                                  hundreds of nested docs read as "3", so the
                                  Documents tab looked like it was hiding docs. */}
                            {node.total > 0 && (
                              <Badge
                                variant="secondary"
                                className="text-[10px] px-1.5 py-0 h-5"
                                title={
                                  node.count !== node.total
                                    ? `${node.count} here · ${node.total} in this folder`
                                    : undefined
                                }
                              >
                                {node.total}
                              </Badge>
                            )}
                            {canEditDocs && (
                              <button
                                type="button"
                                className="ml-1 rounded p-0.5 text-muted-foreground opacity-0 group-hover/fh:opacity-100 hover:text-primary hover:bg-primary/10"
                                title={`New document in ${prettyFolderPath(node.path)}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenDocument("new", { folder: node.path });
                                }}
                              >
                                <Plus className="h-3.5 w-3.5" />
                              </button>
                            )}
                            {/* Same split as a document: admins/owners delete
                                the folder (and everything under it), everyone
                                else raises a request. Hidden while one is
                                already pending on this folder. */}
                            {(canManage || !folderFlagPending(node.path)) && (
                              <button
                                type="button"
                                className={`rounded p-0.5 opacity-0 group-hover/fh:opacity-100 ${
                                  canManage
                                    ? "text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                    : "text-muted-foreground hover:text-primary hover:bg-primary/10"
                                }`}
                                title={
                                  canManage
                                    ? `Delete ${prettyFolderPath(node.path)} and everything in it`
                                    : "Delete (needs admin approval)"
                                }
                                data-testid={`delete-folder-${node.path}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setFolderTarget({
                                    path: node.path,
                                    label: prettyFolderPath(node.path),
                                    total: node.total,
                                  });
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                            {folderFlagPending(node.path) && (
                              <span
                                className="rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide bg-red-50 text-red-700 border border-red-200"
                                title="Someone asked for this folder to be deleted. A nest admin decides."
                              >
                                Deletion requested
                              </span>
                            )}
                          </div>
                        );
                      }}
                      renderDoc={(n) => renderDocRow(n, 0)}
                    />
                  </div>
                );
              })()}

              {/* Wiki link health — orphans + broken [[links]], computed
                  client-side. Collapsed by default; hidden when clean. */}
              {!loading &&
                (wikiHealth.broken.length > 0 ||
                  wikiHealth.orphans.length > 0) && (
                  <details className="mt-4 text-xs text-muted-foreground">
                    <summary className="cursor-pointer select-none">
                      Link health: {wikiHealth.broken.length} broken link
                      {wikiHealth.broken.length !== 1 ? "s" : ""} ·{" "}
                      {wikiHealth.orphans.length} orphan doc
                      {wikiHealth.orphans.length !== 1 ? "s" : ""}
                    </summary>
                    <div className="mt-2 space-y-2 pl-1">
                      {wikiHealth.broken.length > 0 && (
                        <div>
                          <div className="font-medium mb-1">
                            Broken links (target doesn't exist):
                          </div>
                          {wikiHealth.broken.slice(0, 10).map((b, i) => (
                            <div key={i}>
                              <button
                                type="button"
                                className="text-primary hover:underline"
                                onClick={() => onOpenDocument(b.sourceId)}
                              >
                                {b.sourceTitle}
                              </button>{" "}
                              → [[{b.target}]]
                            </div>
                          ))}
                        </div>
                      )}
                      {wikiHealth.orphans.length > 0 && (
                        <div>
                          <div className="font-medium mb-1">
                            Orphans (nothing links to them):
                          </div>
                          <div className="flex flex-wrap gap-x-3 gap-y-1">
                            {wikiHealth.orphans.slice(0, 15).map((o) => (
                              <button
                                key={o.id}
                                type="button"
                                className="text-primary hover:underline"
                                onClick={() => onOpenDocument(o.id)}
                              >
                                {o.title}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </details>
                )}
            </CardContent>
          </Card>
        </TabsContent>

        {showReviewTab && (
          <TabsContent value="review" className="space-y-4">
            {/* Feed filter chips — All shows changes + comments interleaved;
                Changes is the legacy queue; Comments is discussion only. */}
            <div className="flex items-center gap-1.5" data-testid="feed-filter-chips">
              {(
                [
                  { key: "all", label: "All" },
                  { key: "changes", label: `Changes (${reviewableQueue.length})` },
                  // Authoritative server count — the loaded array is paged.
                  { key: "comments", label: `Comments (${feedCommentsTotal})` },
                ] as const
              ).map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => setFeedFilter(chip.key)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${feedFilter === chip.key
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  data-testid={`feed-filter-${chip.key}`}
                >
                  {chip.label}
                </button>
              ))}
            </div>
            {/* The caller's own submissions, kept out of the actionable queue
                by separation-of-duties. Shown read-only so "submit for review"
                visibly lands somewhere. */}
            {feedFilter !== "comments" && myPendingSubmissions.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Send className="h-4 w-4 text-blue-600" />
                    Submitted by you — awaiting review
                  </CardTitle>
                  <CardDescription>
                    Your edits are queued for a reviewer. You can't approve your
                    own work (separation of duties), but they are pending.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {myPendingSubmissions.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => onOpenDocument(r.nodeId)}
                      className="w-full flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/50"
                    >
                      <span className="truncate">{r.title || r.nodeId}</span>
                      <Badge variant="secondary" className="text-[10px] shrink-0">
                        Awaiting review
                      </Badge>
                    </button>
                  ))}
                </CardContent>
              </Card>
            )}
            {/* Deletion flags raised by everyone below admin. Only nest
                admins/owners — the tier that deletes — resolve them. */}
            {canManage && pendingDeletions.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Trash2 className="h-4 w-4 text-destructive" />
                    Deletion requests
                  </CardTitle>
                  <CardDescription>
                    Documents flagged as stale. Delete them, or decline with a
                    note.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {pendingDeletions.map((r) => (
                    <div
                      key={r.id}
                      data-testid="deletion-request-item"
                      className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
                    >
                      <button
                        className="flex-1 min-w-0 text-left"
                        onClick={() => onOpenDocument(r.nodeId)}
                      >
                        <span className="font-medium truncate block">
                          {r.title || r.nodeId}
                          {r.targetType && r.targetType !== "document" && (
                            <span className="ml-2 rounded bg-muted px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                              {r.targetType === "folder" ? "Folder" : "Nest"}
                            </span>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {r.requestedBy} — &ldquo;{r.reason}&rdquo;
                        </span>
                      </button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setResolveTarget({ request: r, action: "decline" })
                        }
                      >
                        Decline
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() =>
                          setResolveTarget({ request: r, action: "delete" })
                        }
                      >
                        Delete
                      </Button>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
            <ReviewQueue
              requests={feedFilter === "comments" ? [] : reviewableQueue}
              // Feed mode (interleaved comment rows) except on the Changes
              // chip, which renders the legacy changes-only queue untouched.
              comments={feedFilter === "changes" ? undefined : feedComments}
              onSelectComment={(cm) =>
                onOpenDocument(cm.nodeId, { thread: cm.threadId })
              }
              loading={loading}
              onRefresh={fetchData}
              onSelect={(req) => {
                const node = nodes.find((n) => n.id === req.nodeId);
                if (node) {
                  setReviewNode(node);
                  return;
                }
                // Orphan: review_request points to a node not in the
                // visible list (file deleted, or filtered out by
                // stewardship access). Without this the row click was
                // a silent dead-end.
                toast.error(
                  `Can't open "${req.title || req.nodeId}" — document missing or outside your access.`,
                );
              }}
            />
            {/* Comment activity is paged (50/page) — fetch the next page when
                more exists than what's loaded. Changes need no pager: they're
                the actionable pending set the queue already shows in full. */}
            {feedFilter !== "changes" &&
              feedComments.length < feedCommentsTotal && (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={loadMoreComments}
                    disabled={feedLoadingMore}
                    data-testid="feed-load-more"
                  >
                    {feedLoadingMore ? (
                      <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                    ) : null}
                    Load more comments (
                    {feedCommentsTotal - feedComments.length} remaining)
                  </Button>
                </div>
              )}
            {/* When the raw queue has entries but the reviewable filter
                emptied it, the queue card says "All caught up!" — which
                is wrong. Surface the gap so the user knows items exist
                but aren't actionable by them (scope or SoD). */}
            {feedFilter !== "comments" &&
              reviewQueue.length > 0 && reviewableQueue.length === 0 && (
                <p className="text-xs text-muted-foreground text-center">
                  {reviewQueue.length} pending review
                  {reviewQueue.length === 1 ? "" : "s"} in this nest, but
                  none you can act on — outside your steward scope, or
                  submitted by you (authors can't approve their own work).
                </p>
              )}
          </TabsContent>
        )}

        <TabsContent value="external-edits" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <FileWarning className="h-4 w-4 text-orange-600" />
                    External Edits
                  </CardTitle>
                  <CardDescription>
                    Files edited directly on disk, awaiting your approval.
                  </CardDescription>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={refreshExternalEdits}
                  disabled={externalEditsLoading}
                  className="h-8 w-8"
                  data-testid="external-edits-refresh"
                >
                  {externalEditsLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {initialLoad ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : externalEdits.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <CheckCircle2 className="h-10 w-10 text-green-500 mb-3" />
                  <p className="text-sm font-medium">No pending external edits</p>
                  <p className="text-xs text-muted-foreground">
                    All files on disk match their last approved state.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {externalEdits.map((entry) => {
                    // Resolve the human-readable title; fall back to the bare
                    // doc name so internal `nodes/` paths never leak to the UI.
                    const docTitle =
                      nodes.find((n) => n.id === entry.document_id)?.title ||
                      entry.document_id.split("/").pop();
                    return (
                      <div
                        key={entry.suggestion_id}
                        className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 cursor-pointer transition-colors"
                        onClick={() => onOpenDocument(entry.document_id)}
                        data-testid={`external-edit-row-${entry.suggestion_id}`}
                      >
                        <FileWarning className="h-5 w-5 text-orange-600 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">
                              {docTitle}
                            </span>
                            <Badge
                              variant="secondary"
                              className="text-[10px] px-1.5 py-0 bg-orange-100 text-orange-700"
                            >
                              {entry.source}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
                            <Clock className="h-3 w-3" />
                            <span>
                              {formatServerDate(entry.detected_at)}
                            </span>
                            <span>•</span>
                            <span>by {entry.actor}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {stewardshipEnabled && canManageGovernance && (
          <TabsContent value="stewards" className="space-y-4">
            <Card className="border-blue-200 bg-blue-50/40">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Shield className="h-4 w-4 text-blue-700" />
                  How stewardship works
                </CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground space-y-2 leading-relaxed">
                <p>
                  <strong className="text-foreground">New documents start as drafts.</strong>{" "}
                  They're not available to AI queries until a steward approves them.
                </p>
                <p>
                  <strong className="text-foreground">Stewards</strong> are
                  people you name to govern content by scope. Resolution
                  priority (first match wins):
                </p>
                <ol className="list-decimal list-inside ml-2 space-y-0.5">
                  <li><strong>Document</strong> — this exact doc</li>
                  <li><strong>Tag</strong> — everything with #tag</li>
                  <li><strong>Nest</strong> — anything not matched above</li>
                </ol>
                <p>
                  <strong className="text-foreground">Reviewers</strong> can
                  approve/reject; <strong className="text-foreground">editors</strong> can edit;{" "}
                  <strong className="text-foreground">viewers</strong> have read access.
                  Authors can't approve their own work.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle className="text-lg">Stewards</CardTitle>
                    <CardDescription>
                      {stewards.length === 0
                        ? "Nobody's governing content yet"
                        : "Who governs what"}
                    </CardDescription>
                  </div>
                  {stewards.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      {(["all", "document", "tag", "nest"] as const).map(
                        (s) => (
                          <button
                            key={s}
                            onClick={() => setStewardScope(s)}
                            className={`text-xs px-2 py-1 rounded border ${stewardScope === s
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-background text-muted-foreground border-border hover:bg-secondary"
                              }`}
                          >
                            {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
                          </button>
                        ),
                      )}
                      <span className="w-px h-4 bg-border" />
                      <Select
                        value={stewardRoleFilter}
                        onValueChange={(v) =>
                          setStewardRoleFilter(v as "all" | StewardRole)
                        }
                      >
                        <SelectTrigger className="w-[120px] h-7 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All</SelectItem>
                          <SelectItem value="editor">Editor</SelectItem>
                          <SelectItem value="reviewer">Reviewer</SelectItem>
                          <SelectItem value="viewer">Viewer</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {stewards.length === 0 ? (
                  <div className="text-sm space-y-3 py-2">
                    <p className="text-muted-foreground leading-relaxed">
                      Without stewards, every draft needs the nest owner to
                      approve. Add an editor/reviewer to delegate approvals
                      for a tag or specific doc.
                    </p>
                    {canManageGovernance && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => setShowAssignSteward(true)}
                      >
                        <Shield className="h-3.5 w-3.5 mr-2" />
                        Assign your first steward
                      </Button>
                    )}
                  </div>
                ) : (
                  <StewardList
                    stewards={stewards.filter(
                      (s) =>
                        (stewardScope === "all" || s.scope === stewardScope) &&
                        (stewardRoleFilter === "all" ||
                          s.role === stewardRoleFilter),
                    )}
                    showScope
                    onAddSteward={
                      canManageGovernance ? () => setShowAssignSteward(true) : undefined
                    }
                    onRemove={
                      canManageGovernance
                        ? async (stewardId: string) => setRemoveStewardId(stewardId)
                        : undefined
                    }
                    onEditRole={canManageGovernance ? setEditingSteward : undefined}
                    currentUserEmail={currentEmail}
                  />
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {(canManage || collabCanWrite) && (
          <TabsContent value="collaborators" className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Collaborators</CardTitle>
                <CardDescription>
                  People with direct access to this nest. Sharing grants plain
                  access (viewer/editor/admin) — it does not make anyone a
                  steward. Manage visibility from the Share dialog.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <CollaboratorManager
                  nestId={nestId}
                  nestName={nestName}
                  onChanged={fetchData}
                  currentUserEmail={currentEmail}
                  callerPermission={permission ?? undefined}
                  showTeams
                />
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {activeTab === "review" && !stewardshipEnabled && !isReadOnly && canManageGovernance && (
        <Card className="mt-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="h-4 w-4" />
              Stewardship is off
            </CardTitle>
            <CardDescription>
              New documents are auto-approved and immediately AI-ready.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-3">
              Enable stewardship to require steward approval before documents become AI-ready.
              Versioning stays on either way.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setShowSettings(true)}
            >
              <SettingsIcon className="h-3.5 w-3.5 mr-2" />
              Open Settings
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Modals */}
      {showConnect && (
        <ConnectModal
          isOpen={showConnect}
          onClose={() => setShowConnect(false)}
          onGenerate={() => {
            setShowConnect(false);
            setShowGenerate(true);
          }}
          nestId={nestId}
          nestName={nestName}
        />
      )}

      {showGenerate && (
        <GenerateContextModal
          isOpen={showGenerate}
          onClose={() => setShowGenerate(false)}
          nestId={nestId}
          nestName={nestName}
          openMode={authMode === "open"}
        />
      )}

      {showShare && (
        <ShareNestDialog
          nestId={nestId}
          nestName={nestName}
          onClose={() => setShowShare(false)}
          onChanged={fetchData}
        />
      )}

      {showSettings && (
        <NestSettingsModal
          nestId={nestId}
          nestName={nestName}
          stewardshipEnabled={stewardshipEnabled}
          allowSelfApprove={allowSelfApprove}
          primeOnlyReview={primeOnlyReview}
          primeTags={primeTags}
          canManageStewardship={canManageGovernance}
          onClose={() => setShowSettings(false)}
          onChanged={(next) => {
            setShowSettings(false);
            // Flip the governance UI (Pending/AI Ready/Review Queue tiles,
            // Stewards tab, etc.) instantly instead of waiting for the full
            // refetch to land — then reconcile counts in the background.
            setStewardshipEnabled(next.stewardshipEnabled);
            setAllowSelfApprove(next.allowSelfApprove);
            setPrimeOnlyReview(next.primeOnlyReview);
            setPrimeTags(next.primeTags);
            fetchData();
          }}
        />
      )}

      {showDelete && (
        <DeleteNestDialog
          nestId={nestId}
          nestName={nestName}
          isImported={isImported}
          open
          onOpenChange={setShowDelete}
          onDeleted={() => { setShowDelete(false); onBack(); }}
        />
      )}

      {showRename && (
        <RenameNestDialog
          nestId={nestId}
          nestName={editableName}
          nestDescription={nestDescription}
          open
          onOpenChange={setShowRename}
          onRenamed={(updated, changed) => {
            // Sync the inline header rename ONLY when the dialog actually
            // sent a name — on a description-only save `updated.name` can be
            // stale relative to an in-flight inline edit, and overwriting
            // editableName/lastSavedName with it would both visually revert
            // the header and make the pending debounce a no-op (silently
            // dropping the rename).
            if (changed.nameChanged) {
              setEditableName(updated.name);
              lastSavedName.current = updated.name;
              setRenameError(null);
            }
            setNestDescription(updated.description);
            setShowRename(false);
          }}
        />
      )}

      <Dialog open={showNewFolder} onOpenChange={setShowNewFolder}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Name the folder. Nest it with a slash — e.g.{" "}
            <code className="text-xs">gtm/deals</code>. It's seeded with a starter
            document so it shows up right away.
          </p>
          <Input
            autoFocus
            value={newFolderPath}
            onChange={(e) => setNewFolderPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createFolder();
            }}
            placeholder="e.g. gtm/deals"
            className="font-mono"
          />
          {newFolderTooDeep && (
            <p className="text-xs text-destructive">
              Folders may nest at most {MAX_FOLDER_DEPTH} levels deep — this path
              is {newFolderDepth}. Remove {newFolderDepth - MAX_FOLDER_DEPTH}{" "}
              level{newFolderDepth - MAX_FOLDER_DEPTH === 1 ? "" : "s"}.
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowNewFolder(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void createFolder()}
              disabled={creatingFolder || !newFolderPath.trim() || newFolderTooDeep}
            >
              {creatingFolder ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <FolderPlus className="h-4 w-4 mr-2" />
              )}
              Create folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move to folder — the keyboard-accessible path to the same move the
          drag-and-drop performs; both funnel through handleMoveNode. */}
      <Dialog
        open={!!moveTarget}
        onOpenChange={(open) => {
          // No Escape/overlay dismissal mid-request — same gating as the
          // disabled Cancel button.
          if (!open && !movingDoc) setMoveTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Move to folder</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Move <strong>{moveTarget?.title}</strong> to another folder.
            Version history, review state, and [[wiki links]] follow the
            document.
          </p>
          <Select
            value={moveDest === "" ? "__root__" : moveDest}
            onValueChange={(v) => setMoveDest(v === "__root__" ? "" : v)}
          >
            <SelectTrigger data-testid="move-folder-select">
              <SelectValue placeholder="Choose a folder" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__root__">Nest root</SelectItem>
              {allFolders.map((f) => (
                <SelectItem key={f} value={f}>
                  {prettyFolderPath(f)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={movingDoc}
              onClick={() => setMoveTarget(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                movingDoc ||
                !moveTarget ||
                folderOfNode(moveTarget.id) === moveDest
              }
              onClick={async () => {
                if (!moveTarget) return;
                setMovingDoc(true);
                const ok = await handleMoveNode(moveTarget.id, moveDest);
                setMovingDoc(false);
                if (ok) setMoveTarget(null);
              }}
              data-testid="move-folder-confirm"
            >
              {movingDoc ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <FolderInput className="h-4 w-4 mr-2" />
              )}
              Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showSaveFilter} onOpenChange={setShowSaveFilter}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Save this filter</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Saved filters remember your current search, tags, status, author and
            date range. Pick one from the <strong>Saved</strong> row to re-apply
            the whole set in one click — handy for views you return to, like
            “My drafts” or “Edited this week”.
          </p>
          <Input
            autoFocus
            placeholder="Filter name (e.g. My drafts)"
            value={saveFilterName}
            onChange={(e) => setSaveFilterName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveCurrentFilter();
            }}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowSaveFilter(false)}>
              Cancel
            </Button>
            <Button onClick={saveCurrentFilter} disabled={!saveFilterName.trim()}>
              Save filter
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {showAssignSteward && (
        <StewardModal
          isOpen={showAssignSteward}
          onClose={() => setShowAssignSteward(false)}
          nestId={nestId}
          onSubmit={handleAssignSteward}
          onSync={async () => {
            await api.syncStewards(nestId);
            await fetchData();
          }}
        />
      )}

      {editingSteward && (
        <StewardModal
          isOpen={!!editingSteward}
          steward={editingSteward}
          nestId={nestId}
          onClose={() => setEditingSteward(null)}
          onSubmit={handleSaveStewardRole}
        />
      )}

      {submitNode && (
        <SubmitForReviewModal
          isOpen={!!submitNode}
          onClose={() => setSubmitNode(null)}
          documentTitle={submitNode.title}
          currentVersion={submitNode.version || 1}
          onSubmit={handleSubmitReview}
        />
      )}

      {reviewNode && (
        <ReviewDocumentModal
          node={reviewNode}
          nestId={nestId}
          onApprove={handleApprove}
          onReject={handleReject}
          onClose={() => setReviewNode(null)}
          onOpenDocument={(nodeId) => {
            setReviewNode(null);
            onOpenDocument(nodeId);
          }}
        />
      )}

      {removeStewardId && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setRemoveStewardId(null)}
          title="Remove this steward?"
          description="They lose approval rights immediately. The user account and any documents stay intact."
          confirmLabel="Remove steward"
          destructive
          onConfirm={handleRemoveSteward}
        />
      )}

      {nestFlagOpen && (
        <ReasonDialog
          open
          onOpenChange={setNestFlagOpen}
          title={`Request deletion of "${nestName}"`}
          description="A nest owner or admin reviews this. Honouring it deletes the whole nest and every document in it. Nothing is removed yet."
          label="Why should it be deleted?"
          placeholder="e.g. project wound down, superseded by another nest"
          confirmLabel="Request deletion"
          onConfirm={async (reason) => {
            await api.requestTargetDeletion(nestId, "nest", nestId, reason);
            toast.success("Deletion requested — a nest admin will review it");
            fetchData();
          }}
        />
      )}

      {folderTarget && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setFolderTarget(null)}
          title={
            canManage
              ? `Delete "${folderTarget.label}"?`
              : `Request deletion of "${folderTarget.label}"`
          }
          description={
            canManage
              ? `This deletes all ${folderTarget.total} document${folderTarget.total === 1 ? "" : "s"} in this folder and its subfolders, with their history, comments and annotations. It cannot be undone.`
              : `A nest admin reviews this. Honouring it deletes all ${folderTarget.total} document${folderTarget.total === 1 ? "" : "s"} in this folder. Nothing is removed yet.`
          }
          // Admins confirm; a request must say why.
          label={canManage ? undefined : "Why should it be deleted?"}
          placeholder="e.g. superseded by the new API docs"
          confirmLabel={canManage ? "Delete folder" : "Request deletion"}
          destructive={canManage}
          onConfirm={handleFolderDeletion}
        />
      )}

      {deleteNodeTarget && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setDeleteNodeTarget(null)}
          title={`Delete "${deleteNodeTarget.title}"?`}
          description="This removes the document, its version history, comments and annotations. It cannot be undone."
          confirmLabel="Delete document"
          destructive
          onConfirm={handleDeleteNode}
        />
      )}

      {deletionTarget && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setDeletionTarget(null)}
          title={`Request deletion of "${deletionTarget.title}"`}
          description="A nest admin reviews this and either deletes the document or declines with a note. Nothing is removed yet."
          label="Why should it be deleted?"
          placeholder="e.g. superseded by the new runbook"
          confirmLabel="Request deletion"
          priorDecline={
            flagByNode.get(deletionTarget.id)?.status === "declined"
              ? flagByNode.get(deletionTarget.id)
              : null
          }
          onConfirm={handleRequestDeletion}
        />
      )}

      {resolveTarget && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setResolveTarget(null)}
          title={
            resolveTarget.action === "delete"
              ? `Delete "${resolveTarget.request.title || resolveTarget.request.nodeId}"?`
              : "Decline this deletion request"
          }
          description={
            resolveTarget.action === "delete"
              ? `${resolveTarget.request.requestedBy} asked for this: "${resolveTarget.request.reason}". Deleting cannot be undone.`
              : `${resolveTarget.request.requestedBy} asked for this: "${resolveTarget.request.reason}". The document stays; your note is the record.`
          }
          // No label on the delete branch — that dialog is a plain confirm.
          label={
            resolveTarget.action === "decline"
              ? "Why are you declining?"
              : undefined
          }
          placeholder="e.g. still referenced by onboarding"
          confirmLabel={
            resolveTarget.action === "delete" ? "Delete document" : "Decline"
          }
          destructive={resolveTarget.action === "delete"}
          onConfirm={
            resolveTarget.action === "delete"
              ? handleHonourDeletion
              : handleDeclineDeletion
          }
        />
      )}

      {versionNode && (
        <VersionHistoryModal
          open
          onClose={() => setVersionNode(null)}
          title={versionNode.title}
          versionData={versionData}
          onLoadContent={async (v) =>
            (await api.getNodeVersionContent(nestId, versionNode.id, v)).content
          }
          onRestore={async (v) => {
            if (!versionNode) return;
            try {
              await api.revertToVersion(nestId, versionNode.id, v);
              toast.success(`Reverted to version ${v}`);
              await openVersions(versionNode);
              fetchData();
            } catch (e: any) {
              toast.error(e?.message || "Revert failed");
            }
          }}
        />
      )}
    </div>
  );
}

// ─── Sub-modals ─────────────────────────────────────────────────

function ReviewDocumentModal({
  node,
  nestId,
  onApprove,
  onReject,
  onClose,
  onOpenDocument,
}: {
  node: any;
  nestId: string;
  onApprove: (note?: string) => Promise<void>;
  onReject: (note: string) => Promise<void>;
  onClose: () => void;
  onOpenDocument: (nodeId: string) => void;
}) {
  const [linkError, setLinkError] = useState<string | null>(null);

  // Resolve `[[Title]]` clicks to a node id and jump straight to that
  // doc. Without this the wiki-link decoration renders but click does
  // nothing — `MarkdownEditor` only wires nav when `onWikiLinkClick`
  // is provided. Cache miss (no id from the existence check) falls
  // back to a fresh title→id lookup so links resolve even when the
  // target was created after the reviewer opened the modal. Broken
  // links are NOT routed to the create flow — the caller is acting
  // as a reviewer here (read-only role for this surface), so silently
  // dropping them into an authoring page would mislead them; instead
  // we surface an inline note.
  const handleWikiLinkClick = async (title: string, id: string | null) => {
    setLinkError(null);
    if (id) {
      onOpenDocument(id);
      return;
    }
    try {
      const { nodes } = await api.searchNodes(nestId, title);
      const exact = (nodes as Array<{ id: string; title: string }>).find(
        (n) => n.title.toLowerCase() === title.toLowerCase(),
      );
      if (exact) {
        onOpenDocument(exact.id);
        return;
      }
      setLinkError(
        `"${title}" doesn't exist in this nest. Reviewers can't create new documents — ask an editor to add it.`,
      );
    } catch (e) {
      console.error("[NestView] wiki-link lookup failed", nestId, title, e);
      setLinkError("Couldn't look up that document — try again later.");
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px] max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{node.title}</DialogTitle>
        </DialogHeader>
        {linkError && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            {linkError}
          </div>
        )}
        <div className="flex-1 overflow-y-auto rounded-md">
          {node.content ? (
            <MarkdownEditor
              // Remount when the reviewer switches between docs in the
              // queue. Same modal instance otherwise → TipTap keeps its
              // previous doc's editor state and the body briefly shows
              // the wrong content on swap.
              key={node.id}
              content={node.content}
              onChange={() => { }}
              editable={false}
              nestId={nestId}
              onWikiLinkClick={handleWikiLinkClick}
            />
          ) : (
            <p className="text-sm text-muted-foreground p-4">(no content)</p>
          )}
        </div>
        <DialogFooter>
          <ReviewActions
            documentTitle={node.title}
            version={node.version || 1}
            onApprove={onApprove}
            onReject={onReject}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
