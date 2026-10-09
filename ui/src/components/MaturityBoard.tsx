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
  GripVertical,
  X,
  Plus,
  Lock,
  ChevronDown,
  Filter,
  CheckCircle2,
  LayoutGrid,
  List as ListIcon,
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
  buildLanes,
  laneFields,
  laneKeyOf,
  isFieldDimension,
  type BoardNode,
  type MovePlan,
  type SwimlaneKind,
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
  PRIORITY_LABELS,
  type Priority,
} from "../lib/board-tasks";
import { timeAgo } from "./nest/node-display";
import {
  AddCardComposer,
  AssigneeMenu,
  Avatar,
  DueChip,
  DeleteBoardDialog,
  GovernedMoveDialog,
  PriorityIcon,
  PriorityMenu,
  ShareAndAssignDialog,
  SubItemChip,
  TypeIcon,
} from "./board/CardParts";
import { BoardListView } from "./board/BoardListView";
import {
  resolveViewMode,
  viewStorageKey,
  withLayoutParam,
  type BoardViewMode,
} from "../lib/board-list";

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
      const dimension: DimensionKind = DIMENSION_KINDS.includes(p.dimension)
        ? p.dimension
        : "folder";
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

const DIMENSION_KINDS: readonly string[] = ["folder", "status", "tag", "assignee", "priority"];
const SWIMLANE_KINDS: readonly string[] = ["assignee", "priority", "parent"];

/** A saved board's config → the settings this component works on. Same
 *  normalisation as loadConfig, so a hand-edited blob can't break the page. */
