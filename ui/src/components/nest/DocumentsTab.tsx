/**
 * Documents tab — the nest's document browser: search + filters (with saved
 * filters), the folder tree, list/card rows with their per-row actions, and
 * drag-and-drop moves. Owns everything about filtering and presentation; the
 * loaded folder levels, the caller's capabilities and the document dialogs
 * (delete, move, submit, review…) stay with the nest page, which passes them
 * in — the Review tab and the Overview share them.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../../lib/api";
import { toast } from "sonner";
import { reads } from "../../lib/queries";
import { matchesFilters } from "../../lib/node-filter";
import { visibleDocuments, documentsTabIsEmpty, hasActiveFilters as hasActiveFiltersOn } from "../../lib/visible-documents";
import { documentFacets } from "../../lib/document-facets";
import { activityTimestamp } from "../../lib/node-sort";
import { linkHealth } from "../../lib/link-health";
import { findBacklinks, inboundLinkWarning } from "../../lib/backlinks";
import { FolderDeleteDialog } from "./FolderDeleteDialog";
import { nodeTypeSupportsMove } from "../../lib/document-actions";
import {
  datePresetToEpoch, upsertFilter, removeFilter,
  parseSavedFilters, serializeSavedFilters,
  type DatePreset, type SavedFilter,
} from "../../lib/saved-filters";
import {
  FileCode2, Plus, History, Search, Upload,
  CheckCircle2, Send, Loader2,
  Pencil, Trash2, FolderInput,
  LayoutGrid, List as ListIcon, Star, X, MoreVertical,
  FolderOpen, ChevronRight, Share2, FolderPlus, Activity, Ruler,
} from "lucide-react";
import { FolderTree, prettyFolder, prettyFolderPath, type KnownFolder } from "../FolderTree";
import { ActivityLogPanel } from "../ActivityLogPanel";
import { AuthorshipChips } from "../AuthorshipChips";
import {
  LifecycleStatusBadge, SubmitForReviewModal, ReasonDialog, VersionHistoryModal,
  type DocumentLifecycleStatus, type Steward, type ReviewRequest, type Version,
} from "../governance";
import { PublishDialog } from "../PublishDialog";
import { ShareTargetDialog } from "../ShareTargetDialog";
import { folderGrantTarget } from "../../lib/folder-target";
import { checkFolderPath } from "../../lib/folder-path";
import type { NestCaps } from "../../lib/nest-caps";
import { NodeTypeIcon } from "./NodeTypeIcon";
import { typePill, byPathSegments, folderOfNode, STATUS_LABELS, DATE_LABELS, TYPE_LABELS } from "./node-display";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue,
} from "@/components/ui/select";

type Node = any;

/** The Documents list filters. `search` also drives the whole-nest content search. */
interface DocFilters {
  search: string;
  tags: string[];
  status: string;
  type: string;
  author: string;
  datePreset: DatePreset;
}
const EMPTY_FILTERS: DocFilters = { search: "", tags: [], status: "all", type: "all", author: "all", datePreset: "any" };

interface Props {
  nestId: string;
  /** Open this nest's structure rules at the rule governing a folder. */
  onOpenStructure?: (folder: string) => void;
  initialSearch?: string;
  initialTags?: string[];
  /** The nest's cold load / any refetch (from the nest page). */
  initialLoad: boolean;
  loading: boolean;
  /** Documents from the folder levels loaded so far. */
  nodes: Node[];
  census: api.NestCensus | null;
  knownFolders: KnownFolder[];
  /** Folder scope (null = whole nest); owned by the nest page — Overview sets it. */
  folderFilter: string | null;
  setFolderFilter: (folder: string | null) => void;
  expandedFolders: Set<string>;
  loadingFolders: Set<string>;
  toggleFolderExpanded: (path: string) => void;
  /** Open a folder (and load its level) without toggling. */
  expandFolder: (path: string) => void;
  /** The caller. */
  caps: NestCaps;
  isAdmin: boolean;
  isOwner: boolean;
  /** Merged effective roles (collaborator + steward), nest-wide. */
  roles: string[];
  permission: string | null;
  currentEmail: string;
  myStewards: Steward[];
  stewardshipEnabled: boolean;
  allowSelfApprove: boolean;
  primeTags: string[];
  visibility: api.NestVisibility;
  hasRoleOnNode: (node: Node, role: string) => boolean;
  canReviewNode: (node: Node) => boolean;
  /** Governance state the rows annotate themselves with. */
  reviewQueue: ReviewRequest[];
  reviewableQueue: ReviewRequest[];
  deletionRequests: api.DeletionRequest[];
  stats: { total: number; pending: number; approved: number };
  onOpenDocument: (nodeId: string, opts?: { folder?: string; thread?: string }) => void;
  /** Open the review modal (shared with the Review tab). */
  onReview: (node: Node) => void;
  /** Re-read the nest after a write. */
  onRefresh: () => void;
  onWithdrawDeletion: (request: api.DeletionRequest) => void;
  /** The header's hidden file input, for the empty state's Import button. */
  importInputRef: React.RefObject<HTMLInputElement>;
}

