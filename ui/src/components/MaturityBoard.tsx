/**
 * MaturityBoard — a configurable kanban over a nest's nodes. Columns are keyed
 * by a dimension the viewer picks (Folder, Status, or a Tag namespace like
 * `stage:*`), so the same nest can be viewed as "where does this live" or
 * "how mature is this". Dragging a card between columns mutates the underlying
 * dimension where a clean write exists:
 *   - Folder → moveNode (the id changes)
 *   - Tag    → updateNode (swap the namespaced tag)
 *   - Status → NOT settable here; governance moves through the review workflow,
 *              so a status drag is refused with an explanatory toast.
 *
 * All bucketing / drag-plan rules live in lib/board-dimensions (pure, tested);
 * this file owns React state, localStorage, and running the plan against the API.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NestPageHeader } from "./NestPageHeader";
import {
  RefreshCw,
  Loader2,
  FileText,
  FileType,
  Zap,
  Bot,
  Database,
  GripVertical,
  X,
  Plus,
  ListTodo,
  Lock,
  ChevronDown,
  Filter,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { orderByRank, placeCard, rankKey } from "../lib/board-rank";
import { toast } from "sonner";
import * as api from "../lib/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { reads, useNestSettings } from "../lib/queries";
import { useAuth } from "../auth/AuthContext";
import { deriveNestCaps, isNestArchived } from "../lib/nest-caps";
import { MAX_FOLDER_DEPTH } from "../lib/constants";
import { slugifyFolderPath } from "../lib/folder-target";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  UNCATEGORIZED,
  capitalizeColumnHeader,
  cardColumnKeys,
  groupByColumn,
  layoutKey,
  migrateLayout,
  newCardPlacement,
  planMove,
  resolveConfig,
  type BoardNode,
  type MovePlan,
  type BoardSettings,
  type ColumnLayout,
  type DimensionKind,
} from "../lib/board-dimensions";
import {
  UNASSIGNED,
  assigneesOnBoard,
  localToday,
  matchesAssigneeFilter,
  moveNeedsReview,
  subItemsByParent,
  timestampsTooltip,
  type Priority,
} from "../lib/board-tasks";
import { timeAgo } from "./nest/node-display";
import {
  AddCardComposer,
  AssigneeMenu,
  Avatar,
  DueChip,
  GovernedMoveDialog,
  PriorityMenu,
  ShareAndAssignDialog,
  SubItemChip,
} from "./board/CardParts";

interface Props {
  nestId: string;
  nestName: string;
  isOwner: boolean;
  /** Nest is archived — opened from the Archived section, forces read-only. */
  isArchived?: boolean;
  onBack: () => void;
  onOpenDocument: (nodeId: string) => void;
}

const CONFIG_PREFIX = "cn.board.";

function loadConfig(nestId: string): BoardSettings {
  try {
    const raw = localStorage.getItem(CONFIG_PREFIX + nestId);
    if (raw) {
      const p = JSON.parse(raw);
      const dimension: DimensionKind =
        p.dimension === "status" || p.dimension === "tag" ? p.dimension : "folder";
      const tagNamespace =
        typeof p.tagNamespace === "string" ? p.tagNamespace : "";
      const strings = (v: unknown): string[] | undefined =>
        Array.isArray(v) ? v.filter((k) => typeof k === "string") : undefined;
      // Restore the customised column order + hidden columns, per dimension, so
      // a reordered / curated board survives a reload.
      const layouts: Record<string, ColumnLayout> = {};
      for (const [k, v] of Object.entries(p.layouts ?? {})) {
        if (v && typeof v === "object") {
          layouts[k] = migrateLayout(k, {
            columnOrder: strings((v as any).columnOrder),
            hiddenColumns: strings((v as any).hiddenColumns),
          });
        }
      }
      // Saves from before layouts existed kept one shared order; file it under
      // whichever dimension was active when it was written.
      const legacy = {
        columnOrder: strings(p.columnOrder),
        hiddenColumns: strings(p.hiddenColumns),
      };
      if (legacy.columnOrder || legacy.hiddenColumns) {
        const lk = layoutKey({ dimension, tagNamespace });
        layouts[lk] ??= migrateLayout(lk, legacy);
      }
      return {
        dimension,
        tagNamespace,
        layouts,
        tasksOnly: p.tasksOnly === true,
        filterTags: strings(p.filterTags),
      };
    }
  } catch {
    // ignore corrupt storage — fall through to default
  }
  // Empty namespace = group by every tag, which is the only setting that shows
  // real columns on a vault of flat (un-namespaced) tags.
  return { dimension: "folder", tagNamespace: "", layouts: {} };
}

/** A saved board's config → the settings this component works on. Same
 *  normalisation as loadConfig, so a hand-edited blob can't break the page. */
function settingsFromBoard(cfg: Record<string, any>): BoardSettings {
  const dimension: DimensionKind =
    cfg?.dimension === "status" || cfg?.dimension === "tag" ? cfg.dimension : "folder";
  const strings = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((k) => typeof k === "string") : undefined;
  const layouts: Record<string, ColumnLayout> = {};
  for (const [k, v] of Object.entries(cfg?.layouts ?? {})) {
    if (v && typeof v === "object") {
      layouts[k] = migrateLayout(k, {
        columnOrder: strings((v as any).columnOrder),
        hiddenColumns: strings((v as any).hiddenColumns),
      });
    }
  }
  const ranks: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(cfg?.ranks ?? {})) ranks[k] = strings(v) ?? [];
  return {
    dimension,
    tagNamespace: typeof cfg?.tagNamespace === "string" ? cfg.tagNamespace : "",
    layouts,
    tasksOnly: cfg?.tasksOnly === true,
    filterTags: strings(cfg?.filterTags),
    ranks,
  };
}

/** What a new board starts as: a project board, Trello's three lists. */
const NEW_BOARD_CONFIG = {
  dimension: "tag",
  tagNamespace: "",
  tasksOnly: true,
  layouts: { "tag:": { columnOrder: ["todo", "doing", "done"] } },
};

const ACTIVE_PREFIX = "cn.board.active.";

