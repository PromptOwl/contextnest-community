/**
 * NestView — governance dashboard for a single nest.
 * Uses ported PromptOwl components for the UI, wired to REST API.
 */
import { Suspense, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { NestVisibilityControl } from "./NestVisibilityControl";
import { lazyChunk } from "../lib/lazy-chunk";
import { OrgContributorPanel } from "./OrgContribution";
import * as api from "../lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { reads } from "../lib/queries";
import { nestRelation, nestRelationText } from "../lib/dashboard-scope";
import { matchesFilters } from "../lib/node-filter";
import { reviewIdFromSearch, withReviewParam } from "../lib/review-pane";
import { checkFolderPath } from "../lib/folder-path";
import { createConsumeOnceFlag } from "../lib/consume-once-flag";
import {
  FileText, Plus, ArrowLeft, Shield, Upload, Sparkles,
  Clock, CheckCircle2, Loader2, Link2, Settings as SettingsIcon,
  Pencil, Trash2, Globe, Building2, FolderInput, Users,
  FileStack, FolderPlus, X, ListChecks,
  Activity, BookOpen, Archive, Eye, Palette, History,
  KeyRound,
} from "lucide-react";
import { RequestAccessDialog } from "./RequestAccessDialog";
import type { AccessOffer } from "../lib/access-requests";
import { ConnectModal } from "./ConnectModal";
import { prettyFolderPath } from "./FolderTree";

/** One icon per node type — agent/skill/artifact/document each read distinctly. */
// Kept as a re-export: WorkflowsView imports it from here.
export { NodeTypeIcon } from "./nest/NodeTypeIcon";
import { folderOfNode } from "./nest/node-display";
import { GenerateContextModal } from "./GenerateContextModal";
import { groupNodesByFolder, queueBreakdown } from "@/lib/nest-overview";
import { useMediaQuery } from "@/lib/use-media-query";
import { NestSettingsModal } from "./NestSettingsModal";
import { PushConfirmationModal } from "./PushConfirmationModal";
import { untilTime } from "../lib/dates";
import { ReaderView } from "./ReaderView";
import { ReaderBrandingDialog } from "./ReaderBrandingDialog";
import { PublicSiteDialog } from "./PublicSiteDialog";
import { isBranded, type NestBranding } from "../lib/branding";
import { DocumentPickerModal } from "./DocumentPickerModal";
import { ShareNestDialog } from "./ShareNestDialog";
import { NestPageHeader } from "./NestPageHeader";
import { UploadingOverlay } from "./UploadingOverlay";
import {
  deriveNestCaps,
  isNestArchived,
} from "../lib/nest-caps";
import { foldersCoveredBy } from "../lib/reader";
import { DeleteNestDialog } from "./DeleteNestDialog";
import { RenameNestDialog } from "./RenameNestDialog";
import { FolderDeleteDialog, type FolderDeleteTarget } from "./nest/FolderDeleteDialog";
// Each tab is its own chunk, loaded when first opened.
const ExternalEditsTab = lazyChunk(() => import("./nest/ExternalEditsTab").then((m) => ({ default: m.ExternalEditsTab })));
const FieldsTab = lazyChunk(() => import("./nest/FieldsTab").then((m) => ({ default: m.FieldsTab })));
const DocStream = lazyChunk(() => import("./DocStream").then((m) => ({ default: m.DocStream })));
const InstructionsTab = lazyChunk(() =>
  import("./nest/InstructionsTab").then((m) => ({ default: m.InstructionsTab })),
);
const StewardsTab = lazyChunk(() => import("./nest/StewardsTab").then((m) => ({ default: m.StewardsTab })));
const CollaboratorsTab = lazyChunk(() => import("./nest/CollaboratorsTab").then((m) => ({ default: m.CollaboratorsTab })));
const ReviewTab = lazyChunk(() => import("./nest/ReviewTab").then((m) => ({ default: m.ReviewTab })));
const OverviewTab = lazyChunk(() => import("./nest/OverviewTab").then((m) => ({ default: m.OverviewTab })));
const DocumentsTab = lazyChunk(() => import("./nest/DocumentsTab").then((m) => ({ default: m.DocumentsTab })));
import { useFeedComments } from "./nest/feed-query";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Tabs, TabsList, TabsTrigger, TabsContent,
} from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { OverflowMenu, type OverflowAction } from "@/components/ui/overflow-menu";
import { CountSkeleton } from "@/components/ui/count-skeleton";
import {
  StewardModal,
  ReasonDialog,
  type Steward, type StewardRole, type ReviewRequest,
} from "./governance";
import { useAuth } from "../auth/AuthContext";
import { PinnedStrip } from "./nest/DocPins";
import { ActivityLogPanel } from "./ActivityLogPanel";
import { toast } from "sonner";


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
  /** Open this nest's structure rules, at a folder's rule when one is given. */
  onOpenStructure?: (folder?: string) => void;
  /** Open the account-level API keys page. */
  onManageKeys?: () => void;
  /** Seed the search filter on mount. Used when arriving from a tag
   *  click on a document detail page. */
  initialSearch?: string;
  /** Pre-seed the tag filter / folder scope when arriving from a tag chip or
   *  a folder breadcrumb segment elsewhere in the app. */
  initialTags?: string[];
  initialFolder?: string;
  /** Reader mode: the page to open first (a `?doc=` deep link). */
  initialDoc?: string | null;
  /** Reader mode: the open page changed — the shell mirrors it to the URL. */
  onReaderDocChange?: (nodeId: string | null) => void;
  /** Tab to open on mount, from ?tab= — falls back to overview when the
   *  slug names a tab this user can't see. */
  initialTab?: string;
  /** Reports tab changes up so App can mirror them into ?tab=. */
  onTabChange?: (tab: string) => void;
  /** Open the settings dialog once the nest has loaded (deep link). */
  initialSettings?: boolean;
  /** The nest's name was saved — App updates every place that shows it. */
  onRenamed?: (name: string) => void;
}

/** Nest tab strip, in the reader's text-tab style (CU-wdqcq02qb1). */
const NEST_TAB =
  "relative rounded-none px-0 pb-2.5 pt-1 text-muted-foreground hover:text-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent data-[state=active]:after:bg-primary";