function settingsFromBoard(cfg: Record<string, any>): BoardSettings {
  const dimension: DimensionKind = DIMENSION_KINDS.includes(cfg?.dimension)
    ? cfg.dimension
    : "folder";
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
    swimlane: SWIMLANE_KINDS.includes(cfg?.swimlane) ? cfg.swimlane : undefined,
    hideDoneAfterDays:
      typeof cfg?.hideDoneAfterDays === "number" ? cfg.hideDoneAfterDays : undefined,
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
          completed_at: n.completed_at,
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
    seeding.current = false;
    // A failed list leaves boards unset (browser layout), never [] — an empty
    // list would seed a duplicate "Board" on top of the real ones.
    api
      .listBoards(nestId)
      .then(({ boards }) => !cancelled && setBoards(boards))
      .catch(() => {});
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
  // One timer per board: switching boards mid-debounce must not cancel the
  // previous board's pending save.
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const persist = useCallback(
    (next: BoardSettings) => {
      saveConfig(nestId, next);
      const board = activeBoard;
      if (!board || !canEditDocs) return;
      clearTimeout(saveTimers.current.get(board.id));
      saveTimers.current.set(board.id, setTimeout(() => {
        saveTimers.current.delete(board.id);
        const { ranks: _ranks, ...config } = next;
        api
          .updateBoard(nestId, board.id, { config })
          .then(({ board: saved }) =>
            setBoards((bs) => bs?.map((b) => (b.id === saved.id ? saved : b)) ?? bs),
          )
          .catch((e: any) => toast.error(e?.message || "Couldn't save the board"));
      }, 400));
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

  // ── Board | List ──
  // Per person and per board (localStorage), with ?layout=list in the URL so
  // a link opens the same view. The URL wins over the remembered choice.
  const [viewMode, setViewModeState] = useState<BoardViewMode>(() =>
    resolveViewMode(window.location.search, null),
  );
  useEffect(() => {
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem(viewStorageKey(me, activeBoard?.id));
    } catch {
      /* storage disabled — default to the board */
    }
    setViewModeState(resolveViewMode(window.location.search, remembered));
  }, [me, activeBoard?.id]);
  const setViewMode = useCallback(
    (mode: BoardViewMode) => {
      setViewModeState(mode);
      try {
        localStorage.setItem(viewStorageKey(me, activeBoard?.id), mode);
      } catch {
        /* per-browser convenience only */
      }
      const search = withLayoutParam(window.location.search, mode);
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
    },
    [me, activeBoard?.id],
  );

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
          // Without the engine's task type "+ Add task" makes documents, so
          // Tasks only would hide every card added here.
          (!config.tasksOnly || !typeTaskEnabled || n.type === "task") &&
          matchesAssigneeFilter(n, assigneeFilter) &&
          // Linear's "completed issues: past week/month" display option.
          !(
            config.hideDoneAfterDays !== undefined &&
            n.completed_at &&
            Date.now() - Date.parse(n.completed_at) > config.hideDoneAfterDays * 86_400_000
          ) &&
          (config.filterTags ?? []).every((f) =>
            n.tags.some(
              (t) => t.replace(/^#/, "").toLowerCase() === f.toLowerCase(),
            ),
          ),
      ),
    [nodes, config.tasksOnly, typeTaskEnabled, config.filterTags, config.hideDoneAfterDays, assigneeFilter],
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
        // Roll back: never show an order that wasn't saved.
        setConfig((prev) => ({ ...prev, ranks: { ...(prev.ranks ?? {}), [key]: current } }));
        toast.error(e?.message || "Couldn't save the order");
      }
    },
    [activeBoard, config, orderedByColumn, nestId],
  );
  // Where a dragged card would land: before this card id, or (null) at the
  // bottom of the column.
  const [dropBefore, setDropBefore] = useState<{ cell: string; before: string | null } | null>(null);

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
  // People a card can land on as-is (an assignee column needs no share step).
  const members = useMemo(() => people.filter((p) => p.member !== false), [people]);

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

  /** Fields a card can be set to from the board. */
  type CardFields = {
    assignee?: string | null;
    due?: string | null;
    priority?: Priority | string | null;
    parent?: string | null;
  };

  // A write that would land as a draft on a governed document waits here for
  // the person to confirm it (GovernedMoveDialog).
  const [pending, setPending] = useState<{
    title: string;
    verb: "Moving" | "Changing";
    run: () => Promise<void>;
  } | null>(null);

  /** Set board fields on one card: optimistic, reverted if the server refuses. */
  const applyFields = useCallback(
    async (id: string, fields: CardFields) => {
      const prev = nodes.find((n) => n.id === id);
      if (!prev) return;
      const optimistic: BoardNode = { ...prev };
      for (const [k, v] of Object.entries(fields)) {
        (optimistic as any)[k] = v === null ? undefined : v;
      }
      setNodes((ns) => ns.map((n) => (n.id === id ? optimistic : n)));
      try {
        const res: any = await api.updateNode(nestId, id, fields as any);
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
                    parent: r.parent,
                    updated_at: r.updated_at ?? n.updated_at,
                  }
                : n,
            ),
          );
          if (r.status === "draft" && prev.status !== "draft") {
            toast("Saved as a draft — waiting for review");
          }
        }
        qc.invalidateQueries({ queryKey: reads.nodesMeta(nestId).queryKey });
      } catch (e: any) {
        setNodes((ns) => ns.map((n) => (n.id === id ? prev : n)));
        toast.error(e?.message || "Couldn't update the card");
      }
    },
    [nodes, nestId, qc],
  );

  /** Inline field edit from a card — asks first if it would need review. */
  const patchFields = useCallback(
    (id: string, fields: CardFields) => {
      const node = nodes.find((n) => n.id === id);
      if (node && moveNeedsReview(node, governance)) {
        setPending({ title: node.title, verb: "Changing", run: () => applyFields(id, fields) });
        return;
      }
      void applyFields(id, fields);
    },
    [nodes, governance, applyFields],
  );

  // ── "+ Add task" ──
  const [addingIn, setAddingIn] = useState<{ cell: string; col: string; lane?: string; parent?: string } | null>(null);
  const createCard = useCallback(
    async (colKey: string, title: string, parent?: string, laneKey?: string) => {
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
          // Added inside a swimlane: it belongs to that lane.
          ...(config.swimlane && laneKey !== undefined
            ? laneFields(config.swimlane as SwimlaneKind, laneKey)
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
    [effectiveConfig, config.filterTags, config.swimlane, nestId, typeTaskEnabled, assigneeFilter, qc, load],
  );

  /**
   * Run a drop: a column move (plan, or null for "same column") plus any lane
   * change (extra fields), as ONE document write where possible, then place
   * the card in the target column's order.
   */
  const executeMove = useCallback(
    async (
      id: string,
      plan: MovePlan | null,
      place: { col: string; before: string | null } | undefined,
      extra: CardFields = {},
    ) => {
      const hasExtra = Object.keys(extra).length > 0;
      setBusy(true);
      try {
        let rankId = id;
        if (plan?.kind === "move-folder") {
          const res: any = await api.moveNode(nestId, id, plan.folder);
          rankId = res?.node?.id ?? id;
          if (hasExtra) await api.updateNode(nestId, rankId, extra as any);
          toast.success("Moved");
        } else if (plan?.kind === "retag" || plan?.kind === "set-fields" || hasExtra) {
          // updateNode replaces the tag set, so a retag's full next set both
          // adds the target column's tag and drops the source column's.
          const body = {
            ...(plan?.kind === "retag" ? { tags: plan.tags } : {}),
            ...(plan?.kind === "set-fields" ? plan.fields : {}),
            ...extra,
          };
          const res: any = await api.updateNode(nestId, id, body as any);
          const st = res?.node?.status;
          const isTask = nodes.find((n) => n.id === id)?.type === "task";
          toast.success(
            st === "draft" || st === "pending_review"
              ? "Saved as a draft — waiting for review"
              : isTask || plan?.kind !== "retag"
                ? "Moved"
                : "Retagged",
          );
        }
        if (place && activeBoard) await rankCard(place.col, rankId, place.before);
        await load();
      } catch (e: any) {
        toast.error(e?.message || "Move failed");
      } finally {
        setBusy(false);
      }
    },
    [nestId, nodes, load, rankCard, activeBoard],
  );

  const handleDrop = useCallback(
    async (targetKey: string, laneKey?: string) => {
      const id = dragId;
      const from = dragFromCol;
      const cell = laneKey !== undefined ? `${laneKey}\u0001${targetKey}` : targetKey;
      const place =
        dropBefore && dropBefore.cell === cell
          ? { col: targetKey, before: dropBefore.before }
          : { col: targetKey, before: null };
      setDragId(null);
      setDragFromCol(null);
      setDropCol(null);
      setDropBefore(null);
      if (!id) return;
      const node = nodes.find((n) => n.id === id);
      if (!node) return;

      // Changing lane sets that lane's field (Linear: drag across swimlanes).
      const lane = config.swimlane as SwimlaneKind | undefined;
      const extra: CardFields =
        lane && laneKey !== undefined && laneKey !== laneKeyOf(node, lane) && laneKey !== node.id
          ? laneFields(lane, laneKey)
          : {};
      const laneChange = Object.keys(extra).length > 0;

      // Same column, same lane: a reorder. Rank lives on the board, so no
      // document is touched — works on every dimension, status included.
      if (from === targetKey && !laneChange) {
        if (activeBoard) await rankCard(targetKey, id, place.before);
        return;
      }

      let plan: MovePlan | null = null;
      if (from !== targetKey) {
        plan = planMove(node, targetKey, effectiveConfig, from ?? undefined);
        if (plan.kind === "unsupported") {
          // Silent for a pure no-op (same column); explain the real blockers.
          if (plan.reason !== "Already in this column.") toast(plan.reason);
          if (!laneChange) return;
          plan = null;
        }
      }
      // A document write on a governed doc lands as a draft that waits for
      // review — say so before doing it, not after. Tasks skip review, so
      // they never see this. A folder move alone doesn't draft.
      const writesDocument = laneChange || (plan !== null && plan.kind !== "move-folder");
      if (writesDocument && moveNeedsReview(node, governance)) {
        setPending({
          title: node.title,
          verb: "Moving",
          run: () => executeMove(id, plan, place, extra),
        });
        return;
      }
      await executeMove(id, plan, place, extra);
    },
    [dragId, dragFromCol, dropBefore, nodes, config.swimlane, effectiveConfig, governance, executeMove, activeBoard, rankCard],
  );

  // Every dimension is draggable now that a same-column drop reorders: on the
  // status board a cross-column drop still explains itself (planMove). Write
  // access is the other, independent condition.
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
          // A copy of a private board stays private.
          private: from?.private === true,
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
  const [pendingDelete, setPendingDelete] = useState<api.SavedBoard | null>(null);
  const removeBoard = useCallback(
    async (b: api.SavedBoard) => {
      // A pending layout save to a deleted board would only toast an error.
      clearTimeout(saveTimers.current.get(b.id));
      saveTimers.current.delete(b.id);
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
      if (effectiveConfig.dimension === "assignee") {
        const email = value.trim().toLowerCase();
        if (!members.some((p) => p.email.toLowerCase() === email)) {
          toast("Pick someone on this nest — share the nest with them first.");
          return;
        }
        updateLayout({
          columnOrder: [...new Set([...orderedKeys, email])],
          hiddenColumns: (effectiveConfig.hiddenColumns ?? []).filter((k) => k !== email),
        });
        setNewColumn("");
        return;
      }
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
      members,
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

  // ── Done columns, lanes, render helpers ──
  const doneTags = useMemo(
    () =>
      (((nestSettings.data as any)?.done_tags ?? ["done"]) as string[]).map((t) =>
        t.replace(/^#/, "").toLowerCase(),
      ),
    [nestSettings.data],
  );
  const canManageNest = isOwner || isAdmin;
  const toggleDoneColumn = useCallback(
    async (key: string) => {
      const k = key.toLowerCase();
      const next = doneTags.includes(k) ? doneTags.filter((t) => t !== k) : [...doneTags, k];
      try {
        await api.updateNestSettings(nestId, { done_tags: next } as any);
        await qc.invalidateQueries({ queryKey: reads.settings(nestId).queryKey });
        toast.success(
          doneTags.includes(k)
            ? `“${key}” no longer completes tasks`
            : `Tasks moved to “${key}” now count as done`,
        );
      } catch (e: any) {
        toast.error(e?.message || "Couldn't update done columns");
      }
    },
    [doneTags, nestId, qc],
  );

  const personLabel = useCallback(
    (email: string) =>
      people.find((p) => p.email.toLowerCase() === email.toLowerCase())?.name || email,
    [people],
  );
  // List view: a row's column(s) and their labels, and every tag in the nest
  // for the bulk tag box.
  const columnLabels = useMemo(() => new Map(columns.map((c) => [c.key, c.label])), [columns]);
  const listColumnsOf = useCallback(
    (n: BoardNode) => cardColumnKeys(n, effectiveConfig),
    [effectiveConfig],
  );
  const listColumnLabel = useCallback(
    (key: string) =>
      columnLabels.get(key) ??
      (key === UNCATEGORIZED
        ? effectiveConfig.dimension === "assignee"
          ? "Unassigned"
          : effectiveConfig.dimension === "priority"
            ? "No priority"
            : "Uncategorized"
        : key),
    [columnLabels, effectiveConfig.dimension],
  );
  const allTagValues = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) for (const t of n.tags) set.add(t.replace(/^#/, ""));
    return [...set].sort();
  }, [nodes]);

  const lanes = useMemo(() => {
    const lane = config.swimlane as SwimlaneKind | undefined;
    if (!lane) return null;
    const none = { assignee: "Unassigned", priority: "No priority", parent: "No parent" }[lane];
    return buildLanes(visibleNodes, lane, (key) =>
      key === UNCATEGORIZED
        ? none
        : lane === "assignee"
          ? personLabel(key)
          : lane === "priority"
            ? PRIORITY_LABELS[key as Priority] ?? key
            : (nodes.find((n) => n.id === key)?.title ?? key),
    );
  }, [config.swimlane, visibleNodes, nodes, personLabel]);
  const [collapsedLanes, setCollapsedLanes] = useState<Set<string>>(new Set());

  /** Drop handling for a column (no lane) or one lane's cell of it. */
  const cellDropHandlers = (col: { key: string }, laneKey?: string) => {
    const cell = laneKey !== undefined ? `${laneKey}\u0001${col.key}` : col.key;
    return {
      onDragOver: (e: React.DragEvent) => {
        if (colDrag) {
          e.preventDefault();
          setColDropTarget(col.key);
          return;
        }
        if (!draggable) return;
        e.preventDefault();
        setDropCol(cell);
      },
      onDragLeave: () => {
        setDropCol((c) => (c === cell ? null : c));
        setColDropTarget((c) => (c === col.key ? null : c));
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        if (colDrag) {
          reorderColumns(colDrag, col.key);
          setColDrag(null);
          setColDropTarget(null);
          return;
        }
        void handleDrop(col.key, laneKey);
      },
    };
  };

  const renderHeader = (col: { key: string; label: string; title: string }, count: number) => {
    const isDone =
      effectiveConfig.dimension === "tag" && doneTags.includes(col.key.toLowerCase());
    return (
      <div
        className={`group/header flex items-center justify-between gap-1 px-3 py-2 border-b border-border sticky top-0 ${
          col.key !== UNCATEGORIZED ? "cursor-grab active:cursor-grabbing" : ""
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
        <span className="flex min-w-0 items-center gap-1.5">
          {effectiveConfig.dimension === "assignee" && col.key !== UNCATEGORIZED && (
            <Avatar email={col.key} size="sm" />
          )}
          {effectiveConfig.dimension === "priority" && (
            <PriorityIcon priority={col.key === UNCATEGORIZED ? undefined : col.key} />
          )}
          {isDone && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />}
          <span
            className={`min-w-0 text-sm font-medium truncate ${
              capitalizeColumnHeader(effectiveConfig.dimension) ? "capitalize" : ""
            } ${col.key === UNCATEGORIZED ? "text-muted-foreground" : ""}`}
          >
            {effectiveConfig.dimension === "assignee" && col.key !== UNCATEGORIZED
              ? personLabel(col.key)
              : col.label}
          </span>
        </span>
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
          {/* Linear's "completed" status category, as a column flag. */}
          {effectiveConfig.dimension === "tag" && col.key !== UNCATEGORIZED && canManageNest && (
            <button
              type="button"
              onClick={() => void toggleDoneColumn(col.key)}
              className={`rounded p-0.5 hover:bg-muted ${
                isDone
                  ? "text-emerald-600"
                  : "text-muted-foreground/50 opacity-0 group-hover/header:opacity-100 hover:text-foreground"
              }`}
              title={
                isDone
                  ? "Done column — moving a task here completes it. Click to unmark."
                  : "Mark as a done column — tasks moved here count as completed"
              }
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
            </button>
          )}
          {/* Tag columns are removable outright. A folder column is only
              removable while it is still empty — one added by mistake. */}
          {col.key !== UNCATEGORIZED &&
            (effectiveConfig.dimension === "tag" ||
              (effectiveConfig.dimension === "folder" && count === 0)) && (
              <button
                type="button"
                onClick={() => hideColumn(col.key)}
                className="text-muted-foreground/50 hover:text-foreground"
                title={
                  effectiveConfig.dimension === "folder"
                    ? "Remove this empty column"
                    : "Remove this column — its cards drop off the board; their tags aren't changed"
                }
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
        </div>
      </div>
    );
  };

  const renderAddButton = (col: { key: string }, laneKey?: string) => {
    const cell = laneKey !== undefined ? `${laneKey}\u0001${col.key}` : col.key;
    if (!canEditDocs || !newCardPlacement(col.key, effectiveConfig) || addingIn?.cell === cell) {
      return null;
    }
    return (
      <button
        type="button"
        onClick={() => setAddingIn({ cell, col: col.key, lane: laneKey })}
        className={`flex items-center gap-1.5 px-3 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground rounded-b-lg ${
          laneKey !== undefined ? "py-1.5 opacity-60 hover:opacity-100" : "py-2 border-t border-border"
        }`}
      >
        <Plus className="h-3.5 w-3.5" /> Add task
      </button>
    );
  };

  const renderCards = (col: { key: string }, cards: BoardNode[], laneKey?: string) => {
    const cell = laneKey !== undefined ? `${laneKey}\u0001${col.key}` : col.key;
    return (
      <div className={`flex-1 overflow-y-auto p-2 space-y-2 ${laneKey !== undefined ? "min-h-12" : ""}`}>
        {cards.map((n, i) => {
          const kids = subItems.get(n.id) ?? [];
          const completed = !!n.completed_at;
          return (
            <div key={n.id}>
              {dragId && dragId !== n.id && dropBefore?.cell === cell && dropBefore.before === n.id && (
                <div className="mb-2 h-0.5 rounded bg-primary" />
              )}
              <div
                onDragOver={(e) => {
                  if (!dragId || colDrag) return;
                  e.preventDefault();
                  // Top half → before this card; bottom half → before the
                  // next one (or the end of the column).
                  const r = e.currentTarget.getBoundingClientRect();
                  const before =
                    e.clientY < r.top + r.height / 2 ? n.id : (cards[i + 1]?.id ?? null);
                  setDropBefore((p) =>
                    p?.cell === cell && p.before === before ? p : { cell, before },
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
                {/* A sub-item names its parent, as ClickUp does. Redundant
                    inside its parent's own swimlane, so hidden there. */}
                {n.parent && !(config.swimlane === "parent" && laneKey === n.parent) && (
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
                  {completed ? (
                    <CheckCircle2
                      className="h-3.5 w-3.5 mt-0.5 shrink-0 text-emerald-600"
                      aria-label="Completed"
                    />
                  ) : (
                    <TypeIcon type={n.type} />
                  )}
                  {/* min-w-0: lets an unbroken title wrap instead of widening
                      the card past the column. */}
                  <span
                    className={`min-w-0 flex-1 leading-snug break-words ${completed ? "text-muted-foreground" : ""}`}
                  >
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
                {/* Footer, Linear-style: priority · due · sub-items · last
                    touched on the left, assignee on the right. */}
                <div className="mt-1.5 flex items-center gap-1.5 pl-5 min-h-6">
                  <PriorityMenu
                    value={n.priority}
                    editable={canEditDocs}
                    onChange={(priority) => patchFields(n.id, { priority })}
                  />
                  {!completed && (
                    <DueChip
                      due={n.due}
                      today={today}
                      editable={canEditDocs}
                      onChange={(due) => patchFields(n.id, { due })}
                    />
                  )}
                  <SubItemChip
                    items={kids}
                    done={kids.filter((k) => !!k.completed_at).length}
                    onOpen={onOpenDocument}
                  />
                  {(n.updated_at || n.created_at) && (
                    <span
                      className="text-[10px] text-muted-foreground/80 tabular-nums whitespace-pre"
                      title={timestampsTooltip(n, (iso) => new Date(iso).toLocaleString())}
                    >
                      {completed && n.completed_at
                        ? `done ${timeAgo(n.completed_at)}`
                        : timeAgo((n.updated_at || n.created_at)!)}
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1">
                    {canEditDocs && newCardPlacement(col.key, effectiveConfig) && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setAddingIn({ cell, col: col.key, lane: laneKey, parent: n.id });
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
          );
        })}
        {dragId && dropBefore?.cell === cell && dropBefore.before === null && (
          <div className="h-0.5 rounded bg-primary" />
        )}
        {cards.length === 0 && addingIn?.cell !== cell && laneKey === undefined && (
          <div className="text-xs text-muted-foreground/60 text-center py-6">
            {draggable ? "Drop here" : "Empty"}
          </div>
        )}
        {addingIn?.cell === cell && (
          <AddCardComposer
            key={addingIn.parent ?? "top"}
            placeholder={
              addingIn.parent
                ? `Sub-item of “${nodes.find((x) => x.id === addingIn.parent)?.title ?? "task"}”…`
                : "Task title…"
            }
            onSubmit={(title) => createCard(col.key, title, addingIn.parent, addingIn.lane)}
            onClose={() => setAddingIn(null)}
          />
        )}
      </div>
    );
  };

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
            <option value="assignee">Assignee</option>
            <option value="priority">Priority</option>
          </select>
          {/* Swimlanes: sub-group the columns into rows (Linear/Jira). The
              list has no lanes — its sections are the columns. */}
          {viewMode === "board" && (<>
          <label className="text-sm text-muted-foreground">Lanes</label>
          <select
            value={config.swimlane ?? ""}
            onChange={(e) =>
              updateConfig({ swimlane: (e.target.value || undefined) as SwimlaneKind | undefined })
            }
            className="h-8 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">None</option>
            {config.dimension !== "assignee" && <option value="assignee">Assignee</option>}
            {config.dimension !== "priority" && <option value="priority">Priority</option>}
            <option value="parent">Parent</option>
          </select>
          </>)}
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
            ((effectiveConfig.dimension === "folder" ||
              effectiveConfig.dimension === "assignee") &&
              canEditDocs)) && (
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
                  config.dimension === "tag"
                    ? "add column…"
                    : config.dimension === "assignee"
                      ? "add person…"
                      : "new folder…"
                }
                list={
                  config.dimension === "tag"
                    ? "board-tag-values"
                    : config.dimension === "assignee"
                      ? "board-people"
                      : undefined
                }
                className="h-8 w-32"
                title={
                  config.dimension === "tag"
                    ? "Add a tag column — pick an existing tag or type a new value"
                    : "Add a folder column — drag a card into it to file the document there (nest with parent/child)"
                }
              />
              {config.dimension === "assignee" && (
                <datalist id="board-people">
                  {members.map((p) => (
                    <option key={p.email} value={p.email}>
                      {p.name ?? p.email}
                    </option>
                  ))}
                </datalist>
              )}
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
                            onSelect={() => setPendingDelete(b)}
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

      {viewMode === "board" && (
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
        ) : isFieldDimension(config.dimension) ? (
          <>
            <li>
              One column per{" "}
              <span className="font-medium text-foreground">
                {config.dimension === "assignee" ? "person" : "priority"}
              </span>
              {canEditDocs
                ? config.dimension === "assignee"
                  ? " — drag a card across to reassign it."
                  : " — drag a card across to change its priority."
                : "."}
            </li>
            {config.dimension === "assignee" && canEditDocs && (
              <li>Add a column for someone who has nothing assigned yet, above.</li>
            )}
            <li>Drag a card up or down to rank it; pick Lanes to split rows.</li>
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
      )}

      {/* Project-board bar: tasks-only toggle + the person quick-filter
          (Jira/ClickUp's avatar row — click faces to show only their cards). */}
      <div className="flex flex-wrap items-center gap-3">
        {typeTaskEnabled && (
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={!!config.tasksOnly}
              onChange={(e) => updateConfig({ tasksOnly: e.target.checked })}
              className="h-3.5 w-3.5"
            />
            Tasks only
          </label>
        )}
        <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
          Completed
          <select
            value={config.hideDoneAfterDays ?? ""}
            onChange={(e) =>
              updateConfig({
                hideDoneAfterDays: e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
            className="h-7 rounded-md border border-input bg-background px-1.5 text-xs"
          >
            <option value="">All</option>
            <option value="7">Past week</option>
            <option value="30">Past month</option>
            <option value="0">Hide</option>
          </select>
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
        {/* Board | List — the same slice, laid out as cards or rows. */}
        <div
          role="radiogroup"
          aria-label="Layout"
          className="ml-auto inline-flex items-center rounded-md border border-border bg-muted/40 p-0.5"
        >
          {(
            [
              ["board", "Board", LayoutGrid],
              ["list", "List", ListIcon],
            ] as const
          ).map(([mode, label, Icon]) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={viewMode === mode}
              onClick={() => setViewMode(mode)}
              className={`inline-flex h-6 items-center gap-1.5 rounded px-2 text-xs font-medium transition-colors ${
                viewMode === mode
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
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
      ) : viewMode === "list" ? (
        <BoardListView
          nestId={nestId}
          boardId={activeBoard?.id}
          dimension={effectiveConfig.dimension}
          sections={columns.map((c) => ({
            key: c.key,
            label: c.label,
            nodes: orderedByColumn[c.key] ?? [],
          }))}
          boardColumns={columns}
          allNodes={nodes}
          columnsOf={listColumnsOf}
          columnLabel={listColumnLabel}
          people={people}
          me={me}
          personLabel={personLabel}
          canEdit={canEditDocs}
          governance={governance}
          doneTags={doneTags}
          tagSuggestions={allTagValues}
          onOpen={onOpenDocument}
          onChanged={load}
        />
      ) : (
        lanes ? (
          // Swimlanes: column headers once, then one row of cells per lane.
          <div className="overflow-x-auto pb-4">
            <div className="inline-flex min-w-full flex-col gap-2">
              <div className="flex gap-3">
                {columns.map((col) => (
                  <div
                    key={col.key}
                    {...cellDropHandlers(col)}
                    className="w-64 flex-shrink-0 rounded-lg border border-border bg-muted/30"
                  >
                    {renderHeader(col, (orderedByColumn[col.key] ?? []).length)}
                  </div>
                ))}
              </div>
              {lanes.map((lane) => {
                const collapsed = collapsedLanes.has(lane.key);
                return (
                  <div key={lane.key}>
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsedLanes((prev) => {
                          const next = new Set(prev);
                          if (next.has(lane.key)) next.delete(lane.key);
                          else next.add(lane.key);
                          return next;
                        })
                      }
                      className="sticky left-0 flex items-center gap-1.5 py-1.5 text-sm font-medium hover:text-foreground"
                    >
                      <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform ${collapsed ? "-rotate-90" : ""}`}
                      />
                      {config.swimlane === "assignee" && lane.key !== UNCATEGORIZED && (
                        <Avatar email={lane.key} size="sm" />
                      )}
                      {config.swimlane === "priority" && <PriorityIcon priority={lane.key === UNCATEGORIZED ? undefined : lane.key} />}
                      <span className={lane.key === UNCATEGORIZED ? "text-muted-foreground" : ""}>
                        {lane.label}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">{lane.nodes.length}</span>
                    </button>
                    {!collapsed && (
                      <div className="flex gap-3">
                        {columns.map((col) => {
                          const cards = (orderedByColumn[col.key] ?? []).filter(
                            (n) => laneKeyOf(n, config.swimlane as SwimlaneKind) === lane.key,
                          );
                          const cell = `${lane.key}\u0001${col.key}`;
                          return (
                            <div
                              key={col.key}
                              {...cellDropHandlers(col, lane.key)}
                              className={`flex w-64 flex-shrink-0 flex-col rounded-lg border bg-muted/20 transition-colors ${
                                dropCol === cell ? "border-primary ring-1 ring-primary" : "border-border"
                              }`}
                            >
                              {renderCards(col, cards, lane.key)}
                              {renderAddButton(col, lane.key)}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {columns.map((col) => {
            const cards = orderedByColumn[col.key] ?? [];
            return (
              <div
                key={col.key}
                {...cellDropHandlers(col)}
                className={`flex-shrink-0 w-64 rounded-lg border bg-muted/30 flex flex-col max-h-[70vh] transition-colors ${
                  dropCol === col.key ? "border-primary ring-1 ring-primary" : "border-border"
                }`}
              >
                {renderHeader(col, cards.length)}
                {renderCards(col, cards)}
                {renderAddButton(col)}
              </div>
            );
          })}
        </div>
        )
      )}

      <GovernedMoveDialog
        open={!!pending}
        title={pending?.title ?? ""}
        verb={pending?.verb ?? "Moving"}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const m = pending;
          setPending(null);
          if (m) void m.run();
        }}
      />
      <DeleteBoardDialog
        name={pendingDelete?.name ?? null}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const b = pendingDelete;
          setPendingDelete(null);
          if (b) void removeBoard(b);
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
