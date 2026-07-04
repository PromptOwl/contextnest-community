/**
 * NestView — governance dashboard for a single nest.
 * Uses ported PromptOwl components for the UI, wired to REST API.
 */
import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from "react";
import * as api from "../lib/api";
import { matchesFilters } from "../lib/node-filter";
import { linkHealth } from "../lib/link-health";
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
  FolderOpen, ChevronRight, FileStack, Bot, Zap, FolderPlus, Wrench,
} from "lucide-react";
import { ConnectModal } from "./ConnectModal";

/** One icon per node type — agent/skill/artifact/document each read distinctly. */
function NodeTypeIcon({
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
  SubmitForReviewModal, VersionHistory, LifecycleStatusBadge,
  type Steward, type StewardRole, type ReviewRequest, type Version,
  type DocumentLifecycleStatus,
} from "./governance";
import { useAuth } from "../auth/AuthContext";
import { MarkdownEditor } from "./MarkdownEditor";
import { CollaboratorManager } from "./CollaboratorManager";
import { toast } from "sonner";

function timeAgo(dateStr: string) {
  const date = new Date(dateStr);
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function prettyFolder(name: string) {
  if (name === "Root") return "Root";
  return name
    .split(/[-_]/)
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
    .join(" ");
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

/** "nodes/gtm/deals" → "Nodes / Gtm / Deals" for nested group headers. */
function prettyFolderPath(path: string) {
  if (path === "Root") return "Root";
  return path.split("/").map(prettyFolder).join(" / ");
}

interface NestViewProps {
  nestId: string;
  nestName: string;
  isOwner: boolean;
  isAnonOwned: boolean;
  onBack: () => void;
  onOpenDocument: (nodeId: string | "new") => void;
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
  const [externalEdits, setExternalEdits] = useState<api.ExternalEditEntry[]>([]);
  const [externalEditsLoading, setExternalEditsLoading] = useState(false);
  const [stewardshipEnabled, setStewardshipEnabled] = useState(false);
  const [allowSelfApprove, setAllowSelfApprove] = useState(false);
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
  const [search, setSearch] = useState(initialSearch ?? "");
  // Multi-tag AND filter; toggled by clicking tag chips on list rows.
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const toggleTagFilter = (tag: string) =>
    setTagFilters((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  const [statusFilter, setStatusFilter] = useState<string>("all");
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
  const [newFolderPath, setNewFolderPath] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);

  const createFolder = async () => {
    const folder = newFolderPath.trim().replace(/^\/+|\/+$/g, "");
    if (!folder) return;
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
    } catch (e) {
      console.error("[NestView] createFolder failed", e);
    } finally {
      setCreatingFolder(false);
    }
  };
  const [showShare, setShowShare] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

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

  const handleDropOnFolder = async (targetFolder: string) => {
    const nodeId = dragNodeId;
    setDragNodeId(null);
    setDropFolder(null);
    if (!nodeId) return;
    if (folderOfNode(nodeId) === targetFolder) return; // already there
    try {
      await api.moveNode(nestId, nodeId, targetFolder);
      toast.success(
        targetFolder
          ? `Moved to ${prettyFolderPath(targetFolder)}`
          : "Moved to nest root",
      );
      fetchData();
    } catch (err: any) {
      console.error("[NestView] moveNode failed", nestId, nodeId, targetFolder, err);
      toast.error(err?.message || "Move failed");
    }
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    // Each request is independently swallowed — if listNodes throws, we must
    // still apply stewardshipEnabled from the settings response. Previously a
    // single Promise.all + outer try/catch meant a node-list error silently
    // dropped the settings update, so toggling stewardship appeared to revert.
    const [nodesData, stewardsData, queueData, settingsData, externalData, nestMeta, countsData] =
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
        api.getNestSettings(nestId).catch((e) => {
          console.error("[NestView] getNestSettings failed", nestId, e);
          return { stewardship_enabled: false, allow_self_approve: false };
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
      ]);
    setCommentCounts(countsData.counts);
    setNodes(nodesData.nodes);
    setStewards(stewardsData.stewards);
    setReviewQueue(queueData.requests);
    setStewardshipEnabled(settingsData.stewardship_enabled);
    setAllowSelfApprove(settingsData.allow_self_approve);
    setExternalEdits(externalData.entries);
    if (nestMeta?.nest?.visibility) {
      setVisibility(nestMeta.nest.visibility);
    }
    if (nestMeta?.nest) {
      setIsImported(!!(nestMeta.nest as any).is_imported);
    }
    if (nestMeta?.permission) {
      setPermission(nestMeta.permission);
    }
    setRoles(nestMeta?.roles ?? []);
    setMyStewards((nestMeta?.myStewards ?? []) as Steward[]);
    setLoading(false);
  }, [nestId]);

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
  /** A group is hidden when any strict ancestor folder (inside the current
   *  scope) is collapsed. The folder's own collapsed state only hides its
   *  doc rows — the header stays visible as the expand handle. */
  const isUnderCollapsed = (folder: string) => {
    if (!folder) return false;
    const segs = folder.split("/");
    for (let i = 1; i < segs.length; i++) {
      const prefix = segs.slice(0, i).join("/");
      if (baseFolder === prefix || baseFolder.startsWith(`${prefix}/`)) continue;
      if (collapsedFolders.has(prefix)) return true;
    }
    return false;
  };

  // Orphans + broken [[links]], client-side from the loaded list.
  const wikiHealth = useMemo(() => linkHealth(nodes), [nodes]);

  // Distinct authors for the author filter dropdown.
  const authors = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) if (n.author) set.add(n.author);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [nodes]);

  const hasActiveFilters =
    !!search ||
    statusFilter !== "all" ||
    tagFilters.length > 0 ||
    authorFilter !== "all" ||
    dateFilter !== "any";
  const clearAllFilters = () => {
    setSearch("");
    setStatusFilter("all");
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
  const activeFilterChips: Array<{ label: string; clear: () => void }> = [];
  if (search)
    activeFilterChips.push({ label: `Search: ${search}`, clear: () => setSearch("") });
  if (statusFilter !== "all")
    activeFilterChips.push({
      label: `Status: ${STATUS_LABELS[statusFilter] ?? statusFilter}`,
      clear: () => setStatusFilter("all"),
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
    stewardshipEnabled || caps.canReviewDocs || reviewQueue.length > 0;

  // Computed here so the Review Queue card binds to reviewableQueue.length
  // (what the user can actually act on) instead of reviewQueue.length
  // (raw size, which over-promised before — see CU-86ahn99fv).
  const stats = {
    total: nodes.length,
    pending: nodes.filter((n) => n.status === "pending_review").length,
    approved: nodes.filter((n) => n.status === "approved").length,
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

  const handleRemoveSteward = async (stewardId: string) => {
    const ok = window.confirm(
      "Remove this steward? They will lose approval rights immediately. The user account and any documents stay intact.",
    );
    if (!ok) return;
    try {
      await api.removeSteward(nestId, stewardId);
      fetchData();
    } catch (err: any) {
      console.error("[NestView] removeSteward failed", nestId, stewardId, err);
      window.alert(err?.message || "Failed to remove steward");
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

  const handleDeleteNode = async (node: any) => {
    // Plain confirm — destructive, irreversible. Promoting to a fancy
    // AlertDialog when the rest of the destructive surfaces (nest
    // delete, key revoke) standardise on one is a follow-up.
    const ok = window.confirm(
      `Delete "${node.title}"? This cannot be undone.`,
    );
    if (!ok) return;
    try {
      await api.deleteNode(nestId, node.id);
      fetchData();
    } catch (err: any) {
      console.error("[NestView] deleteNode failed", nestId, node?.id, err);
      window.alert(err?.message || "Failed to delete document");
    }
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
          try {
            const text = await file.text();
            const res = await api.createNode(nestId, { title, content: text, type });
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
          {!isReadOnly && (
            <>
              {/* Settings is stewardship-only and server-admin gated. Also
                  hidden when the admin is viewing a real user's nest —
                  stewardship is a governance concern over the commons /
                  the admin's own nests, not something to impose on a user
                  who owns their own nest. */}
              {canManageGovernance && (
                <Button variant="outline" onClick={() => setShowSettings(true)}>
                  <SettingsIcon className="h-4 w-4 mr-2" />
                  Settings
                </Button>
              )}
              {canEditDocs && (
                <>
                  {/* Visible import affordance — same path as drag-and-drop. */}
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
                  <Button
                    variant="outline"
                    onClick={() => importInputRef.current?.click()}
                    title="Import .md or .html files (or just drag them onto the page)"
                    data-testid="nest-import-files"
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    Import
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setShowGenerate(true)}
                    title="Generate context with an AI agent and push it into this nest"
                    data-testid="nest-generate-context"
                  >
                    <Sparkles className="h-4 w-4 mr-2" />
                    Add with AI
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setShowNewFolder(true)}
                    title="Create a folder (nest with parent/child)"
                  >
                    <FolderPlus className="h-4 w-4 mr-2" />
                    New Folder
                  </Button>
                  <Button onClick={() => onOpenDocument("new")}>
                    <Plus className="h-4 w-4 mr-2" />
                    New Document
                  </Button>
                </>
              )}
            </>
          )}
          {/* Secondary actions collapsed into an overflow menu at the end.
              Connect: view-only export/data-egress. Share: owner/admin only
              (server requires admin on /collaborators + /visibility). Delete:
              destructive, write+admin gated. */}
          {(() => {
            const actions: OverflowAction[] = [
              {
                label: "Connect",
                icon: Link2,
                onSelect: () => setShowConnect(true),
              },
            ];
            if (canManage)
              actions.push({
                label: "Share",
                icon: Users,
                onSelect: () => setShowShare(true),
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
            if (!isReadOnly && canDeleteNest)
              actions.push({
                label: "Delete",
                icon: Trash2,
                destructive: true,
                separatorBefore: true,
                onSelect: () => setShowDelete(true),
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
        <TabsList className="mb-4">
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

        {/* Overview — the nest's index/landing: stat tiles, recently-edited
            rows, and a grouped table-of-contents grid so opening a nest
            presents an index rather than just the flat node list. */}
        <TabsContent value="overview" className="space-y-4">
          {/* Stat tiles */}
          <div
            className={`grid gap-3 ${
              stewardshipEnabled ? "sm:grid-cols-4" : "sm:grid-cols-3"
            } grid-cols-2`}
          >
            <Card className="border-muted/60">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="rounded-md bg-primary/10 text-primary p-2">
                  <FileStack className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-2xl font-semibold leading-none">
                    {stats.total}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Document{stats.total === 1 ? "" : "s"}
                  </div>
                </div>
              </CardContent>
            </Card>
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
                    {recentlyEdited.length}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    Recently edited
                  </div>
                </div>
              </CardContent>
            </Card>
            {stewardshipEnabled && (
              <Card className="border-muted/60">
                <CardContent className="p-4 flex items-center gap-3">
                  <div className="rounded-md bg-emerald-500/10 text-emerald-600 p-2">
                    <CheckCircle2 className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="text-2xl font-semibold leading-none">
                      {stats.approved}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      Approved
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
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
                        {n.type === "artifact" && (
                          <span
                            className="shrink-0 rounded bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide"
                            title="Hosted HTML artifact"
                          >
                            HTML
                          </span>
                        )}
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
                <div className="space-y-5">
                  {tocGroups.map((g) => (
                    <div
                      key={g.folder}
                      style={{ marginLeft: `${g.depth * 1.25}rem` }}
                    >
                      {/* Root = docs directly under nodes/; no folder header.
                          Folder headers open the Documents tab scoped to that
                          folder — the Overview doubles as folder navigation. */}
                      {g.folder !== "Root" && (
                        <button
                          type="button"
                          onClick={() => openFolderInDocuments(g.folder)}
                          className="flex items-center gap-2 mb-2 group/folder rounded px-1 -mx-1 hover:bg-muted/60"
                          title={`Browse ${prettyFolderPath(g.folder)} in Documents`}
                        >
                          <FolderOpen className="h-4 w-4 text-muted-foreground" />
                          <h4 className="text-sm font-medium group-hover/folder:underline">
                            {prettyFolderPath(g.folder)}
                          </h4>
                          <Badge
                            variant="secondary"
                            className="text-[10px] px-1.5 py-0 h-5"
                          >
                            {g.items.length}
                          </Badge>
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 group-hover/folder:text-muted-foreground" />
                        </button>
                      )}
                      <div className="grid gap-1 sm:grid-cols-2">
                        {g.items.map((n) => (
                          <button
                            key={n.id}
                            onClick={() => onOpenDocument(n.id)}
                            className="flex items-center gap-2 py-1.5 px-2 rounded-md hover:bg-muted/50 text-left group min-w-0"
                            title={n.title || n.id}
                          >
                            <NodeTypeIcon type={n.type} className="h-3.5 w-3.5" />
                            <span className="text-sm truncate flex-1">
                              {n.title || n.id}
                            </span>
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 group-hover:text-muted-foreground shrink-0" />
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="documents" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <CardTitle className="text-lg">Documents</CardTitle>
                <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
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
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 hover:bg-muted truncate max-w-[180px] ${
                        n.type === "artifact"
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
              {loading ? (
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
                    const isArtifact = node.type === "artifact";
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
                    const canDelete = canEditNode(node);
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
                            {canDelete && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  onSelect={() => handleDeleteNode(node)}
                                  className="text-destructive focus:text-destructive"
                                >
                                  <Trash2 className="h-3.5 w-3.5 mr-2" />
                                  Delete
                                </DropdownMenuItem>
                              </>
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
                          } p-3 rounded-lg border hover:bg-muted/50 transition-colors group cursor-pointer ${
                            dragNodeId === node.id ? "opacity-40" : ""
                          }`}
                        style={!cards && indent ? { marginLeft: `${indent * 1.25}rem` } : undefined}
                        draggable={!cards && canEditNode(node)}
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/plain", node.id);
                          e.dataTransfer.effectAllowed = "move";
                          setDragNodeId(node.id);
                        }}
                        onDragEnd={() => {
                          setDragNodeId(null);
                          setDropFolder(null);
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
                            {isArtifact && (
                              <span
                                className="shrink-0 rounded bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide"
                                title="Hosted HTML artifact"
                              >
                                HTML
                              </span>
                            )}
                            <LifecycleStatusBadge
                              status={(node.status as DocumentLifecycleStatus) || "draft"}
                              size="sm"
                              className="shrink-0 whitespace-nowrap"
                            />
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
                            <Button variant="ghost" size="sm" onClick={() => openVersions(node)} title="History">
                              <History className="h-3.5 w-3.5" />
                            </Button>
                            {canDelete && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDeleteNode(node)}
                                title="Delete"
                                className="text-destructive hover:text-destructive hover:bg-destructive/10"
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
                          className={`flex items-center gap-2 rounded-md border-2 border-dashed px-3 py-2 text-sm ${
                            dropFolder === baseFolder
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
                      {docGroups.map((g) => {
                        if (g.folder && g.folder !== baseFolder && isUnderCollapsed(g.folder))
                          return null;
                        const showHeader = g.folder && g.folder !== baseFolder;
                        const isCollapsed = collapsedFolders.has(g.folder);
                        const isDropTarget = dropFolder === g.folder;
                        return (
                          <div key={g.folder || "__root"}>
                            {showHeader && (
                              <div
                                className={`flex items-center gap-1.5 py-1.5 px-2 rounded-md select-none cursor-pointer transition-colors ${
                                  isDropTarget
                                    ? "bg-primary/10 ring-1 ring-primary"
                                    : "hover:bg-muted/50"
                                }`}
                                style={{
                                  marginLeft: `${Math.max(0, g.depth - 1) * 1.25}rem`,
                                }}
                                onClick={() => toggleFolderCollapsed(g.folder)}
                                onDragOver={(e) => {
                                  if (!dragNodeId) return;
                                  e.preventDefault();
                                  e.dataTransfer.dropEffect = "move";
                                }}
                                onDragEnter={() => dragNodeId && setDropFolder(g.folder)}
                                onDragLeave={() =>
                                  setDropFolder((d) => (d === g.folder ? null : d))
                                }
                                onDrop={(e) => {
                                  e.preventDefault();
                                  handleDropOnFolder(g.folder);
                                }}
                                data-testid={`folder-header-${g.folder}`}
                              >
                                <ChevronRight
                                  className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
                                    isCollapsed ? "" : "rotate-90"
                                  }`}
                                />
                                <FolderOpen className="h-4 w-4 text-blue-500" />
                                <span className="text-sm font-medium">
                                  {prettyFolder(g.folder.split("/").pop()!)}
                                </span>
                                <Badge
                                  variant="secondary"
                                  className="text-[10px] px-1.5 py-0 h-5"
                                >
                                  {g.items.length}
                                </Badge>
                              </div>
                            )}
                            {!(showHeader && isCollapsed) && (
                              <div className="space-y-1">
                                {g.items.map((n) => renderDocRow(n, g.depth))}
                              </div>
                            )}
                          </div>
                        );
                      })}
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
            {/* The caller's own submissions, kept out of the actionable queue
                by separation-of-duties. Shown read-only so "submit for review"
                visibly lands somewhere. */}
            {myPendingSubmissions.length > 0 && (
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
            <ReviewQueue
              requests={reviewableQueue}
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
            {/* When the raw queue has entries but the reviewable filter
                emptied it, the queue card says "All caught up!" — which
                is wrong. Surface the gap so the user knows items exist
                but aren't actionable by them (scope or SoD). */}
            {reviewQueue.length > 0 && reviewableQueue.length === 0 && (
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
              {externalEdits.length === 0 ? (
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
                              {new Date(entry.detected_at).toLocaleString()}
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
                    onRemove={canManageGovernance ? handleRemoveSteward : undefined}
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
                />
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>

      {!stewardshipEnabled && !isReadOnly && canManageGovernance && (
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
          canManageStewardship={canManageGovernance}
          onClose={() => setShowSettings(false)}
          onChanged={() => { setShowSettings(false); fetchData(); }}
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
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowNewFolder(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void createFolder()}
              disabled={creatingFolder || !newFolderPath.trim()}
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

      {versionNode && (
        <Dialog open onOpenChange={() => setVersionNode(null)}>
          <DialogContent className="sm:max-w-[600px] max-h-[85vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle>{versionNode.title}</DialogTitle>
            </DialogHeader>
            <VersionHistory
              className="flex-1 min-h-0 overflow-hidden"
              versions={versionData.versions}
              currentVersion={versionData.currentVersion}
              approvedVersion={versionData.approvedVersion}
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
          </DialogContent>
        </Dialog>
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
