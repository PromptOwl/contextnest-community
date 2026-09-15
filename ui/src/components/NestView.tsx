/**
 * NestView — governance dashboard for a single nest.
 * Uses ported PromptOwl components for the UI, wired to REST API.
 */
import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from "react";
import * as api from "../lib/api";
import { BULK_REVIEW_LIMIT } from "../lib/constants";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { reads } from "../lib/queries";
import { matchesFilters } from "../lib/node-filter";
import { visibleDocuments, documentsTabIsEmpty } from "../lib/visible-documents";
import { documentFacets } from "../lib/document-facets";
import { resolveWikiTarget } from "../lib/wiki-preview";
import { activityTimestamp } from "../lib/node-sort";
import { linkHealth } from "../lib/link-health";
import { folderGrantTarget } from "../lib/folder-target";
import { checkFolderPath } from "../lib/folder-path";
import { parseServerDate, formatServerDate } from "../lib/dates";
import { createConsumeOnceFlag } from "../lib/consume-once-flag";
import {
  datePresetToEpoch, upsertFilter, removeFilter,
  parseSavedFilters, serializeSavedFilters,
  type DatePreset, type SavedFilter,
} from "../lib/saved-filters";
import {
  FileText, FileCode2, Plus, ArrowLeft, History, Shield, Search, Upload, Sparkles,
  Clock, CheckCircle2, Send, Loader2, RefreshCw, Link2, Settings as SettingsIcon,
  Pencil, Trash2, FileWarning, Globe, Lock, Building2, FolderInput, Users,
  LayoutGrid, List as ListIcon, Star, X, MoreVertical,
  FolderOpen, ChevronRight, FileStack, Bot, Zap, FolderPlus, Wrench, Table2,
  Activity, Share2, BookOpen, Archive,
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
import { ReaderView } from "./ReaderView";
import { DocumentPickerModal } from "./DocumentPickerModal";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ShareNestDialog } from "./ShareNestDialog";
import { PublishDialog } from "./PublishDialog";
import { NestVisibilityControl } from "./NestVisibilityControl";
import { ShareTargetDialog } from "./ShareTargetDialog";
import { NestPageHeader } from "./NestPageHeader";
import {
  deriveNestCaps,
  firstTopLevelFolder,
  isNestArchived,
} from "../lib/nest-caps";
import { DeleteNestDialog } from "./DeleteNestDialog";
import { RenameNestDialog } from "./RenameNestDialog";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Tabs, TabsList, TabsTrigger, TabsContent,
} from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OverflowMenu, type OverflowAction } from "@/components/ui/overflow-menu";
import { CountSkeleton } from "@/components/ui/count-skeleton";
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
  /** Nest is archived — opened from the Archived section, forces read-only. */
  isArchived?: boolean;
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
  /** Open the account-level API keys page. */
  onManageKeys?: () => void;
  /** Seed the search filter on mount. Used when arriving from a tag
   *  click on a document detail page. */
  initialSearch?: string;
  /** Pre-seed the tag filter / folder scope when arriving from a tag chip or
   *  a folder breadcrumb segment elsewhere in the app. */
  initialTags?: string[];
  initialFolder?: string;
  /** Tab to open on mount, from ?tab= — falls back to overview when the
   *  slug names a tab this user can't see. */
  initialTab?: string;
  /** Reports tab changes up so App can mirror them into ?tab=. */
  onTabChange?: (tab: string) => void;
}