function saveConfig(nestId: string, config: BoardSettings) {
  try {
    localStorage.setItem(CONFIG_PREFIX + nestId, JSON.stringify(config));
  } catch {
    // storage full / disabled — the board still works this session
  }
}

function TypeIcon({ type }: { type: string }) {
  const cls = "h-3.5 w-3.5 shrink-0";
  if (type === "skill") return <Zap className={`${cls} text-blue-500`} />;
  if (type === "agent") return <Bot className={`${cls} text-violet-500`} />;
  if (type === "table") return <Database className={`${cls} text-emerald-500`} />;
  if (type === "pdf") return <FileType className={`${cls} text-rose-500`} />;
  if (type === "task") return <ListTodo className={`${cls} text-indigo-500`} />;
  return <FileText className={`${cls} text-muted-foreground`} />;
}

export function MaturityBoard({
  nestId,
  nestName,
  isOwner,
  isArchived,
  onBack,
  onOpenDocument,
}: Props) {
  const { isAdmin, adminStatus, typeTaskEnabled } = useAuth();
  const me = adminStatus?.me?.email?.toLowerCase();
  const qc = useQueryClient();
  const nestSettings = useNestSettings(nestId);
  const [nodes, setNodes] = useState<BoardNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<BoardSettings>(() => loadConfig(nestId));
  const [dragId, setDragId] = useState<string | null>(null);
  // The column a card was dragged out of — needed on the tag board to know
  // which tag to drop when retagging a multi-tagged card.
  const [dragFromCol, setDragFromCol] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Same derivation NestView uses. Starts false so a read-only viewer never
  // sees a draggable card during the fetch, then flips on for writers.
  const [canEditDocs, setCanEditDocs] = useState(false);
  // Owner/admin may share the nest from the assignee picker; others only see members.
  const [canShare, setCanShare] = useState(false);
  const [pendingShare, setPendingShare] = useState<{ id: string; email: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getNest(nestId)
      .then((meta: any) => {
        if (cancelled) return;
        setCanShare(isOwner || isAdmin || meta?.permission === "admin");
        setCanEditDocs(
          deriveNestCaps({
            roles: meta?.roles ?? [],
            permission: meta?.permission ?? null,
            myStewards: meta?.myStewards ?? [],
            isOwner,
            isAdmin,
            // OR'd with the fetched nest itself, not just the isArchived prop
            // threaded down from App's View state — this page is also
            // reachable by a route that doesn't forward it (a deep link, a
            // refresh while already here), and the fetch this effect already
            // makes is the authoritative answer regardless of how we got here.
            isArchived: isArchived || isNestArchived(meta?.nest),
          }).canEditDocs,
        );
      })
      .catch(() => {
        // Can't resolve caps → leave the board read-only rather than offer a
        // drag the server will refuse.
      });
    return () => {
      cancelled = true;
    };
  }, [nestId, isOwner, isAdmin, isArchived]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Metadata-only, nest-wide — every node in the nest buckets into a
      // column, and the board never reads a body, so this skips the vault
      // crawl `reads.nodes` (content=1) would otherwise pay on every load.
      const { nodes: raw } = await qc.fetchQuery(reads.nodesMeta(nestId));
      setNodes(
        (raw as any[]).map((n) => ({
          id: n.id,
          title: n.title ?? n.id,
          type: n.type ?? "document",
          tags: Array.isArray(n.tags) ? n.tags : [],
          status: n.status ?? "",
          assignee: n.assignee,
          assigned_at: n.assigned_at,
          due: n.due,
          priority: n.priority,
          parent: n.parent,
          moved_at: n.moved_at,
          created_at: n.created_at,
          updated_at: n.updated_at,
          prime: n.prime,
        })),
      );
    } catch (e: any) {
      setError(e?.message || "Failed to load nodes");
    } finally {
      setLoading(false);
    }
  }, [nestId, qc]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Saved boards ──
  // Several named views per nest, stored on the server (shared unless
  // private). Before any exist, the browser-saved layout is the one board;
  // a writer's first visit turns it into the nest's first saved board.
  const [boards, setBoards] = useState<api.SavedBoard[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_PREFIX + nestId);
    } catch {
      return null;
    }
  });
  const activeBoard = useMemo(
    () => boards?.find((b) => b.id === activeId) ?? boards?.[0] ?? null,
    [boards, activeId],
  );
  const seeding = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listBoards(nestId)
      .then(({ boards }) => !cancelled && setBoards(boards))
      .catch(() => !cancelled && setBoards([]));
    return () => {
      cancelled = true;
    };
  }, [nestId]);

  // First visit by a writer to a nest with no saved boards: save the layout
  // they already had as "Board", so nothing they arranged is lost.
  useEffect(() => {
    if (!boards || boards.length > 0 || !canEditDocs || seeding.current) return;
    seeding.current = true;
    const local = loadConfig(nestId);
    api
      .createBoard(nestId, { name: "Board", config: local as any })
      .then(({ board }) => setBoards((bs) => (bs && bs.length > 0 ? bs : [board])))
      .catch(() => {
        // Stay on the browser-saved board; nothing is lost.
      });
  }, [boards, canEditDocs, nestId]);

  // Switching boards loads that board's view.
  const loadedBoardId = useRef<string | null>(null);
  useEffect(() => {
    if (!activeBoard || loadedBoardId.current === activeBoard.id) return;
    loadedBoardId.current = activeBoard.id;
    setConfig(settingsFromBoard(activeBoard.config));
    setAssigneeFilter(new Set());
    try {
      localStorage.setItem(ACTIVE_PREFIX + nestId, activeBoard.id);
    } catch {
      /* per-browser convenience only */
    }
  }, [activeBoard, nestId]);

  // Layout edits save to the active board, debounced so dragging headers or
  // typing a namespace is one write. Ranks are written separately (per
  // column), so they're stripped here — the server keeps the stored ones.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback(
    (next: BoardSettings) => {
      saveConfig(nestId, next);
      const board = activeBoard;
      if (!board || !canEditDocs) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const { ranks: _ranks, ...config } = next;
        api
          .updateBoard(nestId, board.id, { config })
          .then(({ board: saved }) =>
            setBoards((bs) => bs?.map((b) => (b.id === saved.id ? saved : b)) ?? bs),
          )
          .catch((e: any) => toast.error(e?.message || "Couldn't save the board"));
      }, 400);
    },
    [nestId, activeBoard, canEditDocs],
  );

  const updateConfig = useCallback(
    (patch: Partial<BoardSettings>) => {
      setConfig((prev) => {
        const next = { ...prev, ...patch };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  /** Patch only the active dimension's column layout. */
  const updateLayout = useCallback(
    (patch: ColumnLayout) => {
      setConfig((prev) => {
        const key = layoutKey(prev);
        const next = {
          ...prev,
          layouts: {
            ...prev.layouts,
            [key]: { ...prev.layouts[key], ...patch },
          },
        };
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const effectiveConfig = useMemo(() => resolveConfig(config), [config]);

  // Quick-filter by person (Jira/ClickUp avatar row). Session-only: a filter
  // is a glance, not a setting.
  const [assigneeFilter, setAssigneeFilter] = useState<Set<string>>(new Set());
  const toggleAssignee = useCallback((key: string) => {
    setAssigneeFilter((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const boardPeople = useMemo(() => assigneesOnBoard(nodes), [nodes]);
  const subItems = useMemo(() => subItemsByParent(nodes), [nodes]);

  const visibleNodes = useMemo(
    () =>
      nodes.filter(
        (n) =>
          (!config.tasksOnly || n.type === "task") &&
          matchesAssigneeFilter(n, assigneeFilter) &&
          (config.filterTags ?? []).every((f) =>
            n.tags.some(
              (t) => t.replace(/^#/, "").toLowerCase() === f.toLowerCase(),
            ),
          ),
      ),
    [nodes, config.tasksOnly, config.filterTags, assigneeFilter],
  );

  const { columns, byColumn } = useMemo(
    () => groupByColumn(visibleNodes, effectiveConfig),
    [visibleNodes, effectiveConfig],
  );

  // Each column in the active board's saved order (Linear/Jira stack rank).
  const orderedByColumn = useMemo(() => {
    const out: Record<string, BoardNode[]> = {};
    for (const col of columns) {
      out[col.key] = orderByRank(
        byColumn[col.key] ?? [],
        config.ranks?.[rankKey(config, col.key)],
      );
    }
    return out;
  }, [columns, byColumn, config]);

  /** Put a card at a position in a column and save that column's order. */
  const rankCard = useCallback(
    async (col: string, id: string, before: string | null) => {
      const board = activeBoard;
      if (!board) return;
      const key = rankKey(config, col);
      const current = (orderedByColumn[col] ?? []).map((n) => n.id);
      const order = placeCard(current, id, before);
      if (order.join("\n") === current.join("\n") && current.includes(id)) return;
      setConfig((prev) => ({ ...prev, ranks: { ...(prev.ranks ?? {}), [key]: order } }));
      try {
        const { board: saved } = await api.rankBoardColumn(nestId, board.id, key, order);
        setBoards((bs) => bs?.map((b) => (b.id === saved.id ? saved : b)) ?? bs);
      } catch (e: any) {
        toast.error(e?.message || "Couldn't save the order");
      }
    },
    [activeBoard, config, orderedByColumn, nestId],
  );
  // Where a dragged card would land: before this card id, or (null) at the
  // bottom of the column.
  const [dropBefore, setDropBefore] = useState<{ col: string; before: string | null } | null>(null);

  // The nest's people — who a card can be assigned to. Writers only: the
  // pickers are write affordances, and the roster read is gated anyway.
  const { data: roster } = useQuery({
    ...reads.mentionable(nestId),
    enabled: !!nestId && canEditDocs,
  });
  const people = useMemo(
    () =>
      (roster?.people ?? []).filter((p) => !!p.email && (canShare || p.member !== false)),
    [roster, canShare],
  );

  const governance = useMemo(
    () => ({
      stewardshipEnabled: !!nestSettings.data?.stewardship_enabled,
      primeOnlyReview: !!(nestSettings.data as any)?.prime_only_review,
      allowSelfApprove: !!nestSettings.data?.allow_self_approve,
      ownerOrAdmin: isOwner || isAdmin,
      primeTags: (((nestSettings.data as any)?.prime_tags ?? []) as string[]).map((t) =>
        t.replace(/^#+/, "").toLowerCase(),
      ),
    }),
    [nestSettings.data, isOwner, isAdmin],
  );

  const today = localToday();

  /** Set board fields on one card: optimistic, reverted if the server refuses. */
  const patchFields = useCallback(
    async (
      id: string,
      fields: { assignee?: string | null; due?: string | null; priority?: Priority | null },
    ) => {
      const prev = nodes.find((n) => n.id === id);
      if (!prev) return;
      const optimistic: BoardNode = { ...prev };
      for (const [k, v] of Object.entries(fields)) {
        (optimistic as any)[k] = v === null ? undefined : v;
      }
      setNodes((ns) => ns.map((n) => (n.id === id ? optimistic : n)));
      try {
        const res: any = await api.updateNode(nestId, id, fields);
        const r = res?.node;
        if (r) {
          setNodes((ns) =>
            ns.map((n) =>
              n.id === id
                ? {
                    ...n,
                    status: r.status ?? n.status,
                    assignee: r.assignee,
                    assigned_at: r.assigned_at,
                    due: r.due,
                    priority: r.priority,
                    updated_at: r.updated_at ?? n.updated_at,
                  }
                : n,
            ),
          );
        }
        qc.invalidateQueries({ queryKey: reads.nodesMeta(nestId).queryKey });
      } catch (e: any) {
        setNodes((ns) => ns.map((n) => (n.id === id ? prev : n)));
        toast.error(e?.message || "Couldn't update the card");
      }
    },
    [nodes, nestId, qc],
  );

  // ── "+ Add task" ──
  const [addingIn, setAddingIn] = useState<{ col: string; parent?: string } | null>(null);
  const createCard = useCallback(
    async (colKey: string, title: string, parent?: string) => {
      const placement = newCardPlacement(colKey, effectiveConfig);
      if (!placement) return;
      try {
        await api.createNode(nestId, {
          title,
          // The create route requires a body; a task's notes start empty.
          content: "\n",
          type: typeTaskEnabled ? "task" : "document",
          ...placement,
          // The board's tag filter too, or the new card would be filtered
          // straight off the board it was added to.
          ...((config.filterTags ?? []).length > 0
            ? {
                tags: [
                  ...new Set([
                    ...(placement.tags ?? []),
                    ...(config.filterTags ?? []).map((t) => `#${t}`),
                  ]),
                ],
              }
            : {}),
          ...(parent ? { parent } : {}),
          // Filtering by one person and adding a card hands it to them —
          // otherwise it would vanish from the filtered board on creation.
          ...(assigneeFilter.size === 1 && !assigneeFilter.has(UNASSIGNED)
            ? { assignee: [...assigneeFilter][0] }
            : {}),
        });
        qc.invalidateQueries({ queryKey: reads.nodesMeta(nestId).queryKey });
        await load();
      } catch (e: any) {
        toast.error(e?.message || "Couldn't add the task");
        throw e;
      }
    },
    [effectiveConfig, config.filterTags, nestId, typeTaskEnabled, assigneeFilter, qc, load],
  );

  const [pendingMove, setPendingMove] = useState<{
    id: string;
    title: string;
    plan: MovePlan;
    place?: { col: string; before: string | null };
  } | null>(null);

  const executeMove = useCallback(
    async (id: string, plan: MovePlan, place?: { col: string; before: string | null }) => {
      setBusy(true);
      try {
        if (plan.kind === "move-folder") {
          await api.moveNode(nestId, id, plan.folder);
          toast.success("Moved");
        } else if (plan.kind === "retag") {
          // updateNode replaces the tag set, so the plan's full next set both
          // adds the target column's tag and drops the source column's.
          const res: any = await api.updateNode(nestId, id, { tags: plan.tags });
          // Not "Moved" for a document: this rewrites its tags and saves a
          // new version. A draft result means it is now waiting on review.
          const s = res?.node?.status;
          const isTask = nodes.find((n) => n.id === id)?.type === "task";
          toast.success(
            s === "draft" || s === "pending_review"
              ? "Saved as a draft — waiting for review"
              : isTask
                ? "Moved"
                : "Retagged",
          );
        }
        // A folder move changes the id, so there's nothing stable to rank.
        if (place && plan.kind === "retag") await rankCard(place.col, id, place.before);
        await load();
      } catch (e: any) {
        toast.error(e?.message || "Move failed");
      } finally {
        setBusy(false);
      }
    },
    [nestId, nodes, load, rankCard],
  );

  const handleDrop = useCallback(
    async (targetKey: string) => {
      const id = dragId;
      const from = dragFromCol;
      const place =
        dropBefore && dropBefore.col === targetKey
          ? dropBefore
          : { col: targetKey, before: null };
      setDragId(null);
      setDragFromCol(null);
      setDropCol(null);
      setDropBefore(null);
      if (!id) return;
      const node = nodes.find((n) => n.id === id);
      if (!node) return;

      // Same column: a reorder. Rank lives on the board, so no document is
      // touched — works on every dimension, status included.
      if (from === targetKey) {
        if (activeBoard) await rankCard(targetKey, id, place.before);
        return;
      }

      const plan = planMove(node, targetKey, effectiveConfig, from ?? undefined);
      if (plan.kind === "unsupported") {
        // Silent for a pure no-op (same column); explain the real blockers.
        if (plan.reason !== "Already in this column.") toast(plan.reason);
        return;
      }
      // A retag is an edit. On a governed document it lands as a draft that
      // waits for review — say so before doing it, not after. Tasks skip
      // review, so they never see this. Folder moves don't draft.
      if (plan.kind === "retag" && moveNeedsReview(node, governance)) {
        setPendingMove({ id, title: node.title, plan, place });
        return;
      }
      await executeMove(id, plan, place);
    },
    [dragId, dragFromCol, dropBefore, nodes, effectiveConfig, governance, executeMove, activeBoard, rankCard],
  );

  // Folder and tag drags mutate the node (moveNode / retag). Status moves
  // through the review workflow, so it stays non-draggable. On the tag board a
  // card can sit in several columns; the source column (dragFromCol) tells us
  // which tag to drop. Write access is the second, independent condition.
  // Every dimension is draggable now that a same-column drop reorders: on the
  // status board a cross-column drop still explains itself (planMove).
  const draggable = canEditDocs;

  // ── Board tabs: create / rename / duplicate / share / delete ──
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [filterDraft, setFilterDraft] = useState("");
  const selectBoard = useCallback((id: string) => setActiveId(id), []);
  const upsertBoard = useCallback(
    (saved: api.SavedBoard) =>
      setBoards((bs) =>
        bs?.some((b) => b.id === saved.id)
          ? bs.map((b) => (b.id === saved.id ? saved : b))
          : [...(bs ?? []), saved],
      ),
    [],
  );
  const newBoard = useCallback(
    async (from?: api.SavedBoard) => {
      try {
        const { board } = await api.createBoard(nestId, {
          name: from ? `${from.name} copy` : "Untitled board",
          config: from ? from.config : NEW_BOARD_CONFIG,
        });
        upsertBoard(board);
        setActiveId(board.id);
        setRenaming({ id: board.id, value: board.name });
      } catch (e: any) {
        toast.error(e?.message || "Couldn't create the board");
      }
    },
    [nestId, upsertBoard],
  );
  const saveBoardMeta = useCallback(
    async (id: string, patch: { name?: string; private?: boolean }) => {
      try {
        const { board } = await api.updateBoard(nestId, id, patch);
        upsertBoard(board);
      } catch (e: any) {
        toast.error(e?.message || "Couldn't update the board");
      }
    },
    [nestId, upsertBoard],
  );
  const removeBoard = useCallback(
    async (b: api.SavedBoard) => {
      if (!window.confirm(`Delete the board "${b.name}"? The documents on it are not touched.`)) return;
      try {
        await api.deleteBoard(nestId, b.id);
        setBoards((bs) => bs?.filter((x) => x.id !== b.id) ?? bs);
        if (activeId === b.id) setActiveId(null);
        loadedBoardId.current = null;
      } catch (e: any) {
        toast.error(e?.message || "Couldn't delete the board");
      }
    },
    [nestId, activeId],
  );

  // ── Column management: reorder (all dimensions) + hide/add (tag columns) ──
  const [colDrag, setColDrag] = useState<string | null>(null);
  const [colDropTarget, setColDropTarget] = useState<string | null>(null);
  const [newColumn, setNewColumn] = useState("");

  // Reorderable keys — Uncategorized is pinned last by the lib, so exclude it.
  const orderedKeys = useMemo(
    () => columns.map((c) => c.key).filter((k) => k !== UNCATEGORIZED),
    [columns],
  );

  const reorderColumns = useCallback(
    (fromKey: string, toKey: string) => {
      if (fromKey === toKey) return;
      const order = [...orderedKeys];
      const from = order.indexOf(fromKey);
      const to = order.indexOf(toKey);
      if (from < 0 || to < 0) return;
      order.splice(from, 1);
      order.splice(to, 0, fromKey);
      updateLayout({ columnOrder: order });
    },
    [orderedKeys, updateLayout],
  );

  const hideColumn = useCallback(
    (key: string) =>
      updateLayout({
        // On an explicit-column board columnOrder IS the column set, so a
        // removed key must leave it too — otherwise the column stays alive
        // until the next reorder silently drops it. Folder/status re-derive
        // their columns from the data, so their saved order is left intact
        // and a column that repopulates keeps the position it was given.
        ...(effectiveConfig.explicitColumns
          ? { columnOrder: orderedKeys.filter((k) => k !== key) }
          : {}),
        hiddenColumns: [
          ...new Set([...(effectiveConfig.hiddenColumns ?? []), key]),
        ],
      }),
    [
      orderedKeys,
      effectiveConfig.explicitColumns,
      effectiveConfig.hiddenColumns,
      updateLayout,
    ],
  );

  /**
   * Add a column that holds no cards yet.
   *
   * For tags that is a tag value; for folders it is a folder path, and the
   * folder itself is created by the first card dropped into it (moveNode
   * writes the path server-side) — so a nest whose documents all sit in Root
   * has somewhere to drag them, which is the one interaction the board's own
   * instructions describe. It is layout-only until then, and removable with
   * the × while it holds no cards.
   *
   * The folder key is slugified here because the server slugifies the path it
   * writes: keyed on the typed text, "New Folder" would sit empty next to the
   * `new-folder` column the dropped card actually created.
   */
  const addColumn = useCallback(
    (value: string) => {
      const v =
        effectiveConfig.dimension === "folder"
          ? slugifyFolderPath(value)
          : // Tag column keys are the bare value; "#doing" and "doing" are the
            // same column (board-dimensions strips the stored "#").
            value.trim().replace(/^#/, "");
      if (effectiveConfig.dimension === "folder" && !v) {
        // Slugifying to nothing is the same bound the server enforces: a name
        // with no letter or digit has no path to derive.
        if (value.trim()) {
          toast("A folder name needs at least one letter or digit.");
        }
        return;
      }
      if (!v) return;
      if (effectiveConfig.dimension === "folder") {
        if (v.split("/").length > MAX_FOLDER_DEPTH) {
          toast(`Folders may nest at most ${MAX_FOLDER_DEPTH} levels deep.`);
          return;
        }
      }
      updateLayout({
        // Append to the order (a key in columnOrder shows even with no cards)
        // and un-hide it if it was removed earlier.
        columnOrder: [...new Set([...orderedKeys, v])],
        hiddenColumns: (effectiveConfig.hiddenColumns ?? []).filter(
          (k) => k !== v,
        ),
      });
      setNewColumn("");
    },
    [
      orderedKeys,
      effectiveConfig.dimension,
      effectiveConfig.hiddenColumns,
      updateLayout,
    ],
  );

  // Distinct tag values present in the nest — suggestions for the add-column box.
  const availableTagValues = useMemo(() => {
    if (effectiveConfig.dimension !== "tag") return [];
    const set = new Set<string>();
    for (const n of nodes) {
      for (const k of cardColumnKeys(n, effectiveConfig)) {
        if (k !== UNCATEGORIZED) set.add(k);
      }
    }
    return [...set].sort();
  }, [nodes, effectiveConfig]);

  return (
    <div className="space-y-4">
      <NestPageHeader nestName={nestName} onBack={onBack}>
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground">Columns by</label>
          <select
            value={config.dimension}
            onChange={(e) => {
              // The add-column input is shared between folder and tag mode;
              // an unsubmitted value from one doesn't mean anything in the
              // other, so switching dimensions clears it.
              setNewColumn("");
              updateConfig({ dimension: e.target.value as DimensionKind });
            }}
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="folder">Folder</option>
            <option value="status">Status</option>
            <option value="tag">Tag namespace</option>
          </select>
          {config.dimension === "tag" && (
            <Input
              value={config.tagNamespace ?? ""}
              onChange={(e) => updateConfig({ tagNamespace: e.target.value })}
              placeholder="all tags"
              className="h-8 w-32"
              title="Optional. Empty groups by every tag; a namespace like 'stage' groups by stage:<value> tags only."
            />
          )}
          {/* Add a column: a tag value, or — for writers on the folder board —
              a folder. Without this a nest whose documents all sit in Root has
              a single column and nowhere to drag them. */}
          {(config.dimension === "tag" ||
            (effectiveConfig.dimension === "folder" && canEditDocs)) && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                addColumn(newColumn);
              }}
              className="flex items-center gap-1"
            >
              <Input
                value={newColumn}
                onChange={(e) => setNewColumn(e.target.value)}
                placeholder={
                  config.dimension === "tag" ? "add column…" : "new folder…"
                }
                list={config.dimension === "tag" ? "board-tag-values" : undefined}
                className="h-8 w-32"
                title={
                  config.dimension === "tag"
                    ? "Add a tag column — pick an existing tag or type a new value"
                    : "Add a folder column — drag a card into it to file the document there (nest with parent/child)"
                }
              />
              {config.dimension === "tag" && (
                <datalist id="board-tag-values">
                  {availableTagValues.map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              )}
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={!newColumn.trim()}
                title={
                  config.dimension === "tag" ? "Add column" : "Add folder column"
                }
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </form>
          )}
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
          </Button>
        </div>
      </NestPageHeader>

      {/* Saved boards as tabs — Linear's views / ClickUp's view bar. */}
      {boards && boards.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-border">
          {boards.map((b) => {
            const active = b.id === activeBoard?.id;
            const mine = !!me && b.created_by_email?.toLowerCase() === me;
            const canDelete = mine || isOwner || isAdmin;
            if (renaming?.id === b.id) {
              return (
                <Input
                  key={b.id}
                  autoFocus
                  value={renaming.value}
                  onChange={(e) => setRenaming({ id: b.id, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  onBlur={() => {
                    const v = renaming.value.trim();
                    setRenaming(null);
                    if (v && v !== b.name) void saveBoardMeta(b.id, { name: v });
                  }}
                  className="h-8 w-44 mb-1"
                />
              );
            }
            return (
              <div
                key={b.id}
                className={`flex items-center -mb-px border-b-2 ${
                  active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <button
                  type="button"
                  onClick={() => selectBoard(b.id)}
                  onDoubleClick={() => canEditDocs && setRenaming({ id: b.id, value: b.name })}
                  className="flex items-center gap-1.5 px-2.5 py-2 text-sm font-medium whitespace-nowrap"
                  title={
                    b.private
                      ? "Private — only you see this board"
                      : `Shared with everyone on this nest${b.created_by_email ? ` · made by ${b.created_by_email}` : ""}`
                  }
                >
                  {b.private && <Lock className="h-3 w-3" />}
                  {b.name}
                </button>
                {active && canEditDocs && (
                  <DropdownMenu>
                    <DropdownMenuTrigger className="rounded p-0.5 hover:bg-muted" title="Board options">
                      <ChevronDown className="h-3.5 w-3.5" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-52">
                      <DropdownMenuItem onSelect={() => setRenaming({ id: b.id, value: b.name })}>
                        Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void newBoard(b)}>Duplicate</DropdownMenuItem>
                      {mine && (
                        <DropdownMenuItem onSelect={() => void saveBoardMeta(b.id, { private: !b.private })}>
                          {b.private ? "Share with the nest" : "Make private"}
                        </DropdownMenuItem>
                      )}
                      {canDelete && boards.length > 1 && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => void removeBoard(b)}
                            className="text-destructive focus:text-destructive"
                          >
                            Delete board
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            );
          })}
          {canEditDocs && (
            <button
              type="button"
              onClick={() => void newBoard()}
              className="ml-1 flex items-center gap-1 px-2 py-2 text-sm text-muted-foreground hover:text-foreground whitespace-nowrap"
              title="New board"
            >
              <Plus className="h-3.5 w-3.5" /> New board
            </button>
          )}
        </div>
      )}

      <ul className="max-w-2xl list-disc space-y-1 pl-5 text-xs text-muted-foreground">
        {config.dimension === "status" ? (
          <>
            <li>
              Status is{" "}
              <span className="font-medium text-foreground">read-only</span>{" "}
              here — move a doc through review in the document view.
            </li>
            <li>
              Switch to{" "}
              <span className="font-medium text-foreground">Folder</span> for a
              draggable board.
            </li>
            <li>Drag a column header to reorder.</li>
          </>
        ) : config.dimension === "tag" ? (
          <>
            <li>
              Grouped by{" "}
              <span className="font-medium text-foreground">
                {config.tagNamespace?.trim()
                  ? `${config.tagNamespace.trim().split(":")[0]}:`
                  : "tag"}
              </span>
              {config.tagNamespace?.trim()
                ? " — only documents carrying one show up."
                : " — one column per tag, so a document with several tags appears in each."}
            </li>
            <li>
              {config.tagNamespace?.trim()
                ? "Clear the box to group by every tag."
                : "Type a namespace (e.g. stage) to group by stage: values only."}
            </li>
            <li>
              {canEditDocs ? (
                <>
                  <span className="font-medium text-foreground">
                    Drag a card
                  </span>{" "}
                  between columns to swap its tag; drag a header to reorder.
                </>
              ) : (
                <>
                  You have{" "}
                  <span className="font-medium text-foreground">read-only</span>{" "}
                  access, so cards can't be retagged. Drag a header to reorder.
                </>
              )}
            </li>
            <li>
              <span className="font-medium text-foreground">+</span> to add a
              column, <span className="font-medium text-foreground">×</span> to
              remove one.
            </li>
          </>
        ) : !canEditDocs ? (
          <>
            <li>
              You have{" "}
              <span className="font-medium text-foreground">read-only</span>{" "}
              access to this nest, so cards can't be moved.
            </li>
            <li>Ask the nest owner for write access to rearrange the board.</li>
          </>
        ) : columns.length < 2 ? (
          // One column means every document sits in Root, so there is nothing
          // to drag a card to yet — describe the step that unblocks that
          // instead of an interaction the board can't offer.
          <>
            <li>
              Every document is in{" "}
              <span className="font-medium text-foreground">Root</span>. Type a
              name in{" "}
              <span className="font-medium text-foreground">new folder</span>{" "}
              above to add a column.
            </li>
            <li>
              Then <span className="font-medium text-foreground">drag a card</span>{" "}
              into it — that files the document in the folder.
            </li>
          </>
        ) : (
          <>
            <li>
              <span className="font-medium text-foreground">Drag a card</span>{" "}
              between columns to move it to that folder.
            </li>
            <li>
              <span className="font-medium text-foreground">
                Drag a column header
              </span>{" "}
              to reorder.
            </li>
            <li>
              <span className="font-medium text-foreground">new folder</span>{" "}
              adds a column; it sticks once a card lands in it.
            </li>
          </>
        )}
      </ul>

      {/* Project-board bar: tasks-only toggle + the person quick-filter
          (Jira/ClickUp's avatar row — click faces to show only their cards). */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={!!config.tasksOnly}
            onChange={(e) => updateConfig({ tasksOnly: e.target.checked })}
            className="h-3.5 w-3.5"
          />
          Tasks only
        </label>
        {/* Tag filter: cards must carry every tag listed (saved per board). */}
        <div className="flex items-center gap-1">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          {(config.filterTags ?? []).map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary"
            >
              #{t}
              <button
                type="button"
                title={`Remove #${t}`}
                onClick={() =>
                  updateConfig({ filterTags: (config.filterTags ?? []).filter((x) => x !== t) })
                }
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <Input
            value={filterDraft}
            onChange={(e) => setFilterDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const v = filterDraft.trim().replace(/^#/, "");
              if (v && !(config.filterTags ?? []).includes(v)) {
                updateConfig({ filterTags: [...(config.filterTags ?? []), v] });
              }
              setFilterDraft("");
            }}
            placeholder="filter by tag…"
            className="h-7 w-32 text-xs"
          />
        </div>
        {(boardPeople.length > 0 || assigneeFilter.size > 0) && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Assignee</span>
            <div className="flex items-center -space-x-1">
              {boardPeople.map((email) => {
                const on = assigneeFilter.has(email);
                return (
                  <button
                    key={email}
                    type="button"
                    onClick={() => toggleAssignee(email)}
                    title={`${on ? "Showing" : "Show only"} ${email}${email === me ? " (me)" : ""}`}
                    className={`rounded-full transition ${
                      on
                        ? "ring-2 ring-primary ring-offset-1 ring-offset-background z-10"
                        : assigneeFilter.size > 0
                          ? "opacity-50 hover:opacity-100"
                          : "hover:z-10 hover:-translate-y-0.5"
                    }`}
                  >
                    <Avatar email={email} />
                  </button>
                );
              })}
            </div>
            {me && (
              <Button
                variant={assigneeFilter.has(me) && assigneeFilter.size === 1 ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() =>
                  setAssigneeFilter((prev) =>
                    prev.has(me) && prev.size === 1 ? new Set() : new Set([me]),
                  )
                }
              >
                Only my tasks
              </Button>
            )}
            <Button
              variant={assigneeFilter.has(UNASSIGNED) ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => toggleAssignee(UNASSIGNED)}
            >
              Unassigned
            </Button>
            {assigneeFilter.size > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={() => setAssigneeFilter(new Set())}
              >
                Clear
              </Button>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading board…
        </div>
      ) : error ? (
        <div className="text-sm text-destructive py-8">{error}</div>
      ) : columns.length === 0 ? (
        // The tag board starts with no columns by design, so "no documents"
        // would be a lie — the documents are there, the columns aren't yet.
        <div className="text-sm text-muted-foreground py-8">
          {effectiveConfig.dimension === "tag"
            ? "No tag columns yet — add one above to start sorting documents into it."
            : "No documents to show."}
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {columns.map((col) => {
            const cards = orderedByColumn[col.key] ?? [];
            const isDropTarget = dropCol === col.key;
            return (
              <div
                key={col.key}
                onDragOver={(e) => {
                  if (colDrag) {
                    e.preventDefault();
                    setColDropTarget(col.key);
                    return;
                  }
                  if (!draggable) return;
                  e.preventDefault();
                  setDropCol(col.key);
                }}
                onDragLeave={() => {
                  setDropCol((c) => (c === col.key ? null : c));
                  setColDropTarget((c) => (c === col.key ? null : c));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (colDrag) {
                    reorderColumns(colDrag, col.key);
                    setColDrag(null);
                    setColDropTarget(null);
                    return;
                  }
                  handleDrop(col.key);
                }}
                className={`flex-shrink-0 w-64 rounded-lg border bg-muted/30 flex flex-col max-h-[70vh] transition-colors ${
                  isDropTarget
                    ? "border-primary ring-1 ring-primary"
                    : "border-border"
                }`}
              >
                <div
                  className={`flex items-center justify-between gap-1 px-3 py-2 border-b border-border sticky top-0 ${
                    col.key !== UNCATEGORIZED
                      ? "cursor-grab active:cursor-grabbing"
                      : ""
                  } ${colDropTarget === col.key ? "bg-primary/10" : ""}`}
                  draggable={col.key !== UNCATEGORIZED}
                  onDragStart={(e) => {
                    if (col.key === UNCATEGORIZED) return;
                    setColDrag(col.key);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", `col:${col.key}`);
                  }}
                  onDragEnd={() => {
                    setColDrag(null);
                    setColDropTarget(null);
                  }}
                  title={col.title}
                >
                  <span
                    className={`min-w-0 text-sm font-medium truncate ${
                      capitalizeColumnHeader(effectiveConfig.dimension) ? "capitalize" : ""
                    } ${col.key === UNCATEGORIZED ? "text-muted-foreground" : ""}`}
                  >
                    {col.label}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {cards.length}
                    </span>
                    {/* Tag columns are removable outright. A folder column is
                        only removable while it is still empty — one added by
                        mistake, holding no documents to lose. */}
                    {col.key !== UNCATEGORIZED &&
                      (effectiveConfig.dimension === "tag" ||
                        (effectiveConfig.dimension === "folder" &&
                          cards.length === 0)) && (
                        <button
                          type="button"
                          onClick={() => hideColumn(col.key)}
                          className="text-muted-foreground/50 hover:text-foreground"
                          title={
                            effectiveConfig.dimension === "folder"
                              ? "Remove this empty column"
                              : // No Uncategorized catch-all on the tag board:
                                // the cards leave the board, tags untouched.
                                "Remove this column — its cards drop off the board; their tags aren't changed"
                          }
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {cards.map((n, i) => (
                    <div key={n.id}>
                    {dragId && dragId !== n.id && dropBefore?.col === col.key && dropBefore.before === n.id && (
                      <div className="mb-2 h-0.5 rounded bg-primary" />
                    )}
                    <div
                      onDragOver={(e) => {
                        if (!dragId || colDrag) return;
                        e.preventDefault();
                        // Top half → before this card; bottom half → before
                        // the next one (or the end of the column).
                        const r = e.currentTarget.getBoundingClientRect();
                        const before =
                          e.clientY < r.top + r.height / 2
                            ? n.id
                            : (cards[i + 1]?.id ?? null);
                        setDropBefore((p) =>
                          p?.col === col.key && p.before === before ? p : { col: col.key, before },
                        );
                      }}
                      draggable={draggable}
                      onDragStart={(e) => {
                        setDragId(n.id);
                        setDragFromCol(col.key);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", n.id);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setDragFromCol(null);
                        setDropCol(null);
                        setDropBefore(null);
                      }}
                      onClick={() => onOpenDocument(n.id)}
                      className={`group rounded-md border border-border bg-card px-2.5 py-2 text-sm cursor-pointer hover:border-primary/60 hover:shadow-sm transition ${
                        dragId === n.id ? "opacity-50" : ""
                      } ${busy ? "pointer-events-none" : ""}`}
                    >
                      {/* A sub-item names its parent, as ClickUp does —
                          otherwise it reads as an orphan in its column. */}
                      {n.parent && (
                        <div
                          className="mb-0.5 truncate pl-5 text-[10px] text-muted-foreground"
                          title={`Sub-item of ${nodes.find((x) => x.id === n.parent)?.title ?? n.parent}`}
                        >
                          ↳ {nodes.find((x) => x.id === n.parent)?.title ?? n.parent}
                        </div>
                      )}
                      <div className="flex items-start gap-1.5">
                        {draggable && (
                          <GripVertical className="h-3.5 w-3.5 mt-0.5 text-muted-foreground/40 group-hover:text-muted-foreground shrink-0" />
                        )}
                        <TypeIcon type={n.type} />
                        {/* min-w-0: a flex item defaults to min-width:auto, so
                            it refuses to shrink below its content and
                            break-words never fires — an unbroken title like
                            ENTERPRISE_LICENSING_IMPLEMENTATION widened the card
                            past the column instead of wrapping. */}
                        <span className="min-w-0 flex-1 leading-snug break-words">
                          {n.title}
                        </span>
                      </div>
                      {n.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5 pl-5">
                          {n.tags.slice(0, 4).map((t) => (
                            <span
                              key={t}
                              className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                      {/* Footer, Linear-style: priority · due · sub-items ·
                          last touched on the left, assignee on the right.
                          Empty fields show their control only on hover. */}
                      <div className="mt-1.5 flex items-center gap-1.5 pl-5 min-h-6">
                        <PriorityMenu
                          value={n.priority}
                          editable={canEditDocs}
                          onChange={(priority) => patchFields(n.id, { priority })}
                        />
                        <DueChip
                          due={n.due}
                          today={today}
                          editable={canEditDocs}
                          onChange={(due) => patchFields(n.id, { due })}
                        />
                        <SubItemChip
                          items={subItems.get(n.id) ?? []}
                          onOpen={onOpenDocument}
                        />
                        {(n.updated_at || n.created_at) && (
                          <span
                            className="text-[10px] text-muted-foreground/80 tabular-nums whitespace-pre"
                            title={timestampsTooltip(n, (iso) =>
                              new Date(iso).toLocaleString(),
                            )}
                          >
                            {timeAgo((n.updated_at || n.created_at)!)}
                          </span>
                        )}
                        <span className="ml-auto flex items-center gap-1">
                          {canEditDocs && newCardPlacement(col.key, effectiveConfig) && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setAddingIn({ col: col.key, parent: n.id });
                              }}
                              className="rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-foreground"
                              title="Add a sub-item"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <AssigneeMenu
                            assignee={n.assignee}
                            people={people}
                            me={me}
                            editable={canEditDocs}
                            onChange={(assignee, member) =>
                              assignee && member === false
                                ? setPendingShare({ id: n.id, email: assignee })
                                : patchFields(n.id, { assignee })
                            }
                          />
                        </span>
                      </div>
                    </div>
                    </div>
                  ))}
                  {dragId && dropBefore?.col === col.key && dropBefore.before === null && (
                    <div className="h-0.5 rounded bg-primary" />
                  )}
                  {cards.length === 0 && addingIn?.col !== col.key && (
                    <div className="text-xs text-muted-foreground/60 text-center py-6">
                      {draggable ? "Drop here" : "Empty"}
                    </div>
                  )}
                  {addingIn?.col === col.key && (
                    <AddCardComposer
                      key={addingIn.parent ?? "top"}
                      placeholder={
                        addingIn.parent
                          ? `Sub-item of “${nodes.find((x) => x.id === addingIn.parent)?.title ?? "task"}”…`
                          : "Task title…"
                      }
                      onSubmit={(title) => createCard(col.key, title, addingIn.parent)}
                      onClose={() => setAddingIn(null)}
                    />
                  )}
                </div>
                {/* Trello's "+ Add a card", pinned under the cards. */}
                {canEditDocs &&
                  newCardPlacement(col.key, effectiveConfig) &&
                  addingIn?.col !== col.key && (
                    <button
                      type="button"
                      onClick={() => setAddingIn({ col: col.key })}
                      className="flex items-center gap-1.5 px-3 py-2 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground rounded-b-lg border-t border-border"
                    >
                      <Plus className="h-3.5 w-3.5" /> Add task
                    </button>
                  )}
              </div>
            );
          })}
        </div>
      )}

      <GovernedMoveDialog
        open={!!pendingMove}
        title={pendingMove?.title ?? ""}
        onCancel={() => setPendingMove(null)}
        onConfirm={() => {
          const m = pendingMove;
          setPendingMove(null);
          if (m) void executeMove(m.id, m.plan, m.place);
        }}
      />
      <ShareAndAssignDialog
        email={pendingShare?.email ?? null}
        onCancel={() => setPendingShare(null)}
        onConfirm={async (permission) => {
          const s = pendingShare;
          setPendingShare(null);
          if (!s) return;
          try {
            await api.addCollaborator(nestId, { email: s.email, permission });
          } catch (e: any) {
            toast.error(e?.message || "Couldn't share the nest");
            return;
          }
          await patchFields(s.id, { assignee: s.email });
        }}
      />
    </div>
  );
}