export function NestView({
  nestId,
  nestName,
  isOwner,
  isAnonOwned,
  isArchived,
  onBack,
  initialDoc,
  onReaderDocChange,
  onOpenDocument,
  onOpenTrace,
  onOpenStructure,
  onManageKeys,
  initialSearch,
  initialTags,
  initialFolder,
  initialTab,
  onTabChange,
  initialSettings,
  onRenamed,
}: NestViewProps) {
  const { isAdmin, adminStatus, authMode, docStreamEnabled } = useAuth();
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
  // "Request edit access" for a viewer of the nest (CU-wdqcq041jn).
  const [accessOffer, setAccessOffer] = useState<AccessOffer | null>(null);
  const lastSavedName = useRef(nestName);
  useEffect(() => {
    // Our own save echoing back via onRenamed — resetting would eat typing since.
    if (nestName === lastSavedName.current) return;
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
      onRenamed?.(trimmed);
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
  // The first census read has answered (either way). Until it has, the
  // Overview must not judge the nest empty — the nest meta lands first and
  // cleared initialLoad while the tree was still on the wire.
  const [censusSettled, setCensusSettled] = useState(false);
  // Full roster — admin-only (listStewards 403s for non-admins → stays []).
  // Caller's OWN steward rows (scoped), from GET /nests/:id. Drives per-node
  // affordances for non-admin reviewers/editors who can't read the roster.
  const [myStewards, setMyStewards] = useState<Steward[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ReviewRequest[]>([]);
  // Pending "please delete this" flags raised by people below admin.
  const [deletionRequests, setDeletionRequests] = useState<api.DeletionRequest[]>([]);
  const [removeStewardId, setRemoveStewardId] = useState<string | null>(null);
  // Non-owner asking for the whole nest to be deleted.
  const [nestFlagOpen, setNestFlagOpen] = useState(false);
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
  // A grant-only nest offers no governance reads (external edits, queue…).
  const [grantOnly, setGrantOnly] = useState(false);
  const [stewardshipEnabled, setStewardshipEnabled] = useState(false);
  const [allowSelfApprove, setAllowSelfApprove] = useState(false);
  const [primeOnlyReview, setPrimeOnlyReview] = useState(false);
  const [creatorIsReviewer, setCreatorIsReviewer] = useState(false);
  const [reviewSlaHours, setReviewSlaHours] = useState<number | null>(null);
  const [accessLogEnabled, setAccessLogEnabled] = useState(true);
  const [primeTags, setPrimeTags] = useState<string[]>([]);
  const [alwaysIncludeTags, setAlwaysIncludeTags] = useState<string[]>(["always-include"]);
  // Push Confirmation Gate (superadmin-set). Held-push count drives the badge.
  const [requirePushConfirmation, setRequirePushConfirmation] = useState(false);
  // Held agent writes awaiting confirmation (reviewer view). Empty when the
  // caller can't review or nothing is held.
  const [pendingPushes, setPendingPushes] = useState<api.PendingPush[]>([]);
  // The held push whose confirm modal is open, if any.
  const [openPushId, setOpenPushId] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<api.NestVisibility>("private");
  // Public Docs Reader Mode (superadmin-only config). reader_mode flips the
  // read-only presentation to the clean docs reader; reader_home_node names the
  // designated landing/hub node (empty → resolve by convention).
  const [readerModeEnabled, setReaderModeEnabled] = useState(false);
  const [readerHomeNode, setReaderHomeNode] = useState<string | null>(null);
  const [readerModeSaving, setReaderModeSaving] = useState(false);
  const [readerDialogOpen, setReaderDialogOpen] = useState(false);
  // Per-nest reader branding (CU-wdqcq02ptm): nest.branding, edited from the
  // reader-mode dialog, applied by ReaderView (and the shell, for readers).
  const [branding, setBranding] = useState<NestBranding | null>(null);
  const [brandingDialogOpen, setBrandingDialogOpen] = useState(false);
  const [siteDialogOpen, setSiteDialogOpen] = useState(false);
  // "Preview as reader": an owner/editor looking at the visitor-facing reader
  // from inside the authoring UI. Presentation only — rights are unchanged.
  const [previewReader, setPreviewReader] = useState(false);
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

  // Held agent writes awaiting confirmation. Best-effort: the endpoint is
  // reviewer-only (403 for anyone else) — swallow it and show nothing.
  const refetchPendingPushes = useCallback(async () => {
    try {
      const res = await api.getPendingPushes(nestId, "pending");
      setPendingPushes(res.pending_pushes);
    } catch {
      setPendingPushes([]);
    }
  }, [nestId]);
  useEffect(() => {
    void refetchPendingPushes();
  }, [refetchPendingPushes]);

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
  const [editingSteward, setEditingSteward] = useState<Steward | null>(null);
  const [loading, setLoading] = useState(true);
  // True only until the first successful fetch. Tab CONTENT gates on this, not
  // `loading`, so a background refetch (fired by the many mutation handlers)
  // never blanks already-rendered tabs back to a spinner.
  const [initialLoad, setInitialLoad] = useState(true);
  // Nest meta + settings have landed: enough for the document tree, which
  // need not wait on the review/deletion queues that initialLoad covers.
  const [shellReady, setShellReady] = useState(false);
  // The change open in the Review tab's pane. Mirrored into ?review= so a
  // review can be linked and survives a refresh (CU-wdqcq05mhk).
  const [openReviewId, setOpenReviewIdState] = useState<string | null>(() =>
    typeof window === "undefined" ? null : reviewIdFromSearch(window.location.search),
  );
  const setOpenReviewId = (nodeId: string | null) => {
    setOpenReviewIdState(nodeId);
    if (typeof window === "undefined") return;
    const search = withReviewParam(window.location.search, nodeId);
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + search + window.location.hash,
    );
  };
  const [showAssignSteward, setShowAssignSteward] = useState(false);
  // Admin activity log for the whole nest (CU-wdqcq03aw2).
  const [showNestActivity, setShowNestActivity] = useState(false);
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
    if (tab !== "review" && openReviewId) setOpenReviewId(null);
    onTabChange?.(tab);
  };
  // Follow tab changes made outside the tab strip (sidebar, breadcrumb, back/forward).
  useEffect(() => {
    if (initialTab) setActiveTabState(initialTab);
  }, [initialTab]);
  // Expanded folders, not collapsed ones: a folder's documents are fetched on
  // first expand, so the default has to be closed.
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());


  const qc = useQueryClient();
  // Whose nest this is, from the cached dashboard list (owner, roles,
  // discovered) — the banner above the tabs names it when it isn't mine.
  const listRow = useQuery(reads.nestList()).data?.nests?.find((n) => n.id === nestId);
  const relation = listRow ? nestRelation(listRow) : "owned";
  const relationText = listRow ? nestRelationText(listRow) : null;

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
      const apply = (res: { nodes: any[] }) => {
        loadedFolders.current.add(folder);
        setLoadedFolderPaths((prev) => new Set(prev).add(folder));
        setNodes((prev) => [
          ...prev.filter((n) => folderOfNode(n.id || "") !== folder),
          ...res.nodes,
        ]);
      };
      const query = reads.folderNodes(nestId, folder);
      // Paint the cached level at once and refresh behind it; a stale entry
      // used to block the tree on the network. A mutation refresh skips this.
      const cached = opts.refresh ? undefined : qc.getQueryData(query.queryKey);
      if (cached) apply(cached);
      else setLoadingFolders((prev) => new Set(prev).add(folder));
      try {
        apply(await qc.fetchQuery(query));
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
    // Same paint-then-refresh as fetchLevel.
    const cached = qc.getQueryData(reads.census(nestId).queryKey);
    if (cached) {
      setCensus(cached.census);
      setCensusSettled(true);
    }
    try {
      const { census: fresh } = await qc.fetchQuery(reads.census(nestId));
      setCensus(fresh);
    } catch (e) {
      console.error("[NestView] getNestCensus failed", nestId, e);
    } finally {
      setCensusSettled(true);
    }
  }, [nestId, qc]);

  /** Re-read every level currently on screen — used after every mutation.
   *  A no-op before the first load, which the scope effect below owns. */
  const reloadLevels = useCallback(async () => {
    if (!loadedFolders.current.size) return;
    await Promise.all([
      fetchCensus(),
      ...[...loadedFolders.current].map((f) => fetchLevel(f, { refresh: true })),
    ]);
  }, [fetchLevel, fetchCensus]);


  const openFolderInDocuments = (folder: string) => {
    // "Root" is the loose top-level bucket — its "View all" is the unscoped list.
    setFolderFilter(folder && folder !== "Root" ? folder : null);
    setActiveTab("documents");
  };

  // Open a folder (and load its level) without toggling — drag-over uses it.
  const expandFolder = (path: string) => {
    setExpandedFolders((prev) => (prev.has(path) ? prev : new Set(prev).add(path)));
    void fetchLevel(path);
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
    setGrantOnly(grantOnly);
    // Each request is independently swallowed — if listNodes throws, we must
    // still apply stewardshipEnabled from the settings response. Previously a
    // single Promise.all + outer try/catch meant a node-list error silently
    // dropped the settings update, so toggling stewardship appeared to revert.
    const empty = <T,>(v: T) => Promise.resolve(v);
    // The reads below go through the shared cache (same keys and invalidation
    // as the hook-based screens) so returning from a document paints from
    // memory instead of re-fetching. Read imperatively rather than via hooks to
    // keep each call's own error fallback — a failing node list must still let
    // the settings response apply, per the note above.
    // The queues are started now but awaited last: the tree needs only the
    // nest meta and settings, so they no longer hold it back (shellReady).
    const queueRead = grantOnly
      ? empty({ requests: [], total: 0 })
      : qc.fetchQuery(reads.reviewQueue(nestId)).catch((e) => {
        console.error("[NestView] getReviewQueue failed", nestId, e);
        toast.error(e?.message || "Failed to load review queue");
        return { requests: [], total: 0 };
      });
    // Pending AND declined in one call: pending drives the admin queue,
    // declined is how the person who asked learns the verdict.
    const deletionRead = grantOnly
      ? empty({ requests: [] as api.DeletionRequest[], total: 0 })
      : qc.fetchQuery(reads.deletionRequests(nestId, "all")).catch((e) => {
        console.error("[NestView] getDeletionRequests failed", nestId, e);
        return { requests: [] as api.DeletionRequest[], total: 0 };
      });
    const [, settingsData] =
      await Promise.all([
        // Documents come from the folder levels currently on screen, not one
        // whole-nest listing — see fetchLevel.
        reloadLevels(),
        grantOnly
          ? empty({
            stewardship_enabled: false,
            allow_self_approve: false,
            prime_only_review: false,
            prime_tags: [] as string[],
            creator_is_reviewer: false,
          })
          : qc.fetchQuery(reads.settings(nestId)).catch((e) => {
            console.error("[NestView] getNestSettings failed", nestId, e);
            return {
              stewardship_enabled: false,
              allow_self_approve: false,
              prime_only_review: false,
              prime_tags: [] as string[],
              creator_is_reviewer: false,
            };
          }),
      ]);
    setStewardshipEnabled(settingsData.stewardship_enabled);
    setAllowSelfApprove(settingsData.allow_self_approve);
    setPrimeOnlyReview(!!settingsData.prime_only_review);
    setCreatorIsReviewer(!!settingsData.creator_is_reviewer);
    setReviewSlaHours((settingsData as api.NestSettings).review_sla_hours ?? null);
    setAccessLogEnabled((settingsData as Partial<api.NestSettings>).access_log_enabled ?? true);
    setPrimeTags(settingsData.prime_tags ?? []);
    setAlwaysIncludeTags(
      (settingsData as Partial<api.NestSettings>).always_include_tags ?? ["always-include"],
    );
    setRequirePushConfirmation(!!(settingsData as any).require_push_confirmation);
    if (nestMeta?.nest?.visibility) {
      setVisibility(nestMeta.nest.visibility);
    }
    if (nestMeta?.nest) {
      setIsImported(!!(nestMeta.nest as any).is_imported);
      setNestDescription((nestMeta.nest as any).description ?? null);
      setReaderModeEnabled(!!(nestMeta.nest as any).reader_mode);
      setReaderHomeNode((nestMeta.nest as any).reader_home_node ?? null);
      setBranding(nestMeta.nest.branding ?? null);
      setNestArchivedAt((nestMeta.nest as any).archived_at ?? null);
    }
    if (nestMeta?.permission) {
      setPermission(nestMeta.permission);
    }
    setRoles(nestMeta?.roles ?? []);
    setMyStewards((nestMeta?.myStewards ?? []) as Steward[]);
    setShellReady(true);
    const [queueData, deletionData] = await Promise.all([queueRead, deletionRead]);
    setReviewQueue(queueData.requests);
    setDeletionRequests(deletionData.requests);
    setLoading(false);
    setInitialLoad(false);
  }, [nestId, qc, reloadLevels]);

  // Next page of comment activity, appended under the feed. Offset by the
  // rows already shown; a dedupe guard drops any row that slid into the next
  // page because new comments landed above it between fetches.
  useEffect(() => { fetchData(); }, [fetchData]);

  // A different nest, or a different scoped folder, is a different tree:
  // drop the loaded levels and open just the new base.
  useEffect(() => {
    loadedFolders.current = new Set();
    setExpandedFolders(new Set());
    setNodes([]);
    setCensusSettled(false);
    void fetchLevel(folderFilter ?? "");
    void fetchCensus();
  }, [nestId, folderFilter, fetchLevel, fetchCensus]);

  // stats are built later (after reviewableQueue is computed) so the
  // Review Queue card can bind to the count the user can actually act
  // on — not the raw queue size.



  // Every folder in the nest, so the tree can show one whose documents have
  // never been fetched. Memoised — FolderTree keys a useMemo on this.
  const knownFolders = useMemo(
    () => (census?.folders ?? []).map((f) => ({ path: f.path, total: f.total })),
    [census],
  );


  // Human-readable chips for every active filter, each with its own clear.
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
  // Archived: every write is refused server-side, so the affordances that
  // only lead to a refusal (or that configure a nest nobody can change) are
  // withheld — Connect, the reader-mode switch, the trace, steward changes.
  const nestArchived = isArchived || isNestArchived({ archived_at: nestArchivedAt });
  const caps = deriveNestCaps({
    roles,
    permission,
    myStewards,
    isOwner,
    isAdmin,
    readerMode: readerModeEnabled,
    previewReader,
    isArchived: nestArchived,
  });
  // canReviewDocs is folded into isReadOnly inside caps; per-row review uses
  // canReviewNode for scope resolution, so it isn't destructured here.
  const { canManage, collabCanWrite, canEditDocs, isReadOnly, isReaderView } =
    caps;

  // Reader Mode shows the whole nest at once: the nav lists every folder's
  // pages without a click, and a home page outside the first folder still
  // resolves on load. One body-free nest-wide read replaces the per-level
  // lazy fetches; every folder it covers is marked loaded so nav rows open.
  useEffect(() => {
    if (!isReaderView) return;
    let cancelled = false;
    // A preview lists only approved documents, exactly as a visitor sees it.
    qc.fetchQuery(reads.nodesMeta(nestId, previewReader))
      .then(({ nodes: all }) => {
        if (cancelled) return;
        const folders = foldersCoveredBy(all);
        loadedFolders.current = folders;
        setLoadedFolderPaths(folders);
        setNodes(all);
      })
      .catch((e: any) => toast.error(e?.message || "Failed to load documents"));
    return () => { cancelled = true; };
  }, [isReaderView, previewReader, nestId, qc]);
  // The preview swapped `nodes` for the approved-only set and marked every
  // folder loaded; leaving it reopens the authoring tree from scratch, the
  // same way a scope change does.
  const exitPreview = () => {
    setPreviewReader(false);
    loadedFolders.current = new Set();
    setLoadedFolderPaths(new Set());
    setExpandedFolders(new Set());
    setNodes([]);
    void fetchLevel(folderFilter ?? "");
  };

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
  // External Edits badge: the count endpoint (?count=1) — same server work as
  // the list, a few bytes on the wire; the tab reads the entries itself.
  const externalEditCount =
    useQuery({ ...reads.externalEditCount(nestId), enabled: !grantOnly }).data?.total ?? 0;
  // Review-tab gate: comment activity keeps the tab reachable with stewardship
  // off. Read only when nothing else already shows the tab, and only after the
  // cold load has said what those other reasons are.
  const reviewTabShownAnyway =
    stewardshipEnabled ||
    caps.canReviewDocs ||
    reviewQueue.length > 0 ||
    (caps.canManage && pendingDeletions.length > 0);
  const feedFirstPage = useFeedComments(
    nestId,
    !grantOnly && !initialLoad && !reviewTabShownAnyway,
  ).data;
  const feedCommentsTotal =
    feedFirstPage?.counts?.comments ??
    (feedFirstPage?.items ?? []).filter((i) => i.type === "comment").length;
  const showReviewTab = reviewTabShownAnyway || feedCommentsTotal > 0;

  // A shared ?tab= link can name a tab this viewer doesn't get (Stewards on a
  // nest they only read, Review Queue while read-only). Radix would render an
  // empty content area against a value with no trigger, so fall back to
  // overview once the permission flags have resolved.
  const tabVisible: Record<string, boolean> = {
    overview: true,
    documents: true,
    instructions: !grantOnly,
    review: showReviewTab && !isReadOnly,
    "external-edits": !isReadOnly,
    stewards: stewardshipEnabled && canManageGovernance,
    collaborators: canManage || collabCanWrite,
    fields: !grantOnly,
    // Experimental document stream, pinned to this nest.
    stream: docStreamEnabled && !isReaderView,
  };
  useEffect(() => {
    if (!initialLoad && !tabVisible[activeTab]) setActiveTab("overview");
  }, [initialLoad, activeTab, tabVisible[activeTab]]);
  // Deep link from a document: open settings only after the first load, so the
  // dialog never seeds itself from the pre-load defaults (stewardship "off").
  const settingsOpenedRef = useRef(false);
  useEffect(() => {
    if (!initialSettings || initialLoad || settingsOpenedRef.current) return;
    settingsOpenedRef.current = true;
    if (!isReadOnly && canManageGovernance) setShowSettings(true);
  }, [initialSettings, initialLoad, isReadOnly, canManageGovernance]);
  // The governance stat cards open the queue they count (CU-wdqcq04wnu).
  const reviewCardProps = tabVisible.review
    ? {
      role: "button",
      tabIndex: 0,
      title: "Open the review queue",
      onClick: () => setActiveTab("review"),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        setActiveTab("review");
      },
      className:
        "cursor-pointer transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    }
    : {};

  // Computed here so the Review Queue card binds to reviewableQueue.length
  // (what the user can actually act on) instead of reviewQueue.length
  // (raw size, which over-promised before — see CU-86ahn99fv).
  const stats = {
    total: census?.total ?? nodes.length,
    pending: census?.statuses?.pending_review ?? 0,
    // Documents with a live published version — one whose newer version is in
    // review or sent back is still served to agents. The status sum is the
    // fallback for an older server.
    approved:
      census?.aiReady ??
      (census?.statuses?.approved ?? 0) + (census?.statuses?.published ?? 0),
    reviewQueue: reviewQueue.length,
    reviewable: reviewableQueue.length,
  };
  const queueNote = queueBreakdown({
    pending: stats.reviewQueue,
    reviewable: stats.reviewable,
    ownBlocked: myPendingSubmissions.filter((r) => !reviewableQueue.includes(r)).length,
  });

  // Overview/index landing (CU-wdqcpztgwp): a grouped table-of-contents +
  // recently-edited, so opening a nest presents an index rather than only the
  // flat node list. Grouped by the node id's top-level folder.
  // NOTE: the engine also generates a canonical INDEX.md via regenerateIndex()
  // (excluded from the node list as a meta-file); surfacing that engine-built
  // index is a deeper follow-up — this is the lightweight UI overview.
  // Grouping logic lives in lib/nest-overview (tested there).
  // Memoised: the Overview index and FolderTree memoise on this reference.
  const tocGroups = useMemo(() => groupNodesByFolder(nodes), [nodes]);

  // Overview stat tile: Root is a synthetic tocGroups entry for docs with no
  // folder, not a user-created folder, so it's excluded from the count.
  const folderCount = census?.folders.length ?? 0;


  // Approve/reject/submit handlers used to await silently — a 403
  // (e.g. SoD block, no reviewer role, license required) threw past
  // setReviewNode(null), so the modal stayed open and the user saw
  // nothing happen. Surface the error via toast and refresh on success.
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

  // Decisions from the review pane. Errors are rethrown so the pane shows
  // them inline beside the button that failed (a 403 from SoD, scope or
  // licensing must not look like nothing happened).
  const handleApprove = async (nodeId: string, note?: string) => {
    try {
      await api.approveNode(nestId, nodeId, note);
    } catch (err: any) {
      console.error("[NestView] approveNode failed", nestId, nodeId, err);
      throw new Error(err?.message || "Approve failed");
    }
    toast.success("Approved and published");
    // Drop the row now; fetchData below reconciles in the background.
    setReviewQueue((q) => q.filter((r) => r.nodeId !== nodeId));
    fetchData();
  };

  const handleRequestChanges = async (nodeId: string, note: string) => {
    try {
      await api.rejectNode(nestId, nodeId, note);
    } catch (err: any) {
      console.error("[NestView] rejectNode failed", nestId, nodeId, err);
      throw new Error(err?.message || "Request changes failed");
    }
    toast.success("Sent back to the author");
    setReviewQueue((q) => q.filter((r) => r.nodeId !== nodeId));
    fetchData();
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
  // What is being uploaded (file name or "N files"), or null when idle.
  const [importing, setImporting] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  // Folder picked for deletion from the Overview index.
  const [overviewDeleteFolder, setOverviewDeleteFolder] = useState<FolderDeleteTarget | null>(null);
  // Phone width: Share folds into the ⋮ menu so the header actions keep one row.
  const isPhone = useMediaQuery("(max-width: 639px)");
  const pdfInputRef = useRef<HTMLInputElement | null>(null);

  const kindForFile = (name: string): "document" | "artifact" | "pdf" | "office" | null => {
    const ext = name.toLowerCase().split(".").pop() || "";
    if (ext === "html" || ext === "htm") return "artifact";
    if (ext === "pdf") return "pdf";
    if (ext === "pptx" || ext === "docx" || ext === "xlsx") return "office";
    if (ext === "md" || ext === "markdown" || ext === "txt") return "document";
    return null;
  };

  const importFiles = useCallback(
    async (fileList: FileList) => {
      const files = Array.from(fileList).filter((f) => kindForFile(f.name));
      const skipped = fileList.length - files.length;
      if (!files.length) {
        toast.error("Drop .md, .html, .pdf, .pptx, .docx or .xlsx files to add them to this vault.");
        return;
      }
      setImporting(files.length === 1 ? files[0].name : `${files.length} files`);
      const createdIds: string[] = [];
      try {
        for (const file of files) {
          const type = kindForFile(file.name)!;
          const title = file.name.replace(/\.(md|markdown|txt|html|htm|pdf|pptx|docx|xlsx)$/i, "");
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
            // A PDF is uploaded as bytes and becomes a governed `pdf` document
            // (the server extracts its text); a .pptx/.docx/.xlsx becomes a markdown
            // document with the original kept as a download; everything else
            // is read as text.
            // Markdown frontmatter supplies the title and tags (CU-wdqcq0657f).
            const md =
              type === "document" ? (await import("@/lib/import-frontmatter")).importedMarkdown(await file.text()) : null;
            const res =
              type === "pdf"
                ? await api.createPdfNode(nestId, file, { title, folder })
                : type === "office"
                  ? await api.createOfficeNode(nestId, file, { title, folder })
                  : await api.createNode(
                      nestId,
                      md
                        ? { title: md.title ?? title, content: md.body, tags: md.tags, type, folder }
                        : { title, content: await file.text(), type, folder },
                    );
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
        setImporting(null);
      }
    },
    [nestId, fetchData, onOpenDocument],
  );

  // Public Docs Reader Mode: a read-only caller of a reader-mode nest gets the
  // stripped docs reader instead of the full tabbed authoring layout. Gated on
  // caps.isReaderView (reader_mode && isReadOnly), so owners/editors/reviewers/
  // admins never lose the authoring UI.
  if (isReaderView) {
    // No "Back" here: a public docs reader navigates with the page's own
    // nav and the shell's header; a button back to the nest list is noise.
    // The banner takes 3.5rem (row + margin) off the reader's viewport
    // height so the three cards still end at the window's edge.
    return (
      <div style={previewReader ? ({ "--reader-offset": "3.5rem" } as React.CSSProperties) : undefined}>
        {previewReader && (
          <div
            role="status"
            className="mb-4 flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <span>Previewing as a reader — this is what visitors see.</span>
            <Button variant="outline" size="sm" className="h-7" onClick={exitPreview}>
              Exit preview
            </Button>
          </div>
        )}
        <ReaderView
          key={previewReader ? "preview" : "reader"}
          nestId={nestId}
          nestName={editableName}
          nodes={nodes}
          tocGroups={tocGroups}
          knownFolders={knownFolders}
          readerHomeNode={readerHomeNode}
          initialDoc={initialDoc}
          onDocChange={onReaderDocChange}
          onExpandFolder={fetchLevel}
          loadingFolders={loadingFolders}
          loadedFolders={loadedFolderPaths}
          approvedOnly={previewReader}
          branding={branding}
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
              .md → document · .html → hosted artifact · .pdf → PDF document · .pptx/.docx/.xlsx → document
            </div>
          </div>
        </div>
      )}
      {importing && <UploadingOverlay title="Uploading…" detail={importing} />}

      {/* Held-write banner — surfaces agent writes waiting on confirmation
          (Push Confirmation Gate). Each card opens the confirm modal. */}
      {pendingPushes.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-300">
            <Upload className="h-4 w-4" />
            <span>Agent writes awaiting confirmation</span>
            <Badge variant="secondary">{pendingPushes.length}</Badge>
          </div>
          <div className="space-y-1.5">
            {pendingPushes.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setOpenPushId(p.id)}
                className="w-full flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-left text-sm hover:bg-accent"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium">
                    {p.doc_count} document{p.doc_count === 1 ? "" : "s"}
                  </span>{" "}
                  from{" "}
                  {p.submitter_label || p.submitter_email || "an API key"}
                </span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {untilTime(p.expires_at) === "expired"
                    ? "Expired"
                    : `Expires ${untilTime(p.expires_at)}`}{" "}
                  · Review →
                </span>
              </button>
            ))}
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
            // A floor on the name's width so the header's chips wrap under it
            // on a phone instead of truncating it to one letter.
            <div className="min-w-[11rem] flex-1 sm:min-w-0">
              <div className="flex items-center gap-1">
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
                {/* Same rename the overflow menu used to offer (name + description
                  dialog), beside the name so it is discoverable; the input itself
                  still edits inline. !loading: the description only lands with
                  fetchData, so opening earlier would prefill it empty. */}
                {!loading && (
                  <button
                    type="button"
                    onClick={() => {
                      // Flush a pending inline rename first so the dialog primes
                      // from the latest text instead of racing the debounce.
                      flushRename();
                      setShowRename(true);
                    }}
                    className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title="Rename nest"
                    aria-label="Rename nest"
                    data-testid="nest-rename"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                )}
              </div>
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
            {/* Visibility — a three-tier menu for owner/admin (so the switch
              isn't buried in the Share dialog), a read-only badge for
              everyone else. Gated on !initialLoad (not `loading`,
              which flips on every background refetch too — see its
              definition above) so the header never flashes the "private"
              default before the real value lands from fetchData. */}
            {!initialLoad && (canManage ? (
              // All three tiers, the acknowledgements and the server's
              // admins-only caps — the same control as the Collaborators tab
              // and the document top bar, behind the header's badge button.
              <NestVisibilityControl
                nestId={nestId}
                variant="header"
                // Team sharing lives on the Collaborators tab, whose add
                // control opens on Team on a shared deployment.
                onShareWithTeam={() => setActiveTab("collaborators")}
                onChanged={fetchData}
                onError={(m) => {
                  if (m) toast.error(m);
                }}
              />
            ) : (
              visibility !== "private" && (
                <Badge
                  variant="outline"
                  // Green for public, blue for org — same pairing the dashboard
                  // card badge uses, so the two tiers never read as one colour.
                  className={`shrink-0 gap-1 ${visibility === "public"
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
            ))}
            {/* Public Docs Reader Mode config — server admin, or this nest's own
              owner/admin (see canManageReaderMode). A menu rather than a
              toggle: the landing document is part of the same setting, and
              changing it must not mean switching reader mode off and on
              again. Also gated on !initialLoad — same flash-of-default-state
              reason as the visibility badge above. */}
            {canManageReaderMode && !nestArchived && !initialLoad && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReaderDialogOpen(true)}
                className={`shrink-0 h-7 gap-1.5 ${readerModeEnabled
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
                  className={`shrink-0 gap-1 ${isArchiveAsk
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
        {!nestArchived && (
          <Button variant="outline" size="sm" onClick={() => setShowConnect(true)}>
            <Link2 className="h-3.5 w-3.5 mr-1.5" />
            Connect
          </Button>
        )}
        {!isReadOnly && (
          <Button variant="outline" size="sm" onClick={() => setShowGenerate(true)}>
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            Add with AI
          </Button>
        )}
        {/* Someone who can read this nest but not add to it can ask for that
            instead of finding no way in (CU-wdqcq041jn). Signed-in only —
            there's no one to grant a signed-out reader anything. */}
        {!canEditDocs && !nestArchived && !previewReader && !!adminStatus?.me && (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setAccessOffer({
                nestId,
                target: { type: "nest", id: nestId },
                level: "write",
                label: editableName || nestName,
              })
            }
            data-testid="nest-request-access"
            title="Ask the nest owner or an admin for edit access to this nest"
          >
            <KeyRound className="h-3.5 w-3.5 mr-1.5" />
            Request edit access
          </Button>
        )}
        {canManage && !isPhone && (
          // Inside the nest, Share IS the Collaborators tab — one surface
          // for visibility, people and teams (CU-wdqcpzzzy6). On a phone it
          // is the ⋮ menu's first item instead.
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
              accept=".md,.markdown,.txt,.html,.htm,.pdf,.pptx,.docx,.xlsx"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) void importFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={pdfInputRef}
              type="file"
              multiple
              accept="application/pdf,.pdf"
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
          </>
        )}
        {/* Secondary actions collapsed into an overflow menu at the end.
              Connect: view-only export/data-egress. Share: owner/admin only
              (server requires admin on /collaborators + /visibility). Delete:
              destructive, write+admin gated. */}
        {(() => {
          const actions: OverflowAction[] = [];
          if (canManage && isPhone)
            actions.push({
              label: "Share",
              icon: Users,
              onSelect: () => setActiveTab("collaborators"),
            });
          if (!isReadOnly && canManageGovernance)
            actions.push({
              label: "Nest settings",
              icon: SettingsIcon,
              onSelect: () => setShowSettings(true),
            });
          // This nest's own folder rules — owners and admins set them.
          if (canManageGovernance && onOpenStructure && !nestArchived)
            actions.push({
              label: "Structure rules",
              icon: ListChecks,
              onSelect: () => onOpenStructure(),
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
          // gated on isReadOnly (a viewer may see it); withheld on an archived
          // nest with the rest of its management. Same owner/nest-admin rule
          // as the server's GET /nests/:id/trace (canManageStewards).
          if (canManageGovernance && onOpenTrace && !nestArchived)
            actions.push({
              label: "Activity trace",
              icon: Activity,
              onSelect: onOpenTrace,
            });
          // Who changed, read, pulled or exported what in this nest — the
          // document-level log, nest-wide. Same owner/nest-admin rule as
          // GET /activity-log; read-only, so shown on an archived nest too.
          if (canManageGovernance)
            actions.push({
              label: "Activity",
              icon: History,
              testId: "nest-activity-log",
              onSelect: () => setShowNestActivity(true),
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
      {showNestActivity && (
        <ActivityLogPanel
          nestId={nestId}
          scope={{ kind: "nest" }}
          label={editableName || nestName}
          onClose={() => setShowNestActivity(false)}
          onOpenNode={(id) => {
            setShowNestActivity(false);
            onOpenDocument(id);
          }}
        />
      )}

      {relationText && (
        <div
          data-testid="nest-relation-banner"
          className={`mb-4 flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
            relation === "shared"
              ? "border-blue-200 bg-blue-50 text-blue-800"
              : "border-dashed bg-muted/40 text-muted-foreground"
          }`}
        >
          {relation === "shared" ? (
            <Users className="h-4 w-4 shrink-0" />
          ) : listRow?.visibility === "public" ? (
            <Globe className="h-4 w-4 shrink-0" />
          ) : (
            <Building2 className="h-4 w-4 shrink-0" />
          )}
          <span className="truncate">
            {relation === "shared"
              ? relationText
              : `Not shared with you — you can read it because it's ${relationText}`}
          </span>
        </div>
      )}
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
        {/* The reader's quieter nav: text tabs over one hairline, the active
            one underlined — not a grey pill strip. Styled here, not in
            ui/tabs, so the other pages that use Tabs are unchanged. On a
            phone the actions sit above the tabs so the underline meets the
            rule. */}
        <div className="flex flex-wrap items-end gap-x-2 gap-y-3 mb-5 min-w-0 border-b">
          <TabsList className="h-auto min-h-0 max-w-full justify-start gap-5 overflow-x-auto rounded-none bg-transparent p-0">
            <TabsTrigger value="overview" className={NEST_TAB}>Overview</TabsTrigger>
            <TabsTrigger value="documents" className={NEST_TAB}>Documents</TabsTrigger>
            {/* The nest's CONTEXT.md — what every agent reads first. */}
            {!grantOnly && (
              <TabsTrigger value="instructions" className={NEST_TAB}>Instructions</TabsTrigger>
            )}
            {/* Governance tabs hidden for view-only. */}
            {showReviewTab && !isReadOnly && (
              <TabsTrigger value="review" className={NEST_TAB + " gap-2"}>
                Review Queue
                {reviewableQueue.length > 0 && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                    {reviewableQueue.length}
                  </Badge>
                )}
              </TabsTrigger>
            )}
            {!isReadOnly && (
              <TabsTrigger value="external-edits" className={NEST_TAB + " gap-2"}>
                External Edits
                {externalEditCount > 0 && (
                  <Badge
                    variant="secondary"
                    className="text-[10px] px-1.5 py-0 bg-orange-100 text-orange-700"
                  >
                    {externalEditCount}
                  </Badge>
                )}
              </TabsTrigger>
            )}
            {/* Steward roster is admin-only (list + manage), and hidden when
              the admin is viewing a real user's nest. */}
            {stewardshipEnabled && canManageGovernance && (
              <TabsTrigger value="stewards" className={NEST_TAB}>Stewards</TabsTrigger>
            )}
            {/* Collaborators — plain access sharing, independent of
              stewardship. Owner/admin manage the full roster; write
              collaborators can invite (escalation-capped server-side), so
              they see the tab too. The roster controls cap themselves by the
              caller's permission (see CollaboratorManager). */}
            {(canManage || collabCanWrite) && (
              <TabsTrigger value="collaborators" className={NEST_TAB}>Collaborators</TabsTrigger>
            )}
            {/* Custom fields — readable by everyone on the nest (they explain
              the values on its documents); the tab's own controls appear only
              for admins and nest-wide reviewers (server-decided can_manage). */}
            {!grantOnly && (
              <TabsTrigger value="fields" className={NEST_TAB}>Fields</TabsTrigger>
            )}
            {/* Experimental: this nest's document stream (EXPERIMENTAL_DOC_STREAM). */}
            {docStreamEnabled && !isReaderView && (
              <TabsTrigger value="stream" className={NEST_TAB}>Stream</TabsTrigger>
            )}
          </TabsList>
          {!isReadOnly && canEditDocs && (
            <div className="ml-auto flex shrink-0 items-center gap-2 pb-2 max-sm:order-first max-sm:w-full max-sm:justify-end">
              <Button
                variant="outline"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setShowNewFolder(true)}
                title="Create a folder (nest with parent/child)"
                aria-label="New Folder"
              >
                <FolderPlus className="h-4 w-4 sm:mr-1.5" />
                {/* Icon-only on a phone so the three actions fit one row. */}
                <span className="max-sm:hidden">New Folder</span>
              </Button>
              {/* Import and New Document act on the content area too, so they
                sit with New Folder rather than in the nest header. */}
              <Button
                variant="outline"
                size="sm"
                data-testid="nest-import-files"
                onClick={() => setImportMenuOpen(true)}
              >
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                Import
              </Button>
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
            </div>
          )}
        </div>

        {/* Stats Cards — only governance-related stats when stewardship is on.
          In ungoverned mode every doc is auto-approved so the pending/review
          columns are always zero and just add noise. Not on Overview: it
          carries the same numbers as its own summary line (CU-wdqcq02qb1). */}
        {activeTab !== "overview" && (
          <div
            // While a review is open, small screens skip the stats so the
            // review itself is the first thing on screen.
            className={`${activeTab === "review" && openReviewId ? "hidden lg:grid" : "grid"} grid-cols-1 gap-4 mb-4 ${stewardshipEnabled
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
                <Card {...reviewCardProps} data-testid="nest-stat-pending">
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
                <Card {...reviewCardProps} data-testid="nest-stat-review">
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
                        {queueNote && (
                          <span className="ml-1 text-xs" data-testid="nest-stat-review-note">
                            ({queueNote})
                          </span>
                        )}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        )}

        {/* Overview — the nest's index/landing: stat tiles, recently-edited
            rows, and a grouped table-of-contents grid so opening a nest
            presents an index rather than just the flat node list. */}
        <TabsContent value="overview" className="space-y-4">
          {/* An org contributor's way in (CU-wdqcq05rz6); renders nothing for
              anyone else. */}
          <OrgContributorPanel nestId={nestId} />
          <Suspense fallback={<div className="py-12 text-center text-muted-foreground">Loading...</div>}>
            <OverviewTab
              initialLoad={!shellReady || !censusSettled}
              stats={stats}
              recentlyEdited={recentlyEdited}
              recentlyEditedCount={recentlyEditedCount}
              folderCount={folderCount}
              tocGroups={tocGroups}
              knownFolders={knownFolders}
              isReadOnly={isReadOnly}
              canEditDocs={canEditDocs}
              onOpenDocument={onOpenDocument}
              onOpenFolder={openFolderInDocuments}
              nestName={editableName}
              loadingFolders={loadingFolders}
              onExpandFolder={fetchLevel}
              description={nestDescription}
              governance={stewardshipEnabled ? stats : undefined}
              onOpenReview={showReviewTab && !isReadOnly ? () => setActiveTab("review") : undefined}
              onImport={canEditDocs && !isReadOnly ? () => setImportMenuOpen(true) : undefined}
              // Same gate as the header's Add with AI button.
              onAddWithAI={!isReadOnly ? () => setShowGenerate(true) : undefined}
              // Same gate as the Documents tree's folder trash icon.
              onDeleteFolder={!isReadOnly && (canManage || canEditDocs) ? setOverviewDeleteFolder : undefined}
            />
          </Suspense>
          {overviewDeleteFolder && (
            <FolderDeleteDialog
              nestId={nestId}
              folder={overviewDeleteFolder}
              canManage={canManage}
              onClose={() => setOverviewDeleteFolder(null)}
              onDone={() => {
                // Don't leave Documents filtered to a folder that's gone.
                const gone = overviewDeleteFolder.path;
                if (canManage && folderFilter && (folderFilter === gone || folderFilter.startsWith(gone + "/")))
                  setFolderFilter(null);
                fetchData();
              }}
            />
          )}
        </TabsContent>

        <TabsContent value="documents" className="space-y-4">
          {/* Experimental document pins — renders nothing while the switch is
              off or the nest has no pins the caller can read. */}
          <PinnedStrip nestId={nestId} onOpenDocument={(id) => onOpenDocument(id)} />
          <Suspense fallback={<div className="py-12 text-center text-muted-foreground">Loading...</div>}>
            <DocumentsTab
              nestId={nestId}
              onOpenStructure={isReaderView ? undefined : onOpenStructure}
              initialSearch={initialSearch}
              initialTags={initialTags}
              initialLoad={!shellReady}
              loading={loading}
              nodes={nodes}
              census={census}
              knownFolders={knownFolders}
              folderFilter={folderFilter}
              setFolderFilter={setFolderFilter}
              expandedFolders={expandedFolders}
              loadingFolders={loadingFolders}
              toggleFolderExpanded={toggleFolderExpanded}
              expandFolder={expandFolder}
              caps={caps}
              isAdmin={isAdmin}
              isOwner={isOwner}
              roles={roles}
              permission={permission}
              currentEmail={currentEmail}
              myStewards={myStewards}
              stewardshipEnabled={stewardshipEnabled}
              allowSelfApprove={allowSelfApprove}
              primeTags={primeTags}
              alwaysIncludeTags={alwaysIncludeTags}
              visibility={visibility}
              hasRoleOnNode={hasRoleOnNode}
              canReviewNode={canReviewNode}
              reviewQueue={reviewQueue}
              reviewableQueue={reviewableQueue}
              deletionRequests={deletionRequests}
              stats={stats}
              onOpenDocument={onOpenDocument}
              onReview={(node) => {
                // Review happens in the Review tab's pane, with the diff and
                // the author's note — not a second, thinner surface here.
                if (!showReviewTab) return onOpenDocument(node.id);
                setActiveTab("review");
                setOpenReviewId(node.id);
              }}
              onRefresh={fetchData}
              onWithdrawDeletion={(r) => void handleWithdrawDeletion(r)}
              importInputRef={importInputRef}
            />
          </Suspense>
        </TabsContent>

        {showReviewTab && (
          <TabsContent value="review" className="space-y-4">
            <Suspense fallback={<div className="py-12 text-center text-muted-foreground">Loading...</div>}>
              <ReviewTab
                key={nestId}
                nestId={nestId}
                enabled={!grantOnly}
                reviewQueue={reviewQueue}
                reviewableQueue={reviewableQueue}
                myPendingSubmissions={myPendingSubmissions}
                pendingDeletions={pendingDeletions}
                canManage={canManage}
                loading={loading}
                onRefresh={fetchData}
                onOpenDocument={onOpenDocument}
                openReviewId={openReviewId}
                onOpenReview={setOpenReviewId}
                onApproveReview={handleApprove}
                onRequestChanges={handleRequestChanges}
                currentUser={currentEmail}
                canEditDocs={canEditDocs}
                primeTags={primeTags}
                alwaysIncludeTags={alwaysIncludeTags}
                onResolveDeletion={(request, action) => setResolveTarget({ request, action })}
                onWithdrawSubmission={(id) => void withdrawSubmission(id)}
              />
            </Suspense>
          </TabsContent>
        )}

        <TabsContent value="external-edits" className="space-y-4">
          <Suspense fallback={<div className="py-12 text-center text-muted-foreground">Loading...</div>}>
            <ExternalEditsTab
              nestId={nestId}
              enabled={!grantOnly}
              onOpenDocument={onOpenDocument}
              titleOf={(id) => nodes.find((n) => n.id === id)?.title}
            />
          </Suspense>
        </TabsContent>

        {stewardshipEnabled && canManageGovernance && (
          <TabsContent value="stewards" className="space-y-4">
            <Suspense fallback={<div className="py-12 text-center text-muted-foreground">Loading...</div>}>
              <StewardsTab
                nestId={nestId}
                canManage={canManageGovernance && !caps.isReadOnly}
                currentUserEmail={currentEmail}
                onAssign={() => setShowAssignSteward(true)}
                onRemove={setRemoveStewardId}
                onEditRole={setEditingSteward}
              />
            </Suspense>
          </TabsContent>
        )}

        {!grantOnly && (
          <TabsContent value="instructions" className="space-y-4">
            <Suspense fallback={<div className="py-12 text-center text-muted-foreground">Loading...</div>}>
              <InstructionsTab nestId={nestId} canEdit={canManage && !isReadOnly} />
            </Suspense>
          </TabsContent>
        )}

        {!grantOnly && (
          <TabsContent value="fields" className="space-y-4">
            <Suspense fallback={<div className="py-12 text-center text-muted-foreground">Loading...</div>}>
              <FieldsTab nestId={nestId} />
            </Suspense>
          </TabsContent>
        )}

        {docStreamEnabled && !isReaderView && (
          <TabsContent value="stream" className="space-y-4">
            <Suspense fallback={<div className="py-12 text-center text-muted-foreground">Loading...</div>}>
              <DocStream
                pinnedNestId={nestId}
                onOpen={(item, threadId) => onOpenDocument(item.nodeId, threadId ? { thread: threadId } : undefined)}
              />
            </Suspense>
          </TabsContent>
        )}

        {(canManage || collabCanWrite) && (
          <TabsContent value="collaborators" className="space-y-4">
            <Suspense fallback={<div className="py-12 text-center text-muted-foreground">Loading...</div>}>
              <CollaboratorsTab
                nestId={nestId}
                nestName={nestName}
                canManage={canManage}
                canManageGovernance={canManageGovernance}
                stewardshipEnabled={stewardshipEnabled}
                currentUserEmail={currentEmail}
                callerPermission={permission ?? undefined}
                onOpenSettings={() => setShowSettings(true)}
                onChanged={fetchData}
              />
            </Suspense>
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

      {accessOffer && (
        <RequestAccessDialog offer={accessOffer} onClose={() => setAccessOffer(null)} />
      )}
      {showGenerate && (
        <GenerateContextModal
          isOpen={showGenerate}
          onClose={() => setShowGenerate(false)}
          nestId={nestId}
          nestName={nestName}
          openMode={authMode === "open"}
          onOpenConnect={() => {
            setShowGenerate(false);
            setShowConnect(true);
          }}
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
          alwaysIncludeTags={alwaysIncludeTags}
          requirePushConfirmation={requirePushConfirmation}
          isServerAdmin={isAdmin}
          creatorIsReviewer={creatorIsReviewer}
          reviewSlaHours={reviewSlaHours}
          accessLogEnabled={accessLogEnabled}
          canDisableAccessLog={isAdmin || isOwner || permission === "owner"}
          canManageStewardship={canManageGovernance}
          onClose={() => setShowSettings(false)}
          onManageFields={() => {
            setShowSettings(false);
            setActiveTab("fields");
          }}
          onChanged={(next) => {
            setShowSettings(false);
            // Flip the governance UI (Pending/AI Ready/Review Queue tiles,
            // Stewards tab, etc.) instantly instead of waiting for the full
            // refetch to land — then reconcile counts in the background.
            setStewardshipEnabled(next.stewardshipEnabled);
            setAllowSelfApprove(next.allowSelfApprove);
            setPrimeOnlyReview(next.primeOnlyReview);
            setPrimeTags(next.primeTags);
            setAlwaysIncludeTags(next.alwaysIncludeTags);
            setRequirePushConfirmation(next.requirePushConfirmation);
            setCreatorIsReviewer(next.creatorIsReviewer);
            setReviewSlaHours(next.reviewSlaHours);
            setAccessLogEnabled(next.accessLogEnabled);
            fetchData();
          }}
        />
      )}

      {openPushId && (
        <PushConfirmationModal
          nestId={nestId}
          pendingId={openPushId}
          existingNodeIds={new Set(nodes.map((n: any) => n.id))}
          onClose={() => setOpenPushId(null)}
          onDecided={() => {
            void refetchPendingPushes();
            // A confirmed push wrote documents — refresh the nest view.
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
              onRenamed?.(updated.name);
            }
            setNestDescription(updated.description);
            setShowRename(false);
          }}
        />
      )}

      {/* Import choices in a centred dialog, like Add with AI — opened by the
          header's Import button and the Overview's "Import files" action. */}
      <Dialog open={importMenuOpen} onOpenChange={setImportMenuOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Import into this nest</DialogTitle>
            <DialogDescription>Pick what to bring in.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {[
              { ref: importInputRef, label: "Files", detail: ".md, .html, .pdf, .pptx, .docx or .xlsx — one or many", testId: undefined },
              { ref: pdfInputRef, label: "Upload PDF", detail: "Becomes a PDF document with its text extracted", testId: "nest-upload-pdf" },
              { ref: importDirRef, label: "Whole vault", detail: "A folder, keeping its structure", testId: undefined },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                data-testid={o.testId}
                className="rounded-md border p-3 text-left hover:bg-muted"
                onClick={() => {
                  setImportMenuOpen(false);
                  o.ref.current?.click();
                }}
              >
                <div className="text-sm font-medium">{o.label}</div>
                <div className="text-xs text-muted-foreground">{o.detail}</div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

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
              <code className="font-mono">{newFolderCheck.label}</code>
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

          {/* Branding — logo, banner, colors, footer — for the reader and
              the nest's /p links. Its own dialog: it needs room for a preview. */}
          <div className="rounded-lg border p-4 flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label className="text-sm font-medium">Branding</Label>
              <p className="text-xs text-muted-foreground">
                {isBranded(branding)
                  ? "Custom logo, colors and footer are applied for readers."
                  : "Readers see the default ContextNest look."}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              onClick={() => {
                setReaderDialogOpen(false);
                setBrandingDialogOpen(true);
              }}
            >
              <Palette className="h-3.5 w-3.5" />
              {isBranded(branding) ? "Edit branding" : "Customize"}
            </Button>
          </div>

          {/* Public site — the static, crawlable docs site a public reader-mode
              nest publishes: domain, page URLs, search and AI settings. */}
          {readerModeEnabled && (
            <div className="rounded-lg border p-4 flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">Public site</Label>
                <p className="text-xs text-muted-foreground">
                  A search-engine-ready docs site with its own domain, page
                  URLs and AI settings. Live while the nest is public.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 gap-1.5"
                onClick={() => {
                  setReaderDialogOpen(false);
                  setSiteDialogOpen(true);
                }}
              >
                <Globe className="h-3.5 w-3.5" />
                Site settings
              </Button>
            </div>
          )}

          <DialogFooter>
            {readerModeEnabled && (
              <Button
                variant="outline"
                className="mr-auto gap-1.5"
                onClick={() => {
                  setReaderDialogOpen(false);
                  setPreviewReader(true);
                }}
              >
                <Eye className="h-3.5 w-3.5" />
                Preview as reader
              </Button>
            )}
            <Button variant="outline" onClick={() => setReaderDialogOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PublicSiteDialog open={siteDialogOpen} onOpenChange={setSiteDialogOpen} nestId={nestId} />

      <ReaderBrandingDialog
        open={brandingDialogOpen}
        onOpenChange={setBrandingDialogOpen}
        nestId={nestId}
        nestName={editableName}
        branding={branding}
        isServerAdmin={isAdmin}
        onSaved={setBranding}
      />

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

    </div>
  );
}