export function NestView({
  nestId,
  nestName,
  isOwner,
  isAnonOwned,
  isArchived,
  onBack,
  onOpenDocument,
  onOpenTrace,
  onManageKeys,
  initialSearch,
  initialTags,
  initialFolder,
  initialTab,
  onTabChange,
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
  // Escape reverts editableName via setState, which is batched and hasn't
  // applied yet when the input's own blur (triggered synchronously by the
  // Escape handler) fires flushRename — so flushRename would still see the
  // stale, edited value. This flag tells that one flush to no-op instead.
  const skipNextFlush = useRef(createConsumeOnceFlag()).current;
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
    if (skipNextFlush.consume()) return;
    void renameRef.current();
  }, []);
  useEffect(
    () => () => {
      if (renameTimer.current) window.clearTimeout(renameTimer.current);
    },
    [],
  );
  // Documents arrive one folder LEVEL at a time — the nest root on mount, a
  // folder's own documents when its row is expanded. `nodes` accumulates the
  // levels loaded so far, so it is NOT the whole nest.
  const [nodes, setNodes] = useState<any[]>([]);
  // The nest-wide shape that rides along with every level fetch: folder tree,
  // counts, tags, types, authors. Without it every filter and stat tile would
  // describe only the folders the user happened to open.
  const [census, setCensus] = useState<api.NestCensus | null>(null);
  // A filter, a search, and link health are all questions about the WHOLE
  // nest, which the folder levels on screen cannot answer. Fetch the full
  // listing once, only when one of those is actually asked.
  const [fullNodes, setFullNodes] = useState<any[] | null>(null);
  const [fullLoading, setFullLoading] = useState(false);
  // Full roster — admin-only (listStewards 403s for non-admins → stays []).
  const [stewards, setStewards] = useState<Steward[]>([]);
  // Caller's OWN steward rows (scoped), from GET /nests/:id. Drives per-node
  // affordances for non-admin reviewers/editors who can't read the roster.
  const [myStewards, setMyStewards] = useState<Steward[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewRequest[]>([]);
  // Bulk review selection, by node id. A reviewer clearing a folder import
  // makes the same call on every item, so let them say it once.
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<"approve" | "reject" | null>(
    null,
  );
  // This component is reused across nests (jumping between nests from the
  // search palette keeps the same page), so a selection has to be dropped when
  // the nest under it changes — otherwise node ids from the nest you left ride
  // along into a batch aimed at the one you arrived in.
  useEffect(() => {
    setBulkSelected(new Set());
    setBulkAction(null);
  }, [nestId]);
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
  // Folder being shared with one person (a grant, not a collaborator).
  const [shareFolder, setShareFolder] = useState<
    { path: string; label: string } | null
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
  // Map folder paths to their pending deletion request objects for withdraw.
  const folderFlagByPath = useMemo(() => {
    const map = new Map<string, api.DeletionRequest>();
    for (const r of deletionRequests)
      if (r.targetType === "folder" && r.status === "pending" && !map.has(r.nodeId))
        map.set(r.nodeId, r);
    return map;
  }, [deletionRequests]);
  // Either whole-nest ask counts as "already flagged" — the affordance is one
  // dialog offering both outcomes, so a pending archive request should not sit
  // beside a fresh "request removal" button.
  const nestFlag = deletionRequests.find(
    (r) =>
      (r.targetType === "nest" || r.targetType === "nest_archive") &&
      r.status === "pending",
  );
  const nestFlagPending = !!nestFlag;
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
  const [visibility, setVisibility] = useState<api.NestVisibility>("private");
  const [visibilitySaving, setVisibilitySaving] = useState(false);
  // Publishing (→ public) is guarded by an acknowledgement dialog: the nest
  // becomes readable by anyone on the internet, outside your organization.
  const [confirmPublic, setConfirmPublic] = useState(false);
  // Public Docs Reader Mode (superadmin-only config). reader_mode flips the
  // read-only presentation to the clean docs reader; reader_home_node names the
  // designated landing/hub node (empty → resolve by convention).
  const [readerModeEnabled, setReaderModeEnabled] = useState(false);
  const [readerHomeNode, setReaderHomeNode] = useState<string | null>(null);
  const [readerModeSaving, setReaderModeSaving] = useState(false);
  const [readerDialogOpen, setReaderDialogOpen] = useState(false);
  const [homeNodePickerOpen, setHomeNodePickerOpen] = useState(false);
  // Title of the saved home node — the stored value is an id, and an id is not
  // what people recognise. Resolved from the full document list, which the
  // picker has usually already cached.
  const [readerHomeTitle, setReaderHomeTitle] = useState<string | null>(null);
  const [isImported, setIsImported] = useState(false);
  // Fetched straight off GET /nests/:id, independent of the isArchived prop
  // threaded down from App's View state — a deep link or a page refresh
  // lands here without that prop ever being set, so the caps below fall back
  // to whichever of the two actually has the answer.
  const [nestArchivedAt, setNestArchivedAt] = useState<string | null>(null);
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
  // Public Docs Reader Mode: unlike governance above, the server admin keeps
  // access on EVERY nest here (matches the handler's own gate in
  // sharing-routes.ts — isServerAdminUserId is never narrowed to "your own
  // nests"), on top of which the nest's own owner/admin collaborator can now
  // also configure it without needing server-admin rights.
  const canManageReaderMode =
    isAdmin || isOwner || permission === "owner" || permission === "admin";
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
  const [tagFilters, setTagFilters] = useState<string[]>(initialTags ?? []);
  const toggleTagFilter = (tag: string) =>
    setTagFilters((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [authorFilter, setAuthorFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<DatePreset>("any");
  // Document list sort. Defaults to "activity" (most-recently-touched first) so
  // the list opens on what changed, not an alphabetical wall.
  const [sortMode, setSortMode] = useState<
    "activity" | "name" | "edited" | "comments"
  >("activity");
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
  const [publishNode, setPublishNode] = useState<any | null>(null);
  const [submitNode, setSubmitNode] = useState<any | null>(null);
  const [versionNode, setVersionNode] = useState<any | null>(null);
  const [versionData, setVersionData] = useState<{
    versions: Version[];
    approvedVersion: number | null;
    currentVersion: number;
    externalEditVerdicts?: api.ExternalEditVerdict[];
  }>({ versions: [], approvedVersion: null, currentVersion: 0 });
  const [showAssignSteward, setShowAssignSteward] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const importDirRef = useRef<HTMLInputElement>(null);
  const [newFolderPath, setNewFolderPath] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  // Depth, slugifiability, reserved names — the same rules the server applies,
  // run as you type so the resulting path is visible before anything exists.
  const newFolderCheck = checkFolderPath(newFolderPath);

  const createFolder = async () => {
    const folder = newFolderCheck.path;
    if (!folder) return;
    // Block what the server would reject before the round-trip, so the user
    // gets the reason inline instead of a swallowed 400.
    if (newFolderCheck.error) return;
    setCreatingFolder(true);
    try {
      // Folders are path-derived, so the server records the path rather than
      // seeding a starter document that would count as real content
      // (CU-wdqcpzzzut). Nesting works via "parent/child".
      await api.createFolder(nestId, folder);
      setNewFolderPath("");
      setShowNewFolder(false);
      // An empty folder barely changes the tree, so say it landed
      // (CU-wdqcq01caq) — the failure path already speaks.
      // Named the way the tree will show it — quoting the raw path made the
      // toast look like it created a different folder (CU-wdqcq01pe8).
      toast.success(`Folder "${prettyFolderPath(folder)}" created`);
      fetchData();
    } catch (e: any) {
      console.error("[NestView] createFolder failed", e);
      toast.error(e?.message || "Failed to create folder");
    } finally {
      setCreatingFolder(false);
    }
  };
  const [showDelete, setShowDelete] = useState(false);
  // Rename dialog (name + description) — complements the inline header
  // rename, which only covers the name.
  const [showRename, setShowRename] = useState(false);
  const [nestDescription, setNestDescription] = useState<string | null>(null);

  // Documents-as-a-repo state: controlled tab (Overview folder clicks jump to
  // Documents), the folder the list is scoped to (null = whole nest, "" would
  // mean root-only but we scope by subtree), collapsed folder paths, and
  // drag-and-drop bookkeeping for moving docs between folders.
  const [folderFilter, setFolderFilter] = useState<string | null>(
    initialFolder ?? null,
  );
  // A folder breadcrumb or tag chip click arrives pre-scoped, and both filtered
  // lists live on Documents — Overview would hide the scope entirely.
  const [activeTab, setActiveTabState] = useState(
    initialTab ??
      (initialFolder || initialTags?.length ? "documents" : "overview"),
  );
  // Wrapper so every tab change — the tab strip, and the Overview folder
  // clicks that jump to Documents — mirrors into ?tab= via App.
  const setActiveTab = (tab: string) => {
    setActiveTabState(tab);
    onTabChange?.(tab);
  };
  // Expanded folders, not collapsed ones: a folder's documents are fetched on
  // first expand, so the default has to be closed.
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);

  /** Folder path of a node id ("" for docs directly under nodes/). */
  const folderOfNode = (id: string) => {
    const rel = id.startsWith("nodes/") ? id.slice(6) : id;
    const slash = rel.lastIndexOf("/");
    return slash > 0 ? rel.slice(0, slash) : "";
  };

  const qc = useQueryClient();

  // Folder levels loaded so far, so a refetch after a mutation restores
  // exactly what is on screen. A ref, not state: it must not re-run fetchData.
  const loadedFolders = useRef<Set<string>>(new Set());
  // Reactive mirror of the ref above, for Reader Mode only: it needs to know
  // WHICH known folders already have their docs fetched so an unfetched
  // folder can default to a collapsed row instead of showing an "expanded"
  // chevron over nothing.
  const [loadedFolderPaths, setLoadedFolderPaths] = useState<Set<string>>(
    new Set(),
  );

  /**
   * Fetch ONE folder level and fold it into `nodes`, replacing whatever was
   * previously loaded for that level (a move or delete changes ids, so
   * replacing beats merging). Also refreshes the nest-wide census.
   */
  const fetchLevel = useCallback(
    async (folder: string, opts: { refresh?: boolean } = {}) => {
      // Re-expanding a folder already on screen is not a reason to re-read
      // it; only an explicit refresh (a mutation) is.
      if (!opts.refresh && loadedFolders.current.has(folder)) return;
      setLoadingFolders((prev) => new Set(prev).add(folder));
      try {
        const res = await qc.fetchQuery(reads.folderNodes(nestId, folder));
        loadedFolders.current.add(folder);
        setLoadedFolderPaths((prev) => new Set(prev).add(folder));
        setNodes((prev) => [
          ...prev.filter((n) => folderOfNode(n.id || "") !== folder),
          ...res.nodes,
        ]);
      } catch (e: any) {
        console.error("[NestView] listFolderNodes failed", nestId, folder, e);
        toast.error(e?.message || "Failed to load folder");
      } finally {
        setLoadingFolders((prev) => {
          const next = new Set(prev);
          next.delete(folder);
          return next;
        });
      }
    },
    [nestId, qc],
  );

  /** The nest-wide shape. Describes the whole nest whatever level is open,
   *  so it is read once per nest rather than once per folder expanded. */
  const fetchCensus = useCallback(async () => {
    try {
      const { census: fresh } = await qc.fetchQuery(reads.census(nestId));
      setCensus(fresh);
    } catch (e) {
      console.error("[NestView] getNestCensus failed", nestId, e);
    }
  }, [nestId, qc]);

  /** Re-read every level currently on screen — used after every mutation.
   *  A no-op before the first load, which the scope effect below owns. */
  const reloadLevels = useCallback(async () => {
    // The whole-nest copy the filters use was read before this write.
    setFullNodes(null);
    if (!loadedFolders.current.size) return;
    await Promise.all([
      fetchCensus(),
      ...[...loadedFolders.current].map((f) => fetchLevel(f, { refresh: true })),
    ]);
  }, [fetchLevel, fetchCensus]);

  /** Node-id prefix for a folder share — see lib/folder-target.ts. */
  const shareTargetForFolder = (folderPath: string): string => {
    const inside = nodes.find((n) => {
      const f = folderOfNode(n.id || "");
      return f === folderPath || f.startsWith(`${folderPath}/`);
    });
    return folderGrantTarget(folderPath, inside?.id ?? null);
  };

  const openFolderInDocuments = (folder: string) => {
    setFolderFilter(folder);
    setActiveTab("documents");
  };

  const toggleFolderExpanded = (path: string) => {
    const opening = !expandedFolders.has(path);
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (opening) next.add(path);
      else next.delete(path);
      return next;
    });
    // Fetch outside the updater — React may run an updater twice.
    if (opening) void fetchLevel(path);
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
      setExpandedFolders((prev) => {
        if (prev.has(path)) return prev;
        return new Set(prev).add(path);
      });
      void fetchLevel(path);
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
  // A nest with no folders yet has nowhere to move a document to, so the
  // dialog can name a new destination itself — folders are path-derived, the
  // move creates it. "" = not creating one.
  const [moveNewFolder, setMoveNewFolder] = useState<string | null>(null);
  const moveNewFolderCheck = checkFolderPath(moveNewFolder ?? "");
  const moveResolvedDest =
    moveNewFolder === null ? moveDest : moveNewFolderCheck.path;

  const fetchData = useCallback(async () => {
    setLoading(true);
    // Nest meta first, because it says WHICH of the reads below the caller may
    // even make. Someone who reached this nest through a share grant on one
    // document (or one folder) is allowed the nest itself and their nodes, and
    // nothing else — every governance read 404s for them. Firing them anyway
    // cost seven pointless round-trips and surfaced the review queue's failure
    // as a "Nest not found" toast on a page that had loaded fine.
    const nestMeta = await qc.fetchQuery(reads.nest(nestId)).catch((e) => {
      console.error("[NestView] getNest failed", nestId, e);
      return null;
    });
    const grantOnly = !!(nestMeta as any)?.grant_only;
    // Each request is independently swallowed — if listNodes throws, we must
    // still apply stewardshipEnabled from the settings response. Previously a
    // single Promise.all + outer try/catch meant a node-list error silently
    // dropped the settings update, so toggling stewardship appeared to revert.
    const empty = <T,>(v: T) => Promise.resolve(v);
    const [, stewardsData, queueData, deletionData, settingsData, externalData, countsData, feedData] =
      await Promise.all([
        // The five reads below go through the shared cache (same keys and
        // invalidation as the hook-based screens) so returning from a document
        // paints from memory instead of re-fetching. Read imperatively rather
        // than via hooks to keep each call's own error fallback — a failing
        // node list must still let the settings response apply, per the note
        // above.
        // Documents come from the folder levels currently on screen, not one
        // whole-nest listing — see fetchLevel.
        reloadLevels(),
        grantOnly
          ? empty({ stewards: [] as Steward[] })
          : qc.fetchQuery(reads.stewards(nestId)).catch((e) => {
              console.error("[NestView] listStewards failed", nestId, e);
              return { stewards: [] };
            }),
        grantOnly
          ? empty({ requests: [], total: 0 })
          : qc.fetchQuery(reads.reviewQueue(nestId)).catch((e) => {
              console.error("[NestView] getReviewQueue failed", nestId, e);
              toast.error(e?.message || "Failed to load review queue");
              return { requests: [], total: 0 };
            }),
        // Pending AND declined in one call: pending drives the admin queue,
        // declined is how the person who asked learns the verdict.
        grantOnly
          ? empty({ requests: [] as api.DeletionRequest[], total: 0 })
          : qc.fetchQuery(reads.deletionRequests(nestId, "all")).catch((e) => {
              console.error("[NestView] getDeletionRequests failed", nestId, e);
              return { requests: [] as api.DeletionRequest[], total: 0 };
            }),
        grantOnly
          ? empty({
              stewardship_enabled: false,
              allow_self_approve: false,
              prime_only_review: false,
              prime_tags: [] as string[],
            })
          : qc.fetchQuery(reads.settings(nestId)).catch((e) => {
              console.error("[NestView] getNestSettings failed", nestId, e);
              return {
                stewardship_enabled: false,
                allow_self_approve: false,
                prime_only_review: false,
                prime_tags: [] as string[],
              };
            }),
        grantOnly
          ? empty({ entries: [], total: 0 })
          : qc.fetchQuery(reads.externalEdits(nestId)).catch((e) => {
              console.error("[NestView] listExternalEdits failed", nestId, e);
              return { entries: [], total: 0 };
            }),
        grantOnly
          ? empty({ counts: {} as Record<string, number> })
          : qc.fetchQuery(reads.commentCounts(nestId)).catch((e) => {
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
        grantOnly
          ? empty({
              items: [] as api.FeedItem[],
              counts: { changes: 0, comments: 0 },
            })
          : qc.fetchQuery(reads.feed(nestId, "comments")).catch((e) => {
              console.error("[NestView] getNestFeed failed", nestId, e);
              return {
                items: [] as api.FeedItem[],
                counts: { changes: 0, comments: 0 },
              };
            }),
      ]);
    setCommentCounts(countsData.counts);
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
      setReaderModeEnabled(!!(nestMeta.nest as any).reader_mode);
      setReaderHomeNode((nestMeta.nest as any).reader_home_node ?? null);
      setNestArchivedAt((nestMeta.nest as any).archived_at ?? null);
    }
    if (nestMeta?.permission) {
      setPermission(nestMeta.permission);
    }
    setRoles(nestMeta?.roles ?? []);
    setMyStewards((nestMeta?.myStewards ?? []) as Steward[]);
    setLoading(false);
    setInitialLoad(false);
  }, [nestId, qc, reloadLevels]);

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

  // A different nest, or a different scoped folder, is a different tree:
  // drop the loaded levels and open just the new base.
  useEffect(() => {
    loadedFolders.current = new Set();
    setExpandedFolders(new Set());
    setNodes([]);
    setFullNodes(null);
    void fetchLevel(folderFilter ?? "");
    void fetchCensus();
  }, [nestId, folderFilter, fetchLevel, fetchCensus]);

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

  const loadFullNest = useCallback(async () => {
    if (fullNodes || fullLoading) return;
    setFullLoading(true);
    try {
      const { nodes: all } = await qc.fetchQuery(reads.nodes(nestId));
      setFullNodes(all);
    } catch (e: any) {
      console.error("[NestView] listNodes failed", nestId, e);
      toast.error(e?.message || "Failed to search the whole nest");
    } finally {
      setFullLoading(false);
    }
  }, [nestId, qc, fullNodes, fullLoading]);


  const hasActiveFilters =
    !!search ||
    statusFilter !== "all" ||
    typeFilter !== "all" ||
    tagFilters.length > 0 ||
    authorFilter !== "all" ||
    dateFilter !== "any";

  useEffect(() => {
    if (hasActiveFilters) void loadFullNest();
  }, [hasActiveFilters, loadFullNest]);
  const updatedAfter = datePresetToEpoch(dateFilter, Date.now());
  // Status + tag filters always apply; with a query, a doc passes on an
  // instant client title/tag match OR a server content hit. Semantics of
  // the client match live in lib/node-filter (unit-tested).
  //
  // Unfiltered, the levels on screen ARE the answer; filtered, the answer
  // spans the nest, so use the full listing as soon as it lands.
  const filtered = visibleDocuments({
    levelNodes: nodes,
    fullNodes,
    folderFilter,
    search,
    status: statusFilter,
    type: typeFilter,
    author: authorFilter,
    tags: tagFilters,
    updatedAfter,
    contentHits,
  });

  // Sort the filtered list. "name" = title A–Z; "edited" = most-recently
  // edited first (updated_at already on each node); "comments" = most comment
  // threads first, tie-broken by most recent comment then title.
  const sorted = [...filtered];
  if (sortMode === "activity") {
    // Recent activity = the later of last edit and last comment, newest first.
    sorted.sort((a, b) =>
      activityTimestamp(b.updated_at, commentCounts[b.id]?.lastAt).localeCompare(
        activityTimestamp(a.updated_at, commentCounts[a.id]?.lastAt),
      ),
    );
  } else if (sortMode === "edited") {
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

  // Every folder in the nest, so the tree can show one whose documents have
  // never been fetched. Memoised — FolderTree keys a useMemo on this.
  const knownFolders = useMemo(
    () => (census?.folders ?? []).map((f) => ({ path: f.path, total: f.total })),
    [census],
  );

  // A folder level with no document of its own is normal — an imported nest
  // commonly keeps everything one level down. The tab is only truly empty
  // when there is no folder to open either, or when a filter matched nothing.
  const nothingToShow = documentsTabIsEmpty({
    visibleCount: filtered.length,
    folderCount: knownFolders.length,
    filtering: hasActiveFilters,
  });

  // Orphans + broken [[links]], client-side from the loaded list.
  // Only meaningful over the whole nest: on a partial list every link into
  // an unexpanded folder reads as broken, and every unloaded source makes a
  // loaded document look orphaned.
  const wikiHealth = useMemo(
    () => (fullNodes ? linkHealth(fullNodes) : { orphans: [], broken: [] }),
    [fullNodes],
  );

  // Every folder path in use (all prefixes, so intermediate levels with no
  // direct docs still appear) — options for the Move-to-folder dialog.
  const allFolders = useMemo(
    () => (census?.folders ?? []).map((f) => f.path).sort(byPathSegments),
    [census],
  );

  // Distinct authors for the author filter dropdown.
  const authors = census?.authors ?? [];

  // Distinct node types present (missing type = "document"), for the type
  // filter dropdown. Only offered when the nest actually mixes types.
  const typesPresent = useMemo(
    () => Object.keys(census?.types ?? {}).sort((a, b) => a.localeCompare(b)),
    [census],
  );

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
    tool: "Tool",
    table: "Table",
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

  // Tag counts + "recently edited" for the Documents tab's own facet bar,
  // derived from the FILTERED list (not the nest-wide census) so an active
  // status/type/author/date/search/tag filter narrows both the same way it
  // narrows the document list below them — down to empty when nothing matches.
  const documentFacetsForFilter = useMemo(
    () => documentFacets(filtered),
    [filtered],
  );
  const allTags = documentFacetsForFilter.tags;
  const documentsRecentlyEdited = documentFacetsForFilter.recent;

  // Quick-access strip; shown on the Overview tab as recently-edited rows.
  // Nest-wide on purpose — the Overview tab has no document filter of its
  // own, so this reflects the whole nest, unlike documentsRecentlyEdited above.
  const recentlyEdited = census?.recent ?? [];

  // Genuine, non-capped metric for the Overview stat tile: how many documents
  // were edited in the last 7 days across the whole nest. The recentlyEdited
  // strip above is sliced to 3 for display, so its length is not a real count.
  const recentlyEditedCount = census?.editedLast7d ?? 0;

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
  // Rules live in lib/nest-caps so the board (and any later nest-scoped view)
  // gates on exactly the same derivation instead of a lookalike copy.
  const caps = deriveNestCaps({
    roles,
    permission,
    myStewards,
    isOwner,
    isAdmin,
    readerMode: readerModeEnabled,
    isArchived: isArchived || isNestArchived({ archived_at: nestArchivedAt }),
  });
  // canReviewDocs is folded into isReadOnly inside caps; per-row review uses
  // canReviewNode for scope resolution, so it isn't destructured here.
  const { canManage, collabCanWrite, canEditDocs, isReadOnly, isReaderView } =
    caps;

  // Reader Mode has no tab strip to trigger a folder fetch, so a nest whose
  // docs all live one level down (the common docs-site shape) opens with
  // only the empty root level loaded — ReaderView renders nothing. Load the
  // nest's first top-level folder by default so there's something to read
  // without a click; ReaderView's onExpandFolder (below) covers the rest.
  useEffect(() => {
    if (!isReaderView) return;
    const first = firstTopLevelFolder(knownFolders);
    if (first) void fetchLevel(first.path);
  }, [isReaderView, knownFolders, fetchLevel]);

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
  const canEditNode = (node: { id: string; tags?: string[]; myGrant?: string | null }) => {
    if (!node) return false;
    // A write share grant is edit rights on this document specifically — it is
    // access, not stewardship, so it shows up in neither isReadOnly nor the
    // steward rows below. Checked before the read-only bail: a grant-only
    // caller always reads as "read" at nest level whatever their grant says.
    if (node.myGrant === "write") return true;
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

  // A shared ?tab= link can name a tab this viewer doesn't get (Stewards on a
  // nest they only read, Review Queue while read-only). Radix would render an
  // empty content area against a value with no trigger, so fall back to
  // overview once the permission flags have resolved.
  const tabVisible: Record<string, boolean> = {
    overview: true,
    documents: true,
    review: showReviewTab && !isReadOnly,
    "external-edits": !isReadOnly,
    stewards: stewardshipEnabled && canManageGovernance,
    collaborators: canManage || collabCanWrite,
  };
  useEffect(() => {
    if (!initialLoad && !tabVisible[activeTab]) setActiveTab("overview");
  }, [initialLoad, activeTab, tabVisible[activeTab]]);

  // Computed here so the Review Queue card binds to reviewableQueue.length
  // (what the user can actually act on) instead of reviewQueue.length
  // (raw size, which over-promised before — see CU-86ahn99fv).
  const stats = {
    total: census?.total ?? nodes.length,
    pending: census?.statuses?.pending_review ?? 0,
    // "published" is the engine's terminal post-approve status (approve writes
    // 'published'; no-steward creates auto-publish) — both mean AI-visible,
    // so the AI Ready card counts them together.
    approved:
      (census?.statuses?.approved ?? 0) + (census?.statuses?.published ?? 0),
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

  // Overview stat tile: Root is a synthetic tocGroups entry for docs with no
  // folder, not a user-created folder, so it's excluded from the count.
  const folderCount = census?.folders.length ?? 0;

  const openVersions = async (node: any) => {
    setVersionNode(node);
    try {
      const data = await qc.fetchQuery(reads.nodeVersions(nestId, node.id));
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

  // Cancel your own pending review — the document goes back to Draft rather
  // than Delete being the only way out (CU-wdqcq007pe).
  const withdrawSubmission = async (nodeId: string) => {
    try {
      await api.cancelReview(nestId, nodeId);
      toast.success("Submission withdrawn — back to Draft");
      fetchData();
    } catch (err: any) {
      console.error("[NestView] cancelReview failed", nestId, nodeId, err);
      toast.error(err?.message || "Failed to withdraw submission");
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

  // One decision over many documents. The server applies them item by item
  // through the same approve/reject the single-document flow uses, so partial
  // success is normal: report what failed and why, keep the successes, and
  // leave the failures selected so a second attempt is one click away.
  const runBulkReview = async (
    action: "approve" | "reject",
    note: string,
  ) => {
    const nodeIds = [...bulkSelected];
    const { succeeded, failed, results } = await api.bulkReview(
      nestId,
      action,
      nodeIds,
      note || undefined,
    );
    const verb = action === "approve" ? "approved" : "rejected";
    if (failed === 0) {
      toast.success(`${succeeded} document${succeeded === 1 ? "" : "s"} ${verb}`);
      setBulkSelected(new Set());
    } else {
      // Each distinct reason, not just the first — a mixed batch fails for
      // more than one.
      const reasons = [
        ...new Set(
          results.filter((r) => !r.ok).map((r) => r.error || "Unknown reason"),
        ),
      ];
      toast.warning(`${succeeded} ${verb}, ${failed} could not be`, {
        description: reasons.join(" "),
        duration: 10000,
      });
      setBulkSelected(new Set(results.filter((r) => !r.ok).map((r) => r.nodeId)));
    }
    setBulkAction(null);
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
    toast.success("Request rejected");
    fetchData();
  };

  // Withdraw own pending deletion request — owner's "undo" before an admin acts.
  const handleWithdrawDeletion = async (request: api.DeletionRequest) => {
    try {
      await api.withdrawDeletionRequest(nestId, request.id);
      toast.success("Deletion request withdrawn");
      fetchData();
    } catch (err: any) {
      toast.error(err?.message || "Failed to withdraw deletion request");
    }
  };

  // Inline visibility toggle from the header (owner/admin only). Optimistic
  // flip with revert on failure, mirroring ShareNestDialog so the control
  // never lies about server state. Surfaces the public/private switch outside
  // the Share dialog, where it was easy to miss. (CU-wdqcpztgwk)
  const applyVisibility = async (
    next: api.NestVisibility,
    acknowledgePublic?: boolean,
  ) => {
    const prev = visibility;
    setVisibility(next);
    setVisibilitySaving(true);
    try {
      const result = await api.setNestVisibility(
        nestId,
        next,
        acknowledgePublic,
      );
      if (result?.visibility) setVisibility(result.visibility);
    } catch (err: any) {
      setVisibility(prev); // revert
      toast.error(err?.message || "Failed to change visibility");
    } finally {
      setVisibilitySaving(false);
    }
  };

  const handleVisibilityToggle = async () => {
    // Going public makes the nest readable by anyone on the internet, outside
    // your organization — confirm first (and send acknowledge_public). Going
    // back to private is unguarded.
    // Minimal UX improvement: when the nest is Organization-visible, route to
    // the full three-tier control on the Collaborators tab so callers discover
    // the Private option too (org → private path). (Bugfix)
    if (visibility === "org") {
      setActiveTab("collaborators");
      return;
    }
    if (visibility !== "public") {
      setConfirmPublic(true);
      return;
    }
    await applyVisibility("private");
  };

  // Public Docs Reader Mode config (server admin, or this nest's own
  // owner/admin — see canManageReaderMode below). Optimistic flip with
  // revert on failure.
  const handleReaderModeToggle = async () => {
    const next = !readerModeEnabled;
    setReaderModeEnabled(next);
    setReaderModeSaving(true);
    try {
      const result = await api.setNestReaderMode(nestId, { enabled: next });
      setReaderModeEnabled(!!result.reader_mode);
      setReaderHomeNode(result.reader_home_node ?? null);
    } catch (err: any) {
      setReaderModeEnabled(!next); // revert
      toast.error(err?.message || "Failed to change reader mode");
    } finally {
      setReaderModeSaving(false);
    }
  };

  useEffect(() => {
    if (!readerDialogOpen || !readerHomeNode) {
      setReaderHomeTitle(null);
      return;
    }
    let cancelled = false;
    qc.fetchQuery(reads.node(nestId, readerHomeNode))
      .then(({ node }: any) => {
        if (!cancelled) setReaderHomeTitle(node?.title || readerHomeNode);
      })
      .catch(() => {
        if (!cancelled) setReaderHomeTitle(readerHomeNode);
      });
    return () => {
      cancelled = true;
    };
  }, [readerDialogOpen, readerHomeNode, nestId, qc]);

  const handleReaderHomeNodeSave = async (home: string | null) => {
    setReaderModeSaving(true);
    try {
      const result = await api.setNestReaderMode(nestId, { home_node: home });
      setReaderHomeNode(result.reader_home_node ?? null);
      toast.success("Saved reader home node");
    } catch (err: any) {
      toast.error(err?.message || "Failed to set reader home node");
    } finally {
      setReaderModeSaving(false);
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

  // Public Docs Reader Mode: a read-only caller of a reader-mode nest gets the
  // stripped docs reader instead of the full tabbed authoring layout. Gated on
  // caps.isReaderView (reader_mode && isReadOnly), so owners/editors/reviewers/
  // admins never lose the authoring UI.
  if (isReaderView) {
    return (
      <div className="relative">
        <div className="mb-3">
          <Button variant="ghost" size="sm" onClick={onBack} className="gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        </div>
        <ReaderView
          nestId={nestId}
          nestName={editableName}
          nodes={nodes}
          tocGroups={tocGroups}
          knownFolders={knownFolders}
          readerHomeNode={readerHomeNode}
          onExpandFolder={fetchLevel}
          loadingFolders={loadingFolders}
          loadedFolders={loadedFolderPaths}
        />
      </div>
    );
  }

  return (
    <div
      className="relative"
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
      {/* Header — the row shared by every nest-scoped page. Only the actions
          passed as children differ from Board/Graph/Definitions/Workflows. */}
      <NestPageHeader
        nestName={nestName}
        onBack={onBack}
        title={
          canManage ? (
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
                    skipNextFlush.arm();
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
          ) : undefined
        }
        badges={
          <>
          {/* Visibility — an inline toggle for owner/admin (so the public/
              private switch isn't buried in the Share dialog), a read-only
              badge for everyone else. */}
          {canManage ? (
            // Two-state on purpose: a header shortcut for the common flip,
            // private <-> public. An org nest routes to the full three-tier
            // control on the Collaborators tab instead (see
            // handleVisibilityToggle), since it can move either direction.
            // Choosing among all three tiers lives in NestVisibilityControl
            // (Collaborators tab / Share dialog), which is also where each
            // tier is explained.
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
                  : visibility === "org"
                    ? "Organization — everyone signed in to this deployment can read. Click to manage sharing (Collaborators tab)."
                    : "Private. Click to make public (anyone with the URL can read)."
              }
            >
              {visibilitySaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : visibility === "public" ? (
                <Globe className="h-3.5 w-3.5" />
              ) : visibility === "org" ? (
                <Building2 className="h-3.5 w-3.5" />
              ) : (
                <Lock className="h-3.5 w-3.5" />
              )}
              {visibility === "public"
                ? "Public"
                : visibility === "org"
                  ? "Organization"
                  : "Private"}
            </Button>
          ) : (
            visibility !== "private" && (
              <Badge
                variant="outline"
                // Green for public, blue for org — same pairing the dashboard
                // card badge uses, so the two tiers never read as one colour.
                className={`shrink-0 gap-1 ${
                  visibility === "public"
                    ? "border-green-200 bg-green-50 text-green-700"
                    : "border-blue-200 bg-blue-50 text-blue-700"
                }`}
                title={
                  visibility === "public"
                    ? "Anyone with the URL can read this nest"
                    : "Everyone signed in to this deployment can read this nest"
                }
              >
                {visibility === "public" ? (
                  <Globe className="h-3 w-3" />
                ) : (
                  <Building2 className="h-3 w-3" />
                )}
                {visibility === "public" ? "Public" : "Organization"}
              </Badge>
            )
          )}
          {/* Public Docs Reader Mode config — server admin, or this nest's own
              owner/admin (see canManageReaderMode). A menu rather than a
              toggle: the landing document is part of the same setting, and
              changing it must not mean switching reader mode off and on
              again. */}
          {canManageReaderMode && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setReaderDialogOpen(true)}
              className={`shrink-0 h-7 gap-1.5 ${
                readerModeEnabled
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                  : ""
              }`}
              title="Public Docs Reader Mode — the clean, read-only docs view public readers get."
            >
              {readerModeSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <BookOpen className="h-3.5 w-3.5" />
              )}
              {readerModeEnabled ? "Reader: On" : "Reader: Off"}
            </Button>
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
          {/* Same flag a doc/folder row gets — the requester's only sign their
              request is still waiting on an admin. An ARCHIVE ask is reversible,
              so it says so and drops the red: telling every viewer the nest is
              up for permanent deletion would be plainly wrong. */}
          {nestFlag && (() => {
            const isOwn = nestFlag.requestedBy.toLowerCase() === currentEmail;
            const isArchiveAsk = nestFlag.targetType === "nest_archive";
            const verb = isArchiveAsk ? "archived" : "deleted";
            return (
              <Badge
                variant="outline"
                className={`shrink-0 gap-1 ${
                  isArchiveAsk
                    ? "border-amber-200 bg-amber-50 text-amber-700"
                    : "border-red-200 bg-red-50 text-red-700"
                } ${isOwn ? "cursor-pointer hover:opacity-80" : ""}`}
                title={
                  isOwn
                    ? `Click to withdraw your ${isArchiveAsk ? "archive" : "deletion"} request`
                    : `${nestFlag.requestedBy} asked for this nest to be ${verb}: "${nestFlag.reason}". A nest owner or admin decides.`
                }
                data-testid="nest-deletion-flag"
                onClick={isOwn ? () => handleWithdrawDeletion(nestFlag) : undefined}
              >
                {isArchiveAsk ? (
                  <Archive className="h-3 w-3" />
                ) : (
                  <Trash2 className="h-3 w-3" />
                )}
                {isArchiveAsk ? "Archive requested" : "Deletion requested"}
                {isOwn && <X className="h-3 w-3 ml-0.5" />}
              </Badge>
            );
          })()}
          </>
        }
      >
          {/* Connect (external clients) and Add-with-AI (seed content) are
              distinct first-class actions — Connect wires tools, Add-with-AI
              generates context into the nest. */}
          <Button variant="outline" size="sm" onClick={() => setShowConnect(true)}>
            <Link2 className="h-3.5 w-3.5 mr-1.5" />
            Connect
          </Button>
          {!isReadOnly && (
            <Button variant="outline" size="sm" onClick={() => setShowGenerate(true)}>
              <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              Add with AI
            </Button>
          )}
          {canManage && (
            // Inside the nest, Share IS the Collaborators tab — one surface
            // for visibility, people and teams (CU-wdqcpzzzy6).
            <Button
              variant="outline"
              size="sm"
              onClick={() => setActiveTab("collaborators")}
            >
              <Users className="h-3.5 w-3.5 mr-1.5" />
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
                  <Button variant="outline" size="sm" data-testid="nest-import-files">
                    <Upload className="h-3.5 w-3.5 mr-1.5" />
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
              <Button
                size="sm"
                // Default into the folder the Documents tab is scoped to, so a
                // doc lands where the user is looking (CU-wdqcq0247w). The
                // editor's folder picker still lets them change it.
                onClick={() =>
                  onOpenDocument("new", {
                    folder:
                      activeTab === "documents" && folderFilter
                        ? folderFilter
                        : undefined,
                  })
                }
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
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
            // outright, an editor raises a request an owner/admin actions.
            // Hidden below owner once a nest flag is already pending, and
            // withheld from viewers and reviewer-only stewards — neither may
            // ask for a nest to be destroyed (canRequestDeletion). Also
            // withheld outright when read-only (e.g. an archived nest) —
            // canDeleteNest/canEditDocs don't fold in isArchived themselves.
            if (
              !isReadOnly &&
              (canDeleteNest || canEditDocs) &&
              (canDeleteNest || !nestFlagPending)
            )
              actions.push({
                label: "Delete",
                icon: Trash2,
                destructive: canDeleteNest,
                separatorBefore: true,
                onSelect: () =>
                  canDeleteNest ? setShowDelete(true) : setNestFlagOpen(true),
              });
            return (
              <OverflowMenu
                actions={actions}
                variant="outline"
                className="h-8 w-8"
              />
            );
          })()}
      </NestPageHeader>

      {/* Stats Cards — only governance-related stats when stewardship is on.
          In ungoverned mode every doc is auto-approved so the pending/review
          columns are always zero and just add noise. */}
      <div
        className={`grid grid-cols-1 gap-4 mb-4 ${stewardshipEnabled
          ? "md:grid-cols-4"
          : "md:grid-cols-1 max-w-sm"
          }`}
      >
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Documents</CardDescription>
            {/* initialLoad, not `loading`: a background refetch keeps the real
                numbers on screen, and only a cold load — where every stat is
                still 0 — shows the placeholder. */}
            <CardTitle className="text-3xl">
              {initialLoad ? <CountSkeleton className="h-8 w-12" /> : stats.total}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <FileText className="h-4 w-4" />
              {/* An empty nest has nothing to be approved or AI-ready, so the
                  readiness line would be a promise about content that isn't
                  there — say what's true instead (CU-wdqcq00x8y). */}
              <span>
                {/* Gated on the same cold-load flag as the count above: every
                    stat is 0 until the first read lands, and claiming an empty
                    nest before then is wrong on a slow connection. */}
                {initialLoad
                  ? "Loading…"
                  : stats.total === 0
                    ? "No documents yet"
                    : stewardshipEnabled
                      ? "In your context"
                      : "Auto-approved, AI-ready"}
              </span>
            </div>
          </CardContent>
        </Card>
        {stewardshipEnabled && (
          <>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Pending Approvals</CardDescription>
                <CardTitle className="text-3xl text-amber-600">
                  {initialLoad ? (
                    <CountSkeleton className="h-8 w-12" />
                  ) : (
                    stats.pending
                  )}
                </CardTitle>
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
                <CardTitle className="text-3xl text-green-600">
                  {initialLoad ? (
                    <CountSkeleton className="h-8 w-12" />
                  ) : (
                    stats.approved
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>
                    {initialLoad
                      ? "Loading…"
                      : stats.total === 0
                        ? "Nothing to evaluate yet"
                        : "Approved for AI"}
                  </span>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Your Review Queue</CardDescription>
                <CardTitle className="text-3xl text-blue-600">
                  {initialLoad ? (
                    <CountSkeleton className="h-8 w-12" />
                  ) : (
                    stats.reviewable
                  )}
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
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full min-w-0">
        {/* New Folder sits beside the tab row — it acts on the content area
            below (Overview/Documents), not on the nest as a whole.
            The triggers never wrap, so on a narrow window the row scrolls
            inside itself rather than making the whole page scroll sideways —
            page-level overflow drags fixed UI (toasts, dialogs) off-screen
            with it. */}
        <div className="flex items-center gap-2 mb-4 min-w-0">
          <TabsList className="max-w-full justify-start overflow-x-auto">
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
              className="ml-auto shrink-0 text-muted-foreground"
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
                        {folderCount}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        Folder{folderCount === 1 ? "" : "s"}
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
                  {stats.total === 0 ? (
                    <div className="py-8 text-center">
                      <FileText className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
                      <p className="text-sm text-muted-foreground">
                        No documents yet.
                      </p>
                      {/* The header's New Document button is right there, so
                          offer the action itself rather than directions to it.
                          Read-only callers get the bare line. */}
                      {!isReadOnly && canEditDocs && (
                        <Button
                          className="mt-3"
                          size="sm"
                          onClick={() => onOpenDocument("new")}
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          New Document
                        </Button>
                      )}
                    </div>
                  ) : (
                    <FolderTree
                      className="space-y-1"
                      groups={tocGroups}
                      known={knownFolders}
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
                      setSortMode(v as "activity" | "name" | "edited" | "comments")
                    }
                  >
                    <SelectTrigger className="w-[150px] h-8" title="Sort documents">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="activity">Recent activity</SelectItem>
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
              {documentsRecentlyEdited.length > 0 && (
                <div className="flex items-center flex-wrap gap-1.5 mb-3 text-xs">
                  <span className="text-muted-foreground">Recently edited:</span>
                  {documentsRecentlyEdited.map((n) => (
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
              {initialLoad || loadingFolders.has(baseFolder) ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : nothingToShow ? (
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
                  // ONE Delete action for everyone who gets one. Admins get the
                  // delete confirm, editors get the request dialog — which one
                  // opens is the dialog's job to explain, not two menu items'.
                  // Hidden below admin once a flag is open (a second 409s), and
                  // hidden outright for viewers of any kind: proposing a
                  // deletion is an editor's act, and the server refuses them
                  // (canRequestDeletion), so the affordance would only lead to
                  // a 403. Also hidden outright when read-only (e.g. an
                  // archived nest) — canDelete's authoredByMe branch and
                  // canEditNode's per-document write-grant branch don't fold
                  // in isReadOnly themselves.
                  const showDeleteAction =
                    !isReadOnly &&
                    (canDelete || canEditNode(node)) && (canDelete || !flagPending);
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
                    setMoveNewFolder(null);
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
                          {canManage && (
                            <DropdownMenuItem onSelect={() => setPublishNode(node)}>
                              <Share2 className="h-3.5 w-3.5 mr-2" />
                              Publish
                            </DropdownMenuItem>
                          )}
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
                          {flagPending && (() => {
                            const isOwnFlag = flag!.requestedBy.toLowerCase() === currentEmail;
                            return (
                              <span
                                className={`shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide border bg-red-50 text-red-700 border-red-200 ${isOwnFlag ? "cursor-pointer hover:bg-red-100" : ""}`}
                                title={
                                  isOwnFlag
                                    ? "Click to withdraw your deletion request"
                                    : `${flag!.requestedBy} asked for this to be deleted: "${flag!.reason}". A nest admin decides.`
                                }
                                data-testid={`deletion-flag-${node.id}`}
                                onClick={
                                  isOwnFlag
                                    ? (e) => {
                                        e.stopPropagation();
                                        handleWithdrawDeletion(flag!);
                                      }
                                    : undefined
                                }
                              >
                                <Trash2 className="h-3 w-3" />
                                Deletion requested
                                {isOwnFlag && <X className="h-3 w-3 ml-0.5" />}
                              </span>
                            );
                          })()}
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
                      // Unfiltered, the tree is seeded with every folder in the
                      // nest so one whose documents were never fetched still has
                      // a row to expand. Under a filter that seeding is wrong
                      // twice over: it lists folders holding no match, and it
                      // suppresses chain compaction, so a single hit four levels
                      // down costs four rows of empty scaffolding. A filtered
                      // list already answers from the whole nest, so drop the
                      // seed and let the tree show only folders that matched —
                      // as one "F1 / F2 / F3" row per chain.
                      known={hasActiveFilters ? undefined : knownFolders}
                      isCollapsed={(p) =>
                        // A filtered list shows every match, wherever it lives.
                        hasActiveFilters ? false : !expandedFolders.has(p)
                      }
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
                        // Anything with documents under it opens — the subtree
                        // total, not the loaded count, because a folder's own
                        // documents are only fetched once it is expanded. A
                        // genuinely empty folder stays a static row, no chevron.
                        const collapsible = node.total > 0;
                        const loadingHere = loadingFolders.has(node.path);
                        return (
                          <div
                            className={`group/fh flex items-center gap-1.5 py-1.5 px-2 rounded-md select-none transition-colors ${collapsible ? "cursor-pointer" : ""
                              } ${isDropTarget
                                ? "bg-primary/10 ring-1 ring-primary"
                                : "hover:bg-muted/50"
                              }`}
                            onClick={
                              collapsible
                                ? () => toggleFolderExpanded(node.path)
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
                            {loadingHere ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                            ) : collapsible ? (
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
                            {/* Share the folder with one person — they reach
                                everything under it and nothing else in the
                                nest. Owner/admin only, matching /grants. */}
                            {canManage && (
                              <button
                                type="button"
                                className="rounded p-0.5 text-muted-foreground opacity-0 group-hover/fh:opacity-100 hover:text-primary hover:bg-primary/10"
                                title={`Share ${prettyFolderPath(node.path)} with someone`}
                                data-testid={`share-folder-${node.path}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setShareFolder({
                                    // The row's own label, not the whole path:
                                    // an imported nest's paths can be long and
                                    // id-prefixed, which made the title
                                    // unreadable. The exact target is shown in
                                    // the dialog body instead.
                                    path: shareTargetForFolder(node.path),
                                    label: node.label || prettyFolder(node.name),
                                  });
                                }}
                              >
                                <Share2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                            {/* Same split as a document: admins/owners delete
                                the folder (and everything under it), editors
                                raise a request. Hidden while one is already
                                pending, and withheld from viewers — the server
                                refuses a folder flag below editor, and a
                                folder-scope editor row isn't enough for it
                                either (canRequestDeletion wants nest scope). */}
                            {(canManage || canEditDocs) &&
                              (canManage || !folderFlagPending(node.path)) && (
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
                            {folderFlagPending(node.path) && (() => {
                              const folderFlag = folderFlagByPath.get(node.path);
                              const isOwnFlag = folderFlag?.requestedBy.toLowerCase() === currentEmail;
                              return (
                                <span
                                  className={`inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide bg-red-50 text-red-700 border border-red-200 ${isOwnFlag ? "cursor-pointer hover:bg-red-100" : ""}`}
                                  title={
                                    isOwnFlag
                                      ? "Click to withdraw your deletion request"
                                      : "Someone asked for this folder to be deleted. A nest admin decides."
                                  }
                                  onClick={
                                    isOwnFlag && folderFlag
                                      ? (e) => {
                                          e.stopPropagation();
                                          handleWithdrawDeletion(folderFlag);
                                        }
                                      : undefined
                                  }
                                >
                                  <Trash2 className="h-3 w-3" />
                                  Deletion requested
                                  {isOwnFlag && <X className="h-3 w-3 ml-0.5" />}
                                </span>
                              );
                            })()}
                          </div>
                        );
                      }}
                      renderDoc={(n) => renderDocRow(n, 0)}
                    />
                  </div>
                );
              })()}

              {/* Wiki link health — orphans + broken [[links]]. Answering it
                  needs every document's body, so opening the block is what
                  fetches the whole nest. */}
              {!loading && stats.total > 0 && (
                  <details
                    className="mt-4 text-xs text-muted-foreground"
                    onToggle={(e) => {
                      if (e.currentTarget.open) void loadFullNest();
                    }}
                  >
                    <summary className="cursor-pointer select-none">
                      {fullLoading
                        ? "Link health: checking the whole nest…"
                        : !fullNodes
                          ? "Link health — check the whole nest"
                          : `Link health: ${wikiHealth.broken.length} broken link${wikiHealth.broken.length !== 1 ? "s" : ""} · ${wikiHealth.orphans.length} orphan doc${wikiHealth.orphans.length !== 1 ? "s" : ""}`}
                    </summary>
                    <div className="mt-2 space-y-2 pl-1">
                      {fullNodes &&
                        wikiHealth.broken.length === 0 &&
                        wikiHealth.orphans.length === 0 && (
                          <div>No broken links or orphan documents.</div>
                        )}
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
                    Your edits are awaiting review by another user. You can't
                    approve your own work due to separation of duties.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {myPendingSubmissions.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted/50"
                    >
                      <button
                        onClick={() => onOpenDocument(r.nodeId)}
                        className="flex-1 min-w-0 text-left truncate"
                      >
                        {r.title || r.nodeId}
                      </button>
                      <Badge variant="secondary" className="text-[10px] shrink-0">
                        Awaiting review
                      </Badge>
                      {/* Your own submission, so the non-destructive exit
                          belongs here too (CU-wdqcq007pe). */}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="shrink-0 h-7 px-2 text-muted-foreground"
                        title="Withdraw this submission and return the document to Draft"
                        onClick={() => void withdrawSubmission(r.nodeId)}
                      >
                        Withdraw
                      </Button>
                    </div>
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
                    Documents flagged as stale. Delete them, or reject with a
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
                              {r.targetType === "folder"
                                ? "Folder"
                                : r.targetType === "nest_archive"
                                  ? "Archive nest"
                                  : "Nest"}
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
                        Reject
                      </Button>
                      {/* Honouring an archive ask archives — reversible, so it
                          is an approval, not a destructive action. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className={
                          r.targetType === "nest_archive"
                            ? ""
                            : "text-destructive hover:text-destructive hover:bg-destructive/10"
                        }
                        onClick={() =>
                          setResolveTarget({ request: r, action: "delete" })
                        }
                      >
                        {r.targetType === "nest_archive" ? "Approve" : "Delete"}
                      </Button>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
            {/* Bulk bar — only with something selectable, and it stays out of
                the way until the first row is picked. */}
            {feedFilter !== "comments" && reviewableQueue.length > 1 && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
                <Checkbox
                  // Partial selections read as "some", not "none".
                  checked={
                    bulkSelected.size === 0
                      ? false
                      : bulkSelected.size === reviewableQueue.length
                        ? true
                        : "indeterminate"
                  }
                  onCheckedChange={(next: boolean | "indeterminate") =>
                    setBulkSelected(
                      next === true
                        ? new Set(reviewableQueue.map((r) => r.nodeId))
                        : new Set(),
                    )
                  }
                  aria-label="Select every document you can review"
                  data-testid="review-queue-select-all"
                />
                <span className="text-muted-foreground">
                  {bulkSelected.size > 0
                    ? `${bulkSelected.size} selected`
                    : `Select all ${reviewableQueue.length}`}
                </span>
                {bulkSelected.size > BULK_REVIEW_LIMIT && (
                  <span className="text-destructive">
                    Up to {BULK_REVIEW_LIMIT} at a time — deselect{" "}
                    {bulkSelected.size - BULK_REVIEW_LIMIT}.
                  </span>
                )}
                {bulkSelected.size > 0 && (
                  <div className="ml-auto flex items-center gap-2">
                    <Button
                      size="sm"
                      disabled={bulkSelected.size > BULK_REVIEW_LIMIT}
                      onClick={() => setBulkAction("approve")}
                      data-testid="bulk-approve"
                    >
                      Approve {bulkSelected.size}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={bulkSelected.size > BULK_REVIEW_LIMIT}
                      onClick={() => setBulkAction("reject")}
                      data-testid="bulk-reject"
                    >
                      Reject {bulkSelected.size}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBulkSelected(new Set())}
                    >
                      Clear
                    </Button>
                  </div>
                )}
              </div>
            )}
            <ReviewQueue
              requests={feedFilter === "comments" ? [] : reviewableQueue}
              selectedNodeIds={bulkSelected}
              // Rows only offer a checkbox when there is a batch to make — one
              // reviewable document has no bar to act on the selection, so a
              // box there is a dead end.
              onToggleSelect={
                reviewableQueue.length > 1
                  ? (nodeId) =>
                      setBulkSelected((prev) => {
                        const next = new Set(prev);
                        next.has(nodeId) ? next.delete(nodeId) : next.add(nodeId);
                        return next;
                      })
                  : undefined
              }
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
                // Not in the loaded levels. Under lazy loading that usually
                // just means its folder was never expanded, so open the
                // document itself rather than calling it missing.
                onOpenDocument(req.nodeId);
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
                  {reviewQueue.length === 1
                    ? "1 pending review in this nest, but it doesn't require your action — it's either outside your steward scope or was submitted by you."
                    : `${reviewQueue.length} pending reviews in this nest, but none require your action — they're either outside your steward scope or were submitted by you.`}
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
                {/* Two lines, not one paragraph — the stewardship caveat read
                    as an aside and was missed (CU-wdqcq018qu). */}
                <CardDescription className="space-y-1">
                  <span className="block">
                    <strong className="font-medium text-foreground">
                      Who can access this nest
                    </strong>{" "}
                    — visibility and access for people and teams. Sharing
                    grants viewer, editor or admin access.
                  </span>
                  <span className="block">
                    <strong className="font-medium text-foreground">
                      Stewardship
                    </strong>{" "}
                    — sharing does not make anyone a steward.
                    {stewardshipEnabled ? (
                      " Stewards are assigned on the Stewards tab."
                    ) : canManageGovernance ? (
                      // Naming the setting without a way to reach it left the
                      // reader hunting through a menu (CU-wdqcq01e75). Only
                      // owner/admin can open it, so only they get the link.
                      <>
                        {" "}
                        Turn on Stewardship &amp; Approval Workflow in{" "}
                        <button
                          type="button"
                          onClick={() => setShowSettings(true)}
                          className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
                        >
                          Nest settings
                        </button>{" "}
                        to use stewards.
                      </>
                    ) : (
                      " Stewardship & Approval Workflow is off for this nest — an owner or admin can turn it on in Nest settings."
                    )}
                  </span>
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Visibility lives here rather than only in the Share dialog,
                    so access management is one surface (CU-wdqcpzzzy6). */}
                {canManage && (
                  <NestVisibilityControl
                    nestId={nestId}
                    onChanged={fetchData}
                    onError={(msg) => msg && toast.error(msg)}
                  />
                )}
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
          nestId={nestId}
          nestName={nestName}
          onManageKeys={
            onManageKeys &&
            (() => {
              setShowConnect(false);
              onManageKeys();
            })
          }
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

      {shareFolder && (
        <ShareTargetDialog
          nestId={nestId}
          targetType="folder"
          target={shareFolder.path}
          label={shareFolder.label}
          onClose={() => setShareFolder(null)}
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
          // Same dialog, softer option: archiving leaves the nest intact, so
          // land back on the dashboard rather than in a nest gone read-only.
          onArchived={() => {
            setShowDelete(false);
            toast.success(`"${nestName}" archived — find it under Archived`);
            onBack();
          }}
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
            <code className="text-xs">gtm/deals</code>. It starts empty; add
            documents to it whenever you like.
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
          {newFolderCheck.error ? (
            <p className="text-xs text-destructive" data-testid="new-folder-error">
              {newFolderCheck.error}
            </p>
          ) : newFolderCheck.rewritten && newFolderCheck.path ? (
            <p className="text-xs text-muted-foreground" data-testid="new-folder-preview">
              Will be created as{" "}
              <code className="font-mono">{newFolderCheck.path}</code>
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowNewFolder(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void createFolder()}
              disabled={
                creatingFolder || !newFolderCheck.path || !!newFolderCheck.error
              }
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

      {/* Reader mode settings — the switch and the landing document in one
          place, so changing the home document never means turning the mode off
          and on again. */}
      <Dialog open={readerDialogOpen} onOpenChange={setReaderDialogOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Public Docs Reader Mode</DialogTitle>
            <DialogDescription>
              A clean, read-only docs view for people who can only read this
              nest. Owners, editors and reviewers keep the full authoring UI,
              and reader mode grants no access on its own.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border p-4 flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label className="text-sm font-medium">Reader mode</Label>
              <p className="text-xs text-muted-foreground">
                {readerModeEnabled
                  ? "Read-only visitors get the docs reader."
                  : "Everyone gets the standard nest view."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {readerModeSaving && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              )}
              <Switch
                checked={readerModeEnabled}
                onCheckedChange={() => void handleReaderModeToggle()}
                disabled={readerModeSaving}
                aria-label="Toggle Public Docs Reader Mode"
              />
            </div>
          </div>

          {readerModeEnabled && (
            <div className="rounded-lg border p-4 space-y-2">
              <Label className="text-sm font-medium">Home document</Label>
              <p className="text-xs text-muted-foreground">
                Reader mode opens on this document and keeps it in the side
                pane. Left unset, it resolves one by convention (welcome /
                index / readme / home / overview).
              </p>
              <div className="flex items-center gap-2 pt-1">
                <div className="min-w-0 flex-1 truncate text-sm">
                  {readerHomeNode ? (
                    (readerHomeTitle ?? "Loading…")
                  ) : (
                    <span className="text-muted-foreground">
                      Resolved by convention
                    </span>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setHomeNodePickerOpen(true)}
                  disabled={readerModeSaving}
                >
                  {readerHomeNode ? "Change" : "Choose"}
                </Button>
                {readerHomeNode && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void handleReaderHomeNodeSave(null)}
                    disabled={readerModeSaving}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setReaderDialogOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reader mode's landing document, picked from the real document list —
          the field used to take a hand-typed node id, so a title people could
          see on the page ("Product Capabilities") was refused as missing. */}
      {homeNodePickerOpen && (
        <DocumentPickerModal
          isOpen={homeNodePickerOpen}
          onClose={() => setHomeNodePickerOpen(false)}
          nestId={nestId}
          title="Choose the reader home document"
          description="Reader mode opens on this document and keeps it in the side pane. Close without picking to resolve one by convention (welcome / index / readme / home / overview)."
          onSelect={(node) => {
            setReaderHomeTitle(node.title);
            void handleReaderHomeNodeSave(node.id);
          }}
        />
      )}

      {/* Outside-org publish acknowledgement — flipping a nest to public makes
          it readable by anyone on the internet, outside your organization.
          Confirm sends acknowledge_public:true; the server 409s without it. */}
      <AlertDialog open={confirmPublic} onOpenChange={setConfirmPublic}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Make this nest public?</AlertDialogTitle>
            <AlertDialogDescription>
              This makes the nest readable by anyone on the internet, outside
              your organization. Anyone with the URL will be able to read it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmPublic(false);
                void applyVisibility("public", true);
              }}
            >
              Make public
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
            value={
              moveNewFolder !== null
                ? "__new__"
                : moveDest === ""
                  ? "__root__"
                  : moveDest
            }
            onValueChange={(v) => {
              if (v === "__new__") {
                setMoveNewFolder("");
                return;
              }
              setMoveNewFolder(null);
              setMoveDest(v === "__root__" ? "" : v);
            }}
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
              {/* Below the rule: the entries above are destinations, this one
                  starts a different flow. Undifferentiated, it read as one
                  more existing folder. */}
              <SelectSeparator />
              <SelectItem value="__new__">
                <span className="inline-flex items-center gap-1.5">
                  <FolderPlus className="h-3.5 w-3.5" />
                  New folder…
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
          {moveNewFolder !== null && (
            <>
              <Input
                autoFocus
                value={moveNewFolder}
                onChange={(e) => setMoveNewFolder(e.target.value)}
                placeholder="e.g. gtm/deals"
                className="font-mono"
                data-testid="move-folder-new-path"
              />
              {moveNewFolderCheck.error ? (
                <p className="text-xs text-destructive">
                  {moveNewFolderCheck.error}
                </p>
              ) : moveNewFolderCheck.rewritten && moveNewFolderCheck.path ? (
                <p className="text-xs text-muted-foreground">
                  Will be created as{" "}
                  <code className="font-mono">{moveNewFolderCheck.path}</code>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  The folder is created by the move — nest it with a slash.
                </p>
              )}
            </>
          )}
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
                folderOfNode(moveTarget.id) === moveResolvedDest ||
                (moveNewFolder !== null &&
                  (!moveNewFolderCheck.path || !!moveNewFolderCheck.error))
              }
              onClick={async () => {
                if (!moveTarget) return;
                setMovingDoc(true);
                const ok = await handleMoveNode(moveTarget.id, moveResolvedDest);
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

      {publishNode && (
        <PublishDialog
          nestId={nestId}
          nodeId={publishNode.id}
          nodeTitle={publishNode.title || publishNode.id}
          onClose={() => setPublishNode(null)}
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

      {bulkAction && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setBulkAction(null)}
          title={
            bulkAction === "approve"
              ? `Approve ${bulkSelected.size} document${bulkSelected.size === 1 ? "" : "s"}?`
              : `Reject ${bulkSelected.size} document${bulkSelected.size === 1 ? "" : "s"}?`
          }
          description={
            bulkAction === "approve"
              ? "Approving publishes each one. Anything you can't review, or that changed since this queue loaded, is reported back and left alone."
              : "Each author gets the same reason and the work goes back to them."
          }
          // Reject demands a reason in bulk exactly as it does one at a time.
          // Approve offers the same comment field the one-at-a-time flow has —
          // shared across the batch — without demanding one.
          label={bulkAction === "reject" ? "Why?" : "Comment (optional)"}
          optionalReason={bulkAction === "approve"}
          placeholder="Shared with every author in this batch"
          confirmLabel={bulkAction === "approve" ? "Approve all" : "Reject all"}
          destructive={bulkAction === "reject"}
          onConfirm={(reason) => runBulkReview(bulkAction, reason)}
        />
      )}

      {nestFlagOpen && (
        <ReasonDialog
          open
          onOpenChange={setNestFlagOpen}
          title={`Request removal of "${nestName}"`}
          description="A nest owner or admin reviews this. Nothing is removed yet — ask for the nest to be archived (reversible, nothing deleted) or deleted outright."
          label="Why should it be removed?"
          placeholder="e.g. project wound down, superseded by another nest"
          confirmLabel="Request deletion"
          secondaryLabel="Request archive"
          onSecondary={async (reason) => {
            await api.requestTargetDeletion(nestId, "nest_archive", nestId, reason);
            toast.success("Archive requested — a nest admin will review it");
            fetchData();
          }}
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
          description="A nest admin reviews this and either deletes the document or rejects with a note. Nothing is removed yet."
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
          // Honouring an archive request archives — the confirm has to say so,
          // or the reviewer reads "cannot be undone" about a reversible action.
          title={
            resolveTarget.action !== "delete"
              ? "Reject this request"
              : resolveTarget.request.targetType === "nest_archive"
                ? `Archive "${resolveTarget.request.title || resolveTarget.request.nodeId}"?`
                : `Delete "${resolveTarget.request.title || resolveTarget.request.nodeId}"?`
          }
          description={
            resolveTarget.action !== "delete"
              ? `${resolveTarget.request.requestedBy} asked for this: "${resolveTarget.request.reason}". The document stays; your note is the record.`
              : resolveTarget.request.targetType === "nest_archive"
                ? `${resolveTarget.request.requestedBy} asked for this: "${resolveTarget.request.reason}". The nest goes read-only and leaves the dashboard; nothing is deleted and you can restore it.`
                : `${resolveTarget.request.requestedBy} asked for this: "${resolveTarget.request.reason}". Deleting cannot be undone.`
          }
          // No label on the delete branch — that dialog is a plain confirm.
          label={
            resolveTarget.action === "decline"
              ? "Why are you rejecting?"
              : undefined
          }
          placeholder="e.g. still referenced by onboarding"
          confirmLabel={
            resolveTarget.action !== "delete"
              ? "Reject"
              : resolveTarget.request.targetType === "nest_archive"
                ? "Archive nest"
                : "Delete document"
          }
          destructive={
            resolveTarget.action === "delete" &&
            resolveTarget.request.targetType !== "nest_archive"
          }
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
          onDiscard={async () => {
            if (!versionNode) return;
            try {
              const { version } = await api.discardDraft(nestId, versionNode.id);
              toast.success(`Draft discarded — back to version ${version}`);
              await openVersions(versionNode);
              fetchData();
            } catch (e: any) {
              toast.error(e?.message || "Discard failed");
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
  const qc = useQueryClient();

  // The row that opened this modal comes from the document list, which carries
  // metadata only — a body per row costs a file read per row, and nothing in
  // the list renders one. A reviewer decides on the TEXT, so fetch it for this
  // one document, on open. Falls back to a body the caller already had, so a
  // row that does carry one renders without a round trip.
  const { data: full, isLoading: bodyLoading } = useQuery({
    ...reads.node(nestId, node.id),
    enabled: !node.content,
  });
  const body = node.content || full?.node?.content || "";

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
      // Full list + shared id/title/slug resolver (same rule as the editor) so
      // a [[nodes/slug]] or slug-form link resolves here too, not title-only.
      const { nodes } = await qc.fetchQuery(reads.nodes(nestId));
      const exact = resolveWikiTarget(
        nodes as Array<{ id: string; title: string }>,
        title,
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
          {body ? (
            <MarkdownEditor
              // Remount when the reviewer switches between docs in the
              // queue. Same modal instance otherwise → TipTap keeps its
              // previous doc's editor state and the body briefly shows
              // the wrong content on swap.
              key={node.id}
              content={body}
              onChange={() => { }}
              editable={false}
              nestId={nestId}
              onWikiLinkClick={handleWikiLinkClick}
            />
          ) : bodyLoading ? (
            // Distinct from "(no content)": approving on the strength of an
            // empty box that was merely still loading is the one mistake this
            // modal must not invite.
            <p className="text-sm text-muted-foreground p-4">Loading content…</p>
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