export function DocumentsTab({
  nestId,
  onOpenStructure,
  initialSearch,
  initialTags,
  initialLoad,
  loading,
  nodes,
  census,
  knownFolders,
  folderFilter,
  setFolderFilter,
  expandedFolders,
  loadingFolders,
  toggleFolderExpanded,
  expandFolder,
  caps,
  isAdmin,
  isOwner,
  roles,
  permission,
  currentEmail,
  myStewards,
  stewardshipEnabled,
  allowSelfApprove,
  primeTags,
  visibility,
  hasRoleOnNode,
  canReviewNode,
  reviewQueue,
  reviewableQueue,
  deletionRequests,
  stats,
  onOpenDocument,
  onReview,
  onRefresh,
  onWithdrawDeletion,
  importInputRef,
}: Props) {
  const { canManage, collabCanWrite, canEditDocs, isReadOnly } = caps;
  const qc = useQueryClient();
  // Per-node comment counts drive the activity and "most comments" sorts —
  // a Documents-tab need, so it is read here, not on the nest page.
  const commentCounts = useQuery(reads.commentCounts(nestId)).data?.counts ?? {};
  const fetchData = onRefresh;


  // Node being flagged (dialog open when set), and the queue row being resolved
  // — `action` picks between the confirm and the decline-with-note dialog.
  const [deletionTarget, setDeletionTarget] = useState<any | null>(null);
  // Node pending a plain delete confirm (for callers who can delete outright).
  const [deleteNodeTarget, setDeleteNodeTarget] = useState<any | null>(null);
  // Its confirm warns about docs linking to it, which needs every body — read
  // the (shared, cached) full listing only while that dialog is open.
  const deleteLinks = useQuery({ ...reads.nodes(nestId), enabled: !!deleteNodeTarget });
  const deleteBacklinks = deleteNodeTarget
    ? findBacklinks(deleteLinks.data?.nodes ?? [], deleteNodeTarget).length
    : 0;

  // Folder pending deletion (admin) or a deletion request (everyone else).
  const [folderTarget, setFolderTarget] = useState<
    { path: string; label: string; total: number } | null
  >(null);
  // Folder being shared with one person (a grant, not a collaborator).
  const [shareFolder, setShareFolder] = useState<
    { path: string; label: string } | null
  >(null);
  // Admin activity log open for a document or a folder (owner/admin only —
  // the same people GET /activity-log lets in).
  const [activityFor, setActivityFor] = useState<
    { scope: api.ActivityLogScope; label: string } | null
  >(null);

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

  const [publishNode, setPublishNode] = useState<any | null>(null);
  const [submitNode, setSubmitNode] = useState<any | null>(null);
  const [versionNode, setVersionNode] = useState<any | null>(null);
  const [versionData, setVersionData] = useState<{
    versions: Version[];
    approvedVersion: number | null;
    currentVersion: number;
    externalEditVerdicts?: api.ExternalEditVerdict[];
  }>({ versions: [], approvedVersion: null, currentVersion: 0 });

  /** Node-id prefix for a folder share — see lib/folder-target.ts. */
  const shareTargetForFolder = (folderPath: string): string => {
    const inside = nodes.find((n) => {
      const f = folderOfNode(n.id || "");
      return f === folderPath || f.startsWith(`${folderPath}/`);
    });
    return folderGrantTarget(folderPath, inside?.id ?? null);
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

  // Every folder path in use (all prefixes, so intermediate levels with no
  // direct docs still appear) — options for the Move-to-folder dialog.
  const allFolders = useMemo(
    () => (census?.folders ?? []).map((f) => f.path).sort(byPathSegments),
    [census],
  );

  // Map nodeId → submitter so the per-row Review button can hide on
  // docs the current user submitted (separation-of-duties: authors must
  // not approve their own work). The server already rejects the call,
  // but hiding the affordance keeps the UI honest.
  const submitterByNode = new Map<string, string>();
  for (const r of reviewQueue) {
    submitterByNode.set(r.nodeId, r.requestedBy.toLowerCase());
  }

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


  // Node ids the caller can review right now (authoritative, from the queue
  // annotation). Drives the per-row Review button so it stays in lockstep with
  // the in-document approve/reject affordance.
  const reviewableNodeIds = new Set(
    reviewableQueue.map((r) => r.nodeId),
  );

  const openVersions = async (node: any) => {
    setVersionNode(node);
    try {
      const data = await qc.fetchQuery(reads.nodeVersions(nestId, node.id));
      setVersionData(data);
    } catch (e) {
      console.error("[NestView] getNodeVersions failed", nestId, node?.id, e);
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

  // Folder tree base: the scoped folder when one is set (depth drives indent).
  const baseFolder = folderFilter ?? "";
  const baseDepth = baseFolder ? baseFolder.split("/").length : 0;
  // A filter, a search, and link health are all questions about the WHOLE
  // nest, which the folder levels on screen cannot answer. Read the full
  // listing only when one of those is asked (wantFull); every document write
  // drops keys.nodes, so react-query re-reads it — no manual reset.
  const [wantFull, setWantFull] = useState(false);
  const fullQuery = useQuery({ ...reads.nodes(nestId), enabled: wantFull });
  const fullNodes: any[] | null = wantFull ? (fullQuery.data?.nodes ?? null) : null;
  const fullLoading = wantFull && fullQuery.isLoading;
  const loadFullNest = useCallback(() => setWantFull(true), []);

  // One object for every list filter, so a saved filter or "clear all" is a
  // spread rather than six setters, and a control updates its own key with
  // setFilter(key, value). Sort and view mode are presentation, not filters.
  const [filter, setFilters] = useState<DocFilters>({
    ...EMPTY_FILTERS,
    search: initialSearch ?? "",
    tags: initialTags ?? [],
  });
  const setFilter = <K extends keyof DocFilters>(key: K, value: DocFilters[K]) =>
    setFilters((prev) => ({ ...prev, [key]: value }));
  // Multi-tag AND filter; toggled by clicking tag chips on list rows.
  const toggleTagFilter = (tag: string) =>
    setFilters((prev) => ({
      ...prev,
      tags: prev.tags.includes(tag) ? prev.tags.filter((t) => t !== tag) : [...prev.tags, tag],
    }));
  // Document list sort. Defaults to "activity" (most-recently-touched first) so
  // the list opens on what changed, not an alphabetical wall.
  const [sortMode, setSortMode] = useState<
    "activity" | "name" | "edited" | "comments"
  >("activity");
  // Per-node comment (annotation thread) counts, for the "Most comments" sort.

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
        search: filter.search || undefined,
        status: filter.status !== "all" ? filter.status : undefined,
        tags: filter.tags.length ? filter.tags : undefined,
        author: filter.author !== "all" ? filter.author : undefined,
        datePreset: filter.datePreset !== "any" ? filter.datePreset : undefined,
        type: filter.type !== "all" ? filter.type : undefined,
      }),
    );
    setSaveFilterName("");
    setShowSaveFilter(false);
  };
  // A saved filter stores only the keys it set (undefined until the next
  // reload drops them from JSON); everything else resets.
  const applySavedFilter = ({ name: _name, ...saved }: SavedFilter) =>
    setFilters({
      ...EMPTY_FILTERS,
      ...(Object.fromEntries(
        Object.entries(saved).filter(([, v]) => v !== undefined),
      ) as Partial<DocFilters>),
    });


  // Full-text CONTENT hits from the server search endpoint, unioned with
  // the instant client title/tag match below. Debounced; best-effort.
  const [contentHits, setContentHits] = useState<Set<string>>(new Set());
  useEffect(() => {
    const q = filter.search.trim();
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
  }, [nestId, filter.search]);

  const hasActiveFilters = hasActiveFiltersOn(filter);

  useEffect(() => {
    if (hasActiveFilters) void loadFullNest();
  }, [hasActiveFilters, loadFullNest]);
  const updatedAfter = datePresetToEpoch(filter.datePreset, Date.now());
  // Status + tag filters always apply; with a query, a doc passes on an
  // instant client title/tag match OR a server content hit. Semantics of
  // the client match live in lib/node-filter (unit-tested).
  //
  // Unfiltered, the levels on screen ARE the answer; filtered, the answer
  // spans the nest, so use the full listing as soon as it lands.
  const filtered = visibleDocuments({
    ...filter,
    levelNodes: nodes,
    fullNodes,
    folderFilter,
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

  const authors = census?.authors ?? [];

  // Distinct node types present (missing type = "document"), for the type
  // filter dropdown. Only offered when the nest actually mixes types.
  const typesPresent = useMemo(
    () => Object.keys(census?.types ?? {}).sort((a, b) => a.localeCompare(b)),
    [census],
  );

  const clearAllFilters = () => {
    setFilters({ ...EMPTY_FILTERS });
  };

  // Human-readable chips for every active filter, each with its own clear.
  // Tags keep their dedicated bar below, so they're not duplicated here.
  const activeFilterChips: Array<{ label: string; clear: () => void }> = [];
  if (filter.search)
    activeFilterChips.push({ label: `Search: ${filter.search}`, clear: () => setFilter("search", "") });
  if (filter.status !== "all")
    activeFilterChips.push({
      label: `Status: ${STATUS_LABELS[filter.status] ?? filter.status}`,
      clear: () => setFilter("status", "all"),
    });
  if (filter.type !== "all")
    activeFilterChips.push({
      label: `Type: ${TYPE_LABELS[filter.type] ?? filter.type}`,
      clear: () => setFilter("type", "all"),
    });
  if (filter.author !== "all")
    activeFilterChips.push({
      label: `Author: ${filter.author}`,
      clear: () => setFilter("author", "all"),
    });
  if (filter.datePreset !== "any")
    activeFilterChips.push({
      label: `Edited: ${DATE_LABELS[filter.datePreset] ?? filter.datePreset}`,
      clear: () => setFilter("datePreset", "any"),
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

  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
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
      expandFolder(path);
    }, 600);
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

  return (
    <>
          {activityFor && (
            <ActivityLogPanel
              nestId={nestId}
              scope={activityFor.scope}
              label={activityFor.label}
              onClose={() => setActivityFor(null)}
              onOpenNode={(id) => {
                setActivityFor(null);
                onOpenDocument(id);
              }}
            />
          )}
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-3">
                <CardTitle className="text-lg">Documents</CardTitle>
                <div className="flex flex-wrap items-center gap-2 w-full">
                  <div className="relative flex-1 min-w-[12rem] sm:flex-none sm:w-80">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                    <Input
                      placeholder="Search title, tags, content…"
                      value={filter.search}
                      onChange={(e) => setFilter("search", e.target.value)}
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
                    <Select value={filter.status} onValueChange={(v) => setFilter("status", v)}>
                      <SelectTrigger className="w-[140px] h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Status</SelectItem>
                        {Object.entries(STATUS_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {typesPresent.length > 1 && (
                    <Select value={filter.type} onValueChange={(v) => setFilter("type", v)}>
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
                    <Select value={filter.author} onValueChange={(v) => setFilter("author", v)}>
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
                    value={filter.datePreset}
                    onValueChange={(v) => setFilter("datePreset", v as DatePreset)}
                  >
                    <SelectTrigger className="w-[140px] h-8" title="Filter by last edited">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="any">Any time</SelectItem>
                      {Object.entries(DATE_LABELS).map(([value, label]) => (
                        <SelectItem key={value} value={value}>{label}</SelectItem>
                      ))}
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
                  {/* An empty folder (census total, not just filtered out) can
                      go right from here — same gate as the tree's trash icon. */}
                  {knownFolders.find((f) => f.path === folderFilter)?.total === 0 &&
                    (canManage || (canEditDocs && !folderFlagPending(folderFilter))) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        setFolderTarget({ path: folderFilter, label: prettyFolderPath(folderFilter), total: 0 })
                      }
                      data-testid="delete-filtered-folder"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete folder
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
                  {filter.tags.length > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                      Tags: {filter.tags.join(", ")}
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => setFilter("tags", [])}
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
                    const active = filter.tags.includes(tag);
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
                  {filter.tags.length > 0 && (
                    <button
                      type="button"
                      className="text-muted-foreground hover:underline ml-1"
                      onClick={() => setFilter("tags", [])}
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
                  // A pending review freezes the doc for everyone but the
                  // person who submitted it — the server lets them revise and
                  // repoints the review (nodes/service updateNode), same as
                  // DocumentEditor's isOwnPendingReview.
                  const canEdit =
                    (node.status !== "pending_review" ||
                      (!!currentEmail &&
                        submitterByNode.get(node.id) === currentEmail)) &&
                    canEditNode(node);
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
                    nodeTypeSupportsMove(nodeType) &&
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
                            <DropdownMenuItem onSelect={() => onReview(node)}>
                              <CheckCircle2 className="h-3.5 w-3.5 mr-2" />
                              Review
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onSelect={() => openVersions(node)}>
                            <History className="h-3.5 w-3.5 mr-2" />
                            History
                          </DropdownMenuItem>
                          {canManage && (
                            <DropdownMenuItem
                              data-testid={`doc-activity-${node.id}`}
                              onSelect={() =>
                                setActivityFor({
                                  scope: { kind: "node", nodeId: node.id },
                                  label: node.title || node.id,
                                })
                              }
                            >
                              <Activity className="h-3.5 w-3.5 mr-2" />
                              Activity
                            </DropdownMenuItem>
                          )}
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
                                        onWithdrawDeletion(flag!);
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
                                      filter.tags.includes(t)
                                        ? `Remove filter ${t}`
                                        : `Filter by ${t}`
                                    }
                                    className={`rounded-full border px-1.5 py-px transition-colors ${filter.tags.includes(t)
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
                              onClick={() => onReview(node)}
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
                            {/* Admin activity log for everything under this
                                folder — owner/admin only, like /activity-log. */}
                            {canManage && (
                              <button
                                type="button"
                                className="rounded p-0.5 text-muted-foreground opacity-0 group-hover/fh:opacity-100 focus-visible:opacity-100 hover:text-primary hover:bg-primary/10"
                                title={`Activity in ${prettyFolderPath(node.path)}`}
                                aria-label={`Activity in ${prettyFolderPath(node.path)}`}
                                data-testid={`folder-activity-${node.path}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActivityFor({
                                    scope: { kind: "folder", folder: node.path },
                                    label: `${prettyFolderPath(node.path)}/`,
                                  });
                                }}
                              >
                                <Activity className="h-3.5 w-3.5" />
                              </button>
                            )}
                            {/* This folder's rules — where things go, how
                                files are named. Everyone can look; owners and
                                admins edit on the Structure page. */}
                            {onOpenStructure && (
                              <button
                                type="button"
                                className="rounded p-0.5 text-muted-foreground opacity-0 group-hover/fh:opacity-100 focus-visible:opacity-100 hover:text-primary hover:bg-primary/10"
                                title={`Rules for ${prettyFolderPath(node.path)}`}
                                aria-label={`Rules for ${prettyFolderPath(node.path)}`}
                                data-testid={`folder-rules-${node.path}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenStructure(node.path);
                                }}
                              >
                                <Ruler className="h-3.5 w-3.5" />
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
                                // An empty folder's only useful action is
                                // removing it, so it shows without a hover.
                                className={`rounded p-0.5 ${node.total === 0 ? "" : "opacity-0"} group-hover/fh:opacity-100 focus-visible:opacity-100 ${
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
                                          onWithdrawDeletion(folderFlag);
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
      {shareFolder && (
        <ShareTargetDialog
          nestId={nestId}
          targetType="folder"
          target={shareFolder.path}
          label={shareFolder.label}
          onClose={() => setShareFolder(null)}
        />
      )}

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
                  <code className="font-mono">{moveNewFolderCheck.label}</code>
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

      {submitNode && (
        <SubmitForReviewModal
          isOpen={!!submitNode}
          onClose={() => setSubmitNode(null)}
          documentTitle={submitNode.title}
          currentVersion={submitNode.version || 1}
          onSubmit={handleSubmitReview}
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

      {folderTarget && (
        <FolderDeleteDialog
          nestId={nestId}
          folder={folderTarget}
          canManage={canManage}
          onClose={() => setFolderTarget(null)}
          onDone={() => {
            // A deleted folder (or its parent) can't stay the active filter.
            const gone = folderTarget.path;
            if (canManage && folderFilter && (folderFilter === gone || folderFilter.startsWith(gone + "/")))
              setFolderFilter(null);
            fetchData();
          }}
        />
      )}

      {deleteNodeTarget && (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setDeleteNodeTarget(null)}
          title={`Delete "${deleteNodeTarget.title}"?`}
          description="This removes the document, its version history, comments and annotations. It cannot be undone."
          warning={inboundLinkWarning(deleteBacklinks)}
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
    </>
  );
}
