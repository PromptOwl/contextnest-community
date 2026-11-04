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
import { ticketOf, visibleTags } from "../lib/ticket";
import { stageDot, universalTags } from "../lib/tones";
import { nestPath } from "../lib/nest-url";
import { levelLabel, levelsOrDefault, PriorityLevelsContext, usePriorityLevels } from "../lib/priorities";
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
  Search,
  HelpCircle,
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
  isColumnPattern,
  keepPatterns,
  tagSuggestions,
  tagNamespaces,
  withoutPattern,
  newCardPlacement,
  planMove,
  optimisticMove,
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
  namespaceKey,
} from "../lib/board-dimensions";
import {
  UNASSIGNED,
  assigneesOnBoard,
  localToday,
  matchesAssigneeFilter,
  matchesBlockedFilter,
  matchesTitleFilter,
  moveNeedsReview,
  openBlockers,
  subItemsByParent,
  timestampsTooltip,
  PRIORITY_LABELS,
  type Priority,
} from "../lib/board-tasks";
import { timeAgo } from "./nest/node-display";
import {
  AssigneeMenu,
  TicketChip,
  TagPill,
  Avatar,
  BlockedBadge,
  DueChip,
  DeleteBoardDialog,
  GovernedMoveDialog,
  PriorityIcon,
  PriorityMenu,
  ShareAndAssignDialog,
  SubItemChip,
  TypeIcon,
} from "./board/CardParts";
import { CreateTaskDialog, type NewTask } from "./board/CreateTaskDialog";
import { BoardListView } from "./board/BoardListView";
import { TagColumnInput } from "./board/TagColumnInput";
import { TagGroupInput } from "./board/TagGroupInput";
import {
  resolveViewMode,
  viewStorageKey,
  withLayoutParam,
  type BoardViewMode,
} from "../lib/board-list";
import { FieldChip, FieldFilterMenu } from "./fields/FieldParts";
import {
  applicableFields,
  fieldKeyLabel,
  fieldValueForMove,
  isGroupable,
  matchesFieldFilters,
  optionDot,
} from "../lib/custom-fields";

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
        ...fieldSettings(p),
      };
    }
  } catch {
    // ignore corrupt storage — fall through to default
  }
  // Empty namespace = group by every tag, which is the only setting that shows
  // real columns on a vault of flat (un-namespaced) tags.
  return { dimension: "folder", tagNamespace: "", layouts: {} };
}

const DIMENSION_KINDS: readonly string[] = ["folder", "status", "tag", "assignee", "priority", "field"];
const SWIMLANE_KINDS: readonly string[] = ["assignee", "priority", "parent", "field"];

/** The custom-field parts of a stored board config, shape-checked. */
function fieldSettings(cfg: Record<string, any>): Pick<
  BoardSettings,
  "fieldKey" | "swimlaneField" | "filterFields"
> {
  const key = (v: unknown) => (typeof v === "string" && /^[a-z][a-z0-9_]*$/.test(v) ? v : undefined);
  const filters: Record<string, string> = {};
  if (cfg?.filterFields && typeof cfg.filterFields === "object") {
    for (const [k, v] of Object.entries(cfg.filterFields)) {
      if (key(k) && typeof v === "string") filters[k] = v;
    }
  }
  return {
    fieldKey: key(cfg?.fieldKey),
    swimlaneField: key(cfg?.swimlaneField),
    filterFields: Object.keys(filters).length > 0 ? filters : undefined,
  };
}

/** "field:severity" ↔ { dimension: "field", fieldKey: "severity" } — the
 *  value the Columns-by / Lanes selects carry for a custom field. */
const FIELD_PREFIX = "field:";
/** The toolbar is two capsules (Columns, Lanes). Each holds a muted label and
 *  borderless selects with one custom chevron, so it reads as a single setting
 *  rather than loose boxes. */
const CAPSULE =
  "flex h-8 items-center rounded-md border border-input bg-background text-sm focus-within:ring-2 focus-within:ring-ring";
const CAPSULE_LABEL = "pl-2.5 pr-0.5 text-muted-foreground";
/** A dismissible callout in the brand tint — for one-off nudges that shouldn't
 *  sit in the toolbar. */
function HintBanner({ testId, onDismiss, children }: { testId: string; onDismiss: () => void; children: React.ReactNode }) {
  return (
    <div
      data-testid={testId}
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-foreground/80"
    >
      {children}
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={onDismiss}
        className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-primary/10 hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

const bareTag = (t: string) => t.replace(/^#/, "").trim().toLowerCase();
const BARE_SELECT =
  "h-8 cursor-pointer appearance-none bg-transparent pl-1.5 pr-6 text-sm focus:outline-none";
const CHEVRON =
  "pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-50";

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
    ...fieldSettings(cfg),
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

function MaturityBoardInner({
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
  const priorityLevels = usePriorityLevels();
  // The nest's workflow order for its stage group, so a Stage board opens as
  // backlog → … → done instead of alphabetically.
  const stageOrder = useMemo(() => {
    const r = (nestSettings.data as any)?.task_rules as import("../lib/api").TaskRules | undefined;
    const ns = namespaceKey(r?.default_stage_tag ?? r?.exclusive_namespaces?.[0]);
    return ns && r?.stage_order?.length ? { namespace: ns, order: r.stage_order } : undefined;
  }, [nestSettings.data]);
  // Surfaces for the new-task dialog: name plus the tag it adds (its first).
  const surfaceChoices = useMemo(() => {
    const r = (nestSettings.data as any)?.task_rules as import("../lib/api").TaskRules | undefined;
    return (r?.surfaces ?? []).map((sf) => ({ name: sf.name, tag: sf.tags[0]! })).filter((x) => x.tag);
  }, [nestSettings.data]);
  const defaultSurfaceTag = useMemo(() => {
    const r = (nestSettings.data as any)?.task_rules as import("../lib/api").TaskRules | undefined;
    return r?.surfaces?.find((sf) => sf.name === r.default_surface)?.tags[0];
  }, [nestSettings.data]);
  // The nest's one-per-task tag groups (task_rules.exclusive_namespaces), e.g.
  // `stage` — offered as ready-made "Columns by" choices so a task board is one
  // click, and never confused with the document review status.
  const taskGroups = useMemo(
    () => ((nestSettings.data as any)?.task_rules?.exclusive_namespaces ?? []) as string[],
    [nestSettings.data],
  );
  // Custom field definitions: card chips, field columns/lanes, field filters.
  const fieldsQuery = useQuery(reads.fields(nestId));
  const fieldDefs = useMemo(() => fieldsQuery.data?.fields ?? [], [fieldsQuery.data]);
  // Time in status ticks on the cards without refetching.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!fieldDefs.some((d) => d.type === "time_in_status")) return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [fieldDefs]);
  const [nodes, setNodes] = useState<BoardNode[]>([]);
  // Numbering is off and the board holds tasks: admins get a pointer to the
  // switch instead of cards that silently lack a number.
  // Numbering is on (the default) but some tasks predate it: admins can number
  // them in one click instead of hunting for the backfill.
  const unnumbered =
    (isAdmin || isOwner) && (nestSettings.data as any)?.task_rules?.ticket_numbering === true
      ? nodes.filter((n) => n.type === "task" && !ticketOf(n.tags)).length
      : 0;
  const [numbering, setNumbering] = useState(false);
  const numberThem = async () => {
    setNumbering(true);
    try {
      let total = 0;
      for (let i = 0; i < 20; i++) {
        const r = await api.backfillTickets(nestId, {});
        total += r.numbered;
        if (r.remaining === 0 || r.numbered === 0) break;
      }
      toast.success(`${total} task${total === 1 ? "" : "s"} numbered`);
      qc.invalidateQueries({ queryKey: reads.nodesMeta(nestId).queryKey });
      void load({ silent: true });
    } catch (e: any) {
      toast.error(e?.message || "Couldn't number the tasks");
    } finally {
      setNumbering(false);
    }
  };
  const numberingOffHint =
    (isAdmin || isOwner) &&
    !!nestSettings.data &&
    (nestSettings.data as any)?.task_rules?.ticket_numbering !== true &&
    nodes.some((n) => n.type === "task");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<BoardSettings>(() => loadConfig(nestId));
  const [dragId, setDragId] = useState<string | null>(null);
  // The column a card was dragged out of — needed on the tag board to know
  // which tag to drop when retagging a multi-tagged card.
  const [dragFromCol, setDragFromCol] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  // The board scroller ends at the window's bottom edge, so its sideways
  // scrollbar is always in view, not at the page bottom (CU-wdqcq0656t).
  // Re-measured whenever the page above it changes height.
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [boardH, setBoardH] = useState<number | null>(null);
  useEffect(() => {
    const fit = () => {
      const el = boardRef.current;
      if (el) setBoardH(Math.max(320, Math.floor(window.innerHeight - el.getBoundingClientRect().top - window.scrollY - 8)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(document.body);
    window.addEventListener("resize", fit);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);
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

  /** Read the nest's nodes. `silent` keeps the current view on screen (the
   *  list's sort, sections and scroll survive a bulk edit's re-read). */
  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true);
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
          open_blockers: n.open_blockers,
          fields: n.fields,
          status_since: n.status_since,
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

  // Card chips leave out the ticket number (shown as the ID) and, on a tag
  // board, the tags of the grouped namespace — that is the column, so
  // repeating "#stage:backlog" on every card in Backlog is noise.
  const hideNs = config.dimension === "tag" ? namespaceKey(config.tagNamespace) : "";
  // A card also leaves out tags nearly every card carries (#projects,
  // #engineering), judged over the whole board so a filter doesn't change it,
  // and a flat tag that a namespaced one already says (#community beside
  // #surface:community). Namespaced tags lead, as coloured pills.
  const universal = useMemo(() => {
    const tasks = nodes.filter((n) => n.type === "task");
    return universalTags((tasks.length >= 5 ? tasks : nodes).map((n) => n.tags));
  }, [nodes]);
  const surfaceName = useMemo(
    () => new Map(surfaceChoices.map((s) => [bareTag(s.tag), s.name] as const)),
    [surfaceChoices],
  );
  const cardTags = (tags: string[]) => {
    const kept = visibleTags(tags).filter(
      (t) =>
        !universal.has(bareTag(t)) &&
        (!hideNs || namespaceKey(t.includes(":") ? t : "") !== hideNs),
    );
    const spoken = new Set(
      kept.filter((t) => t.includes(":")).map((t) => bareTag(t).split(":").slice(1).join(":")),
    );
    return [
      ...kept.filter((t) => t.includes(":")),
      ...kept.filter((t) => !t.includes(":") && !spoken.has(bareTag(t))),
    ];
  };
  const effectiveConfig = useMemo(() => resolveConfig(config, fieldDefs, priorityLevels, stageOrder), [config, fieldDefs, priorityLevels, stageOrder]);
  const laneField = useMemo(
    () =>
      config.swimlane === "field"
        ? fieldDefs.find((d) => d.key === config.swimlaneField)
        : undefined,
    [config.swimlane, config.swimlaneField, fieldDefs],
  );
  // Fields a board can group or filter by, among those its cards can carry.
  const groupableFields = useMemo(
    () =>
      fieldDefs.filter(
        (d) =>
          isGroupable(d) &&
          (!config.tasksOnly || !typeTaskEnabled || applicableFields([d], "task").length > 0),
      ),
    [fieldDefs, config.tasksOnly, typeTaskEnabled],
  );

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
  // "Hide blocked" — a glance, like the assignee filter, not a saved setting.
  const [hideBlocked, setHideBlocked] = useState(false);
  // The filter box: filters titles as you type; Enter turns it into a tag chip.
  const [filterDraft, setFilterDraft] = useState("");
  const blockedCount = useMemo(
    () => nodes.filter((n) => openBlockers(n) > 0).length,
    [nodes],
  );
  const subItems = useMemo(() => subItemsByParent(nodes), [nodes]);

  const visibleNodes = useMemo(
    () =>
      nodes.filter(
        (n) =>
          // Without the engine's task type "+ Add task" makes documents, so
          // Tasks only would hide every card added here.
          (!config.tasksOnly || !typeTaskEnabled || n.type === "task") &&
          matchesAssigneeFilter(n, assigneeFilter) &&
          matchesBlockedFilter(n, hideBlocked) &&
          matchesTitleFilter(n, filterDraft) &&
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
          ) &&
          matchesFieldFilters(n, config.filterFields, fieldDefs),
      ),
    [nodes, config.tasksOnly, typeTaskEnabled, config.filterTags, config.filterFields, fieldDefs, config.hideDoneAfterDays, assigneeFilter, hideBlocked, filterDraft],
  );

  // Folders with nothing in them — the sidebar's census read (shared cache), so
  // the folder board lists the same folders the tree does.
  const census = useQuery({
    ...reads.census(nestId),
    enabled: effectiveConfig.dimension === "folder",
  });
  const emptyFolders = useMemo(
    () => (census.data?.census.folders ?? []).filter((f) => !f.total).map((f) => f.path),
    [census.data],
  );
  const { columns, byColumn } = useMemo(
    () => groupByColumn(visibleNodes, effectiveConfig, emptyFolders),
    [visibleNodes, effectiveConfig, emptyFolders],
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
    /** Custom field values — merged server-side, so only changed keys. */
    fields?: Record<string, unknown>;
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
        if (k === "fields") continue;
        (optimistic as any)[k] = v === null ? undefined : v;
      }
      if (fields.fields) {
        const next = { ...(prev.fields ?? {}) };
        for (const [k, v] of Object.entries(fields.fields)) {
          if (v === null) delete next[k];
          else next[k] = v;
        }
        optimistic.fields = next;
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
                    fields: r.fields,
                    status_since: r.status_since ?? n.status_since,
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
    async (colKey: string, task: NewTask, parent?: string, laneKey?: string) => {
      const placement = newCardPlacement(colKey, effectiveConfig);
      if (!placement) return;
      const { content, surfaceTag, ...details } = task;
      try {
        const payload: Record<string, any> = {
          // The create route requires a body; a task's notes may start empty.
          content: content.trim() ? content : "\n",
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
            ? laneFields(config.swimlane as SwimlaneKind, laneKey, laneField)
            : {}),
          // Custom fields from the column, the lane and the board's field
          // filters, merged — or the new card would land off the board.
          ...(() => {
            const merged: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(config.filterFields ?? {})) {
              const def = fieldDefs.find((d) => d.key === k);
              if (!def || v === "none") continue;
              if (def.type === "checkbox") merged[k] = v === "true";
              else if (def.type === "multi_select") merged[k] = [v];
              else merged[k] = v;
            }
            Object.assign(merged, placement.fields ?? {});
            if (config.swimlane === "field" && laneKey !== undefined) {
              Object.assign(merged, laneFields("field", laneKey, laneField).fields ?? {});
            }
            return Object.keys(merged).length > 0 ? { fields: merged } : {};
          })(),
          ...(parent ? { parent } : {}),
          // Filtering by one person and adding a card hands it to them —
          // otherwise it would vanish from the filtered board on creation.
          ...(assigneeFilter.size === 1 && !assigneeFilter.has(UNASSIGNED)
            ? { assignee: [...assigneeFilter][0] }
            : {}),
          // Title plus what the dialog set — a picked assignee/priority wins.
          ...details,
        };
        // The surface picked in the dialog is an ordinary tag, added to whatever
        // the column and filters already put on the card.
        if (surfaceTag) payload.tags = [...new Set([...(payload.tags ?? []), `#${surfaceTag}`])];
        const res = await api.createNode(nestId, payload as any);
        qc.invalidateQueries({ queryKey: reads.nodesMeta(nestId).queryKey });
        // The caller opens the new task — refresh the board behind it, don't wait.
        void load({ silent: true });
        return res?.node?.id as string | undefined;
      } catch (e: any) {
        toast.error(e?.message || "Couldn't add the task");
        throw e;
      }
    },
    [effectiveConfig, config.filterTags, config.filterFields, config.swimlane, laneField, fieldDefs, nestId, typeTaskEnabled, assigneeFilter, qc, load],
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
      // Move the card now; put it back if the server refuses.
      const prev = nodes.find((n) => n.id === id);
      const moved = prev && (plan || hasExtra) ? optimisticMove(prev, plan, extra) : null;
      if (moved) setNodes((ns) => ns.map((n) => (n.id === id ? moved : n)));
      setBusy(true);
      try {
        let rankId = id;
        if (plan?.kind === "move-folder") {
          const res: any = await api.moveNode(nestId, id, plan.folder);
          rankId = res?.node?.id ?? id;
          if (hasExtra) await api.updateNode(nestId, rankId, extra as any);
          toast.success("Moved");
        } else if (
          plan?.kind === "retag" ||
          plan?.kind === "set-fields" ||
          plan?.kind === "set-custom" ||
          hasExtra
        ) {
          // updateNode replaces the tag set, so a retag's full next set both
          // adds the target column's tag and drops the source column's.
          const customFields = {
            ...(plan?.kind === "set-custom" ? plan.fields : {}),
            ...(extra.fields ?? {}),
          };
          const body = {
            ...(plan?.kind === "retag" ? { tags: plan.tags } : {}),
            ...(plan?.kind === "set-fields" ? plan.fields : {}),
            ...extra,
            ...(Object.keys(customFields).length > 0 ? { fields: customFields } : {}),
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
        // Server truth (a folder move's real id, computed fields) — no spinner.
        void load({ silent: true });
      } catch (e: any) {
        if (prev && moved) setNodes((ns) => ns.map((n) => (n.id === moved.id ? prev : n)));
        // Half a move may have landed (folder moved, lane field refused) — resync.
        void load({ silent: true });
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
      const currentLane = lane ? laneKeyOf(node, lane, laneField) : undefined;
      const extra: CardFields =
        lane && laneKey !== undefined && laneKey !== currentLane && laneKey !== node.id
          ? lane === "field" && laneField
            ? laneField.type === "time_in_status"
              ? {}
              : {
                  // Keep a multi-select card's other options; swap the lane's.
                  fields: {
                    [laneField.key]: fieldValueForMove(
                      laneField,
                      node.fields?.[laneField.key],
                      laneKey,
                      currentLane,
                    ),
                  },
                }
            : laneFields(lane, laneKey)
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
    [dragId, dragFromCol, dropBefore, nodes, config.swimlane, laneField, effectiveConfig, governance, executeMove, activeBoard, rankCard],
  );

  // Every dimension is draggable now that a same-column drop reorders: on the
  // status board a cross-column drop still explains itself (planMove). Write
  // access is the other, independent condition.
  const draggable = canEditDocs;

  // ── Board tabs: create / rename / duplicate / share / delete ──
  const [renaming, setRenaming] = useState<{ id: string; value: string; fresh?: boolean } | null>(null);
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
        // A duplicate keeps its "… copy" name; a brand-new board needs one.
        setRenaming({ id: board.id, value: board.name, fresh: !from });
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
  // The tag board's add-column box stays a "+ Column" button until needed.
  const [addingColumn, setAddingColumn] = useState(false);
  // The how-to lines stay out of the way until asked for (the "?" button).
  const [showHelp, setShowHelp] = useState(false);
  const hintKey = `board-hint:${nestId}`;
  const [hintGone, setHintGone] = useState(() => {
    try {
      return localStorage.getItem(hintKey) === "1";
    } catch {
      return false;
    }
  });
  const dismissHint = () => {
    setHintGone(true);
    try {
      localStorage.setItem(hintKey, "1");
    } catch {
      /* private mode: the hint just comes back next visit */
    }
  };

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
      // A pattern isn't a column itself, so the visible order lacks it.
      updateLayout({ columnOrder: keepPatterns(order, effectiveConfig.columnOrder) });
    },
    [orderedKeys, effectiveConfig.columnOrder, updateLayout],
  );

  const hideColumn = useCallback(
    (key: string) =>
      updateLayout({
        // On an explicit-column board columnOrder IS the column set, so a
        // removed key must leave it too — otherwise the column stays alive
        // until the next reorder silently drops it. Folder/status re-derive
        // their columns from the data, so their saved order is left intact
        // and a column that repopulates keeps the position it was given.
        // A column a pattern brought in isn't in the saved order; hiding it
        // is enough, and leaves the pattern's other columns unpinned.
        ...(effectiveConfig.explicitColumns
          ? { columnOrder: (effectiveConfig.columnOrder ?? []).filter((k) => k !== key) }
          : {}),
        hiddenColumns: [
          ...new Set([...(effectiveConfig.hiddenColumns ?? []), key]),
        ],
      }),
    [
      orderedKeys,
      effectiveConfig.explicitColumns,
      effectiveConfig.columnOrder,
      effectiveConfig.hiddenColumns,
      updateLayout,
    ],
  );

  /** Drop a pattern (status*) and every column it brought in. */
  const removePattern = useCallback(
    (pattern: string) =>
      updateLayout({ columnOrder: withoutPattern(effectiveConfig.columnOrder, pattern) }),
    [effectiveConfig.columnOrder, updateLayout],
  );

  /**
   * Add a column that holds no cards yet.
   *
   * For tags that is a tag value; for folders it is a folder path, and the
   * folder is created right away (the same empty-folder write as New folder)
   * so it shows in the sidebar tree too — a layout-only column read as a
   * folder the tree had lost (CU-wdqcq04wnz). The × only hides the column.
   *
   * The folder key is slugified here because the server slugifies the path it
   * writes: keyed on the typed text, "New Folder" would sit empty next to the
   * `new-folder` column the dropped card actually created.
   */
  const addColumn = useCallback(
    async (value: string) => {
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
        try {
          await api.createFolder(nestId, v);
        } catch (e: any) {
          toast.error(e?.message || "Failed to create folder");
          return;
        }
      }
      updateLayout({
        // Append to the order (a key in columnOrder shows even with no cards)
        // and un-hide it if it was removed earlier.
        // On a curated board that's the saved order, so a pattern's columns
        // stay unpinned; a fresh board's auto columns are written out first.
        columnOrder: [
          ...new Set([
            ...(effectiveConfig.explicitColumns ? (effectiveConfig.columnOrder ?? []) : orderedKeys),
            v,
          ]),
        ],
        hiddenColumns: (effectiveConfig.hiddenColumns ?? []).filter(
          (k) => k !== v,
        ),
      });
      setNewColumn("");
    },
    [
      nestId,
      orderedKeys,
      effectiveConfig.dimension,
      effectiveConfig.columnOrder,
      effectiveConfig.hiddenColumns,
      updateLayout,
      members,
    ],
  );

  // Tags not yet a column, with card counts — the add-column box's list.
  const tagColumnSuggestions = useMemo(
    () => tagSuggestions(nodes, effectiveConfig, ""),
    [nodes, effectiveConfig],
  );
  // The tag groups in use, for the group picker beside "Columns by".
  const tagGroups = useMemo(() => tagNamespaces(nodes), [nodes]);
  // Where picking "Tag" lands: the nest's stage group, not a wall of every tag.
  const defaultTagGroup = useMemo(
    () =>
      stageOrder?.namespace ??
      taskGroups[0] ??
      (tagGroups.some((g) => g.namespace === "stage") ? "stage" : ""),
    [stageOrder, taskGroups, tagGroups],
  );
  const tagPatterns = useMemo(
    () =>
      effectiveConfig.dimension === "tag"
        ? (effectiveConfig.columnOrder ?? []).filter(isColumnPattern)
        : [],
    [effectiveConfig.dimension, effectiveConfig.columnOrder],
  );

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
    (n: BoardNode) => {
      // Only the tags that ARE columns on this board — "launch" on a
      // todo/doing/done board is a tag, not where the card sits.
      const keys = cardColumnKeys(n, effectiveConfig);
      const shown = keys.filter((k) => columnLabels.has(k));
      return shown.length > 0 ? shown : keys;
    },
    [effectiveConfig, columnLabels],
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
    if (lane === "field" && !laneField) return null;
    if (lane === "field" && laneField) {
      return buildLanes(
        visibleNodes,
        lane,
        (key) => fieldKeyLabel(laneField, key, personLabel),
        laneField,
      );
    }
    const none = { assignee: "Unassigned", priority: "No priority", parent: "No parent", field: "" }[lane];
    return buildLanes(visibleNodes, lane, (key) =>
      key === UNCATEGORIZED
        ? none
        : lane === "assignee"
          ? personLabel(key)
          : lane === "priority"
            ? levelLabel(priorityLevels, key)
            : (nodes.find((n) => n.id === key)?.title ?? key),
      undefined,
      priorityLevels.map((l) => l.key),
    );
  }, [config.swimlane, laneField, visibleNodes, nodes, personLabel, priorityLevels]);
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
    const dot =
      effectiveConfig.dimension === "tag" && !isDone
        ? stageDot(col.key, namespaceKey(effectiveConfig.tagNamespace))
        : undefined;
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
          {effectiveConfig.field && col.key !== UNCATEGORIZED && (
            effectiveConfig.field.type === "user" ? (
              <Avatar email={col.key} size="sm" />
            ) : effectiveConfig.field.type === "select" || effectiveConfig.field.type === "multi_select" ? (
              <span className={`h-2 w-2 shrink-0 rounded-full ${optionDot(effectiveConfig.field, col.key)}`} />
            ) : null
          )}
          {isDone && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />}
          {dot && <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />}
          <span
            className={`min-w-0 text-[13px] font-semibold truncate ${
              capitalizeColumnHeader(effectiveConfig.dimension) ? "capitalize" : ""
            } ${col.key === UNCATEGORIZED ? "text-muted-foreground" : ""}`}
          >
            {effectiveConfig.dimension === "assignee" && col.key !== UNCATEGORIZED
              ? personLabel(col.key)
              : effectiveConfig.field?.type === "user" && col.key !== UNCATEGORIZED
                ? personLabel(col.key)
                : col.label}
          </span>
        </span>
        <div className="flex items-center gap-1 shrink-0">
          <span className="rounded-full bg-background px-1.5 py-px text-[11px] font-medium text-muted-foreground tabular-nums">{count}</span>
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
          const shownTags = cardTags(n.tags);
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
                className={`group rounded-lg border border-border bg-card px-3 py-2.5 text-sm cursor-pointer shadow-sm hover:border-primary/50 hover:shadow-md transition ${
                  dragId === n.id ? "opacity-50" : ""
                } ${busy ? "pointer-events-none" : ""}`}
              >
                {/* A sub-item names its parent, as ClickUp does. Redundant
                    inside its parent's own swimlane, so hidden there. */}
                {n.parent && !(config.swimlane === "parent" && laneKey === n.parent) && (
                  <div
                    className="mb-1 truncate text-[10px] text-muted-foreground"
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
                    className={`min-w-0 flex-1 text-[13px] font-medium leading-snug break-words ${completed ? "text-muted-foreground" : ""}`}
                  >
                    <TicketChip ticket={ticketOf(n.tags)} className="mr-1.5 align-middle" />
                    {n.title}
                  </span>
                </div>
                {/* Custom fields with a value, in the nest's order. The
                    board's own grouping field is the column — not repeated. */}
                {(() => {
                  const shown = applicableFields(fieldDefs, n.type).filter(
                    (d) =>
                      d.key !== effectiveConfig.field?.key &&
                      d.key !== laneField?.key,
                  );
                  if (shown.length === 0) return null;
                  const chips = shown.map((d) => (
                    <FieldChip key={d.key} def={d} node={n} now={now} personLabel={personLabel} />
                  ));
                  return <div className="mt-2 flex flex-wrap gap-1">{chips}</div>;
                })()}
                {/* Footer, Linear-style: set priority · tags · due · sub-items ·
                    last touched on the left; the hover-only "set" controls for
                    empty fields, then the assignee, on the right — so an
                    invisible placeholder never pushes the timestamp inward. */}
                {(() => {
                  const priorityCtl = (
                    <PriorityMenu
                      value={n.priority}
                      editable={canEditDocs}
                      onChange={(priority) => patchFields(n.id, { priority })}
                    />
                  );
                  const dueCtl = !completed && (
                    <DueChip
                      due={n.due}
                      today={today}
                      editable={canEditDocs}
                      onChange={(due) => patchFields(n.id, { due })}
                    />
                  );
                  return (
                    <div className="mt-2 flex min-w-0 items-center gap-1.5 min-h-6">
                      {n.priority && priorityCtl}
                      {shownTags.slice(0, 3).map((t) => (
                        <TagPill key={t} tag={t} label={surfaceName.get(bareTag(t).replace(/^surface:/, ""))} />
                      ))}
                      {shownTags.length > 3 && (
                        <span
                          className="text-[10px] text-muted-foreground"
                          title={shownTags.slice(3).join(" ")}
                        >
                          +{shownTags.length - 3}
                        </span>
                      )}
                      <BlockedBadge count={openBlockers(n)} />
                      {n.due && dueCtl}
                      <SubItemChip
                        items={kids}
                        done={kids.filter((k) => !!k.completed_at).length}
                        onOpen={onOpenDocument}
                      />
                      {/* Last touched — the first thing to give way on a crowded
                      card: a zero-width lead lets the label wrap onto a clipped
                      second line, so it disappears whole instead of as "j…". */}
                      {(n.updated_at || n.created_at) && (
                        <span className="flex h-4 min-w-0 flex-1 flex-wrap items-center overflow-hidden">
                          <span aria-hidden className="h-4 w-0" />
                          <span
                            className="whitespace-pre text-[10px] text-muted-foreground/80 tabular-nums"
                            title={timestampsTooltip(n, (iso) => new Date(iso).toLocaleString())}
                          >
                            {completed && n.completed_at
                              ? `done ${timeAgo(n.completed_at)}`
                              : timeAgo((n.updated_at || n.created_at)!)}
                          </span>
                        </span>
                      )}
                      <span className="ml-auto flex shrink-0 items-center gap-1">
                        {!n.priority && priorityCtl}
                        {!n.due && dueCtl}
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
                  );
                })()}
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
          <CreateTaskDialog
            parentTitle={
              addingIn.parent ? nodes.find((x) => x.id === addingIn.parent)?.title ?? "task" : undefined
            }
            initial={{
              assignee:
                newCardPlacement(col.key, effectiveConfig)?.assignee ??
                (assigneeFilter.size === 1 && !assigneeFilter.has(UNASSIGNED)
                  ? [...assigneeFilter][0]
                  : undefined),
              priority: newCardPlacement(col.key, effectiveConfig)?.priority,
            }}
            people={members}
            me={me}
            surfaces={surfaceChoices}
            defaultSurface={defaultSurfaceTag}
            onSubmit={async (task) => {
              const id = await createCard(col.key, task, addingIn.parent, addingIn.lane);
              setAddingIn(null);
              if (id) onOpenDocument(id);
            }}
            onClose={() => setAddingIn(null)}
          />
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <NestPageHeader nestName={nestName} onBack={onBack}>
        <div className="flex flex-wrap items-center gap-2">
          {/* Two capsules — what the columns are, and how the rows split — so
              the bar reads as two settings, not six loose controls. */}
          <div className={CAPSULE}>
          <span className={CAPSULE_LABEL}>Columns</span>
          <div className="relative">
          <select
            value={
              config.dimension === "field"
                ? `${FIELD_PREFIX}${config.fieldKey ?? ""}`
                : config.dimension
            }
            onChange={(e) => {
              // The add-column input is shared between folder and tag mode;
              // an unsubmitted value from one doesn't mean anything in the
              // other, so switching dimensions clears it.
              setNewColumn("");
              const v = e.target.value;
              if (v.startsWith(FIELD_PREFIX)) {
                updateConfig({ dimension: "field", fieldKey: v.slice(FIELD_PREFIX.length) });
              } else if (v === "tag") {
                updateConfig({
                  dimension: "tag",
                  tagNamespace: (config.tagNamespace ?? "").trim() ? config.tagNamespace : defaultTagGroup,
                });
              } else {
                updateConfig({ dimension: v as DimensionKind });
              }
            }}
            aria-label="Group columns by"
            className={BARE_SELECT}
          >
            <option value="folder">Folder</option>
            <option value="status">Review status</option>
            <option value="tag">Tag</option>
            <option value="assignee">Assignee</option>
            <option value="priority">Priority</option>
            {groupableFields.length > 0 && (
              <optgroup label="Fields">
                {groupableFields.map((d) => (
                  <option key={d.key} value={`${FIELD_PREFIX}${d.key}`}>
                    {d.label}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <ChevronDown className={CHEVRON} />
          </div>
          {config.dimension === "tag" && (
            <>
              <span className="h-4 w-px bg-border" />
              <TagGroupInput
                borderless
                value={config.tagNamespace ?? ""}
                groups={tagGroups}
                onChange={(ns) => updateConfig({ tagNamespace: ns })}
              />
            </>
          )}
          </div>
          {/* Swimlanes: sub-group the columns into rows (Linear/Jira). The
              list has no lanes — its sections are the columns. */}
          {viewMode === "board" && (<>
          <div className={CAPSULE}>
          <span className={CAPSULE_LABEL}>Lanes</span>
          <div className="relative">
          <select
            value={
              config.swimlane === "field"
                ? `${FIELD_PREFIX}${config.swimlaneField ?? ""}`
                : (config.swimlane ?? "")
            }
            onChange={(e) => {
              const v = e.target.value;
              if (v.startsWith(FIELD_PREFIX)) {
                updateConfig({ swimlane: "field", swimlaneField: v.slice(FIELD_PREFIX.length) });
              } else {
                updateConfig({ swimlane: (v || undefined) as SwimlaneKind | undefined });
              }
            }}
            aria-label="Lanes"
            className={BARE_SELECT}
          >
            <option value="">None</option>
            {config.dimension !== "assignee" && <option value="assignee">Assignee</option>}
            {config.dimension !== "priority" && <option value="priority">Priority</option>}
            <option value="parent">Parent</option>
            {groupableFields.some((d) => !(config.dimension === "field" && d.key === config.fieldKey)) && (
              <optgroup label="Fields">
                {groupableFields
                  .filter((d) => !(config.dimension === "field" && d.key === config.fieldKey))
                  .map((d) => (
                    <option key={d.key} value={`${FIELD_PREFIX}${d.key}`}>
                      {d.label}
                    </option>
                  ))}
              </optgroup>
            )}
          </select>
          <ChevronDown className={CHEVRON} />
          </div>
          </div>
          </>)}
          {/* Add a column: a tag value, or — for writers on the folder board —
              a folder. Without this a nest whose documents all sit in Root has
              a single column and nowhere to drag them. */}
          {config.dimension === "tag" && (
            <>
              {/* Pattern columns aren't columns themselves — each shows here,
                  removable, while its matching tags show as columns. */}
              {tagPatterns.map((p) => (
                <span
                  key={p}
                  className="inline-flex h-8 items-center gap-1 rounded-md border px-2 font-mono text-xs"
                  title={`Every tag matching “${p}” is a column, including new ones. × removes them all.`}
                >
                  {p}
                  <button
                    type="button"
                    onClick={() => removePattern(p)}
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`Remove the ${p} columns`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {tagColumnSuggestions.length > 0 || addingColumn ? (
                <TagColumnInput
                  suggestions={tagColumnSuggestions}
                  autoFocus={addingColumn}
                  onAdd={(v) => {
                    void addColumn(v);
                    setAddingColumn(false);
                  }}
                  onClose={() => setAddingColumn(false)}
                />
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => setAddingColumn(true)}
                  title="Add a column for a tag no card carries yet, such as an empty stage"
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Column
                </Button>
              )}
            </>
          )}
          {(effectiveConfig.dimension === "folder" ||
            effectiveConfig.dimension === "assignee") &&
            canEditDocs && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void addColumn(newColumn);
              }}
              className="flex items-center gap-1"
            >
              <Input
                value={newColumn}
                onChange={(e) => setNewColumn(e.target.value)}
                placeholder={
                  config.dimension === "assignee" ? "add person…" : "new folder…"
                }
                list={config.dimension === "assignee" ? "board-people" : undefined}
                className="h-8 w-32"
                title="Add a folder column — drag a card into it to file the document there (nest with parent/child)"
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
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={!newColumn.trim()}
                title="Add folder column"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </form>
          )}
          {/* Board | List — the same slice, laid out as cards or rows. */}
          <div
            role="radiogroup"
            aria-label="Layout"
            className="inline-flex h-8 items-center rounded-md border border-border bg-muted/40 p-0.5"
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
                    ? "bg-background text-primary shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          {viewMode === "board" && (
            <Button
              variant={showHelp ? "secondary" : "outline"}
              size="sm"
              className="h-8 px-2"
              aria-pressed={showHelp}
              title="How this board works"
              onClick={() => setShowHelp((v) => !v)}
            >
              <HelpCircle className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-8" onClick={() => void load()} disabled={loading}>
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
                  onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") {
                      setRenaming(null);
                      if (renaming.fresh) void removeBoard(b);
                    }
                  }}
                  onBlur={() => {
                    const v = renaming.value.trim();
                    setRenaming(null);
                    // A new board left unnamed is an accidental click — discard it.
                    if (renaming.fresh && (!v || v === b.name)) void removeBoard(b);
                    else if (v && v !== b.name) void saveBoardMeta(b.id, { name: v });
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

      {viewMode === "board" && showHelp && (
      <ul className="max-w-2xl list-disc space-y-1 rounded-lg border border-border bg-muted/40 py-3 pl-8 pr-4 text-xs text-muted-foreground">
        {config.dimension === "status" ? (
          <>
            <li>
              Review status (draft, pending, published) is{" "}
              <span className="font-medium text-foreground">read-only</span>{" "}
              here — move a doc through review in the document view. To group tasks by
              stage, pick the stage option instead.
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
                ? "Pick All tags in the list beside Tag to group by every tag."
                : "Pick a group such as stage: from the list beside Tag to use only its values."}
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
              remove one. A pattern like{" "}
              <code className="font-medium text-foreground">status*</code> adds a
              column for every matching tag, new ones included.
            </li>
          </>
        ) : config.dimension === "field" ? (
          <>
            <li>
              One column per{" "}
              <span className="font-medium text-foreground">
                {effectiveConfig.field?.label.toLowerCase() ?? "value"}
              </span>
              {effectiveConfig.field
                ? canEditDocs
                  ? " — drag a card across to change it. Every change is a versioned edit."
                  : "."
                : " — this field no longer exists; pick another grouping."}
            </li>
            <li>Drag a card up or down to rank it; pick Lanes to split rows.</li>
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
              creates an empty folder and its column.
            </li>
          </>
        )}
      </ul>
      )}

      {/* Project-board bar: tasks-only toggle + the person quick-filter
          (Jira/ClickUp's avatar row — click faces to show only their cards). */}
      <div className="flex flex-wrap items-center gap-3">
        {typeTaskEnabled && (
          <button
            type="button"
            aria-pressed={!!config.tasksOnly}
            onClick={() => updateConfig({ tasksOnly: !config.tasksOnly })}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm transition-colors ${
              config.tasksOnly
                ? "border-primary/30 bg-primary/10 font-medium text-primary"
                : "border-input text-muted-foreground hover:text-foreground"
            }`}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Tasks only
          </button>
        )}
        <div className={CAPSULE}>
          <span className={CAPSULE_LABEL}>Completed</span>
          <div className="relative">
          <select
            value={config.hideDoneAfterDays ?? ""}
            onChange={(e) =>
              updateConfig({
                hideDoneAfterDays: e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
            aria-label="Completed"
            className={BARE_SELECT}
          >
            <option value="">All</option>
            <option value="7">Past week</option>
            <option value="30">Past month</option>
            <option value="0">Hide</option>
          </select>
          <ChevronDown className={CHEVRON} />
          </div>
        </div>
        {/* Tag filter: cards must carry every tag listed (saved per board). */}
        <div className="flex h-8 min-w-0 flex-wrap items-center gap-1 rounded-md border border-input bg-background pl-2 pr-1 text-sm focus-within:ring-2 focus-within:ring-ring">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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
          <input
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
            placeholder="Filter by title or #tag"
            title="Type to filter by title. Enter adds the text as a tag filter."
            className="h-7 w-44 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {/* Custom-field filters (select / person / checkbox), saved per board. */}
        {groupableFields.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="board-field-filters">
            {groupableFields.map((d) => (
              <FieldFilterMenu
                key={d.key}
                def={d}
                value={config.filterFields?.[d.key]}
                people={members}
                personLabel={personLabel}
                onChange={(v) => {
                  const next = { ...(config.filterFields ?? {}) };
                  if (v === undefined) delete next[d.key];
                  else next[d.key] = v;
                  updateConfig({ filterFields: Object.keys(next).length > 0 ? next : undefined });
                }}
              />
            ))}
          </div>
        )}
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
        {(blockedCount > 0 || hideBlocked) && (
          <Button
            variant={hideBlocked ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-xs"
            aria-pressed={hideBlocked}
            title={hideBlocked ? "Show blocked tasks again" : "Hide tasks that have an open blocker"}
            onClick={() => setHideBlocked((v) => !v)}
            data-testid="board-hide-blocked"
          >
            Hide blocked
            <span className="ml-1 tabular-nums text-muted-foreground">{blockedCount}</span>
          </Button>
        )}
      </div>

      {/* Cards carry a number only once numbering is on. Say so once, to the
          people who can turn it on — the number is the team's shorthand. */}
      {!hintGone && unnumbered > 0 && (
        <HintBanner testId="board-unnumbered-hint" onDismiss={dismissHint}>
          <span>
            <span className="font-medium text-foreground">
              {unnumbered} task{unnumbered === 1 ? " has" : "s have"} no ticket number yet.
            </span>{" "}
            Number them and every card gets its ID.
          </span>
          <Button size="sm" className="h-7 px-2.5 text-xs" disabled={numbering} onClick={() => void numberThem()}>
            {numbering ? "Numbering…" : "Number them, oldest first"}
          </Button>
        </HintBanner>
      )}
      {!hintGone && numberingOffHint && (
        <HintBanner testId="board-numbering-hint" onDismiss={dismissHint}>
          <span>These tasks have no ticket numbers yet, so cards can't show one.</span>
          <a className="font-medium text-primary underline-offset-2 hover:underline" href={`${nestPath(nestId)}?tab=fields`}>
            Turn on task numbering
          </a>
        </HintBanner>
      )}

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
            ? "No tag columns yet — add one above to start sorting documents into it, or a pattern like status* for every matching tag."
            : "No documents to show."}
        </div>
      ) : viewMode === "list" ? (
        <BoardListView
          nestId={nestId}
          boardId={activeBoard?.id}
          dimension={effectiveConfig.dimension}
          fieldLabel={effectiveConfig.field?.label}
          tagNamespace={effectiveConfig.tagNamespace}
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
          onChanged={async () => {
            await qc.invalidateQueries({ queryKey: reads.nodesMeta(nestId).queryKey });
            await load({ silent: true });
          }}
        />
      ) : (
        lanes ? (
          // Swimlanes: column headers once, then one row of cells per lane.
          <div ref={boardRef} className="overflow-auto pb-4" style={boardH ? { maxHeight: boardH } : undefined}>
            <div className="inline-flex min-w-full flex-col gap-2">
              {/* Column titles stay put while the lanes scroll (CU-wdqcq0656r). */}
              <div className="sticky top-0 z-10 flex gap-3 bg-background">
                {columns.map((col) => (
                  <div
                    key={col.key}
                    {...cellDropHandlers(col)}
                    className="w-64 flex-shrink-0 rounded-lg border border-transparent bg-muted/60"
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
                      {laneField && lane.key !== UNCATEGORIZED && laneField.type === "user" && (
                        <Avatar email={lane.key} size="sm" />
                      )}
                      {laneField &&
                        lane.key !== UNCATEGORIZED &&
                        (laneField.type === "select" || laneField.type === "multi_select") && (
                          <span className={`h-2 w-2 rounded-full ${optionDot(laneField, lane.key)}`} />
                        )}
                      <span className={lane.key === UNCATEGORIZED ? "text-muted-foreground" : ""}>
                        {lane.label}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">{lane.nodes.length}</span>
                    </button>
                    {!collapsed && (
                      <div className="flex gap-3">
                        {columns.map((col) => {
                          const cards = (orderedByColumn[col.key] ?? []).filter(
                            (n) => laneKeyOf(n, config.swimlane as SwimlaneKind, laneField) === lane.key,
                          );
                          const cell = `${lane.key}\u0001${col.key}`;
                          return (
                            <div
                              key={col.key}
                              {...cellDropHandlers(col, lane.key)}
                              className={`flex w-64 flex-shrink-0 flex-col rounded-lg border bg-muted/40 transition-colors ${
                                dropCol === cell ? "border-primary ring-1 ring-primary" : "border-transparent"
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
        <div ref={boardRef} className="flex gap-3 overflow-x-auto pb-4">
          {columns.map((col) => {
            const cards = orderedByColumn[col.key] ?? [];
            return (
              <div
                key={col.key}
                {...cellDropHandlers(col)}
                className={`flex-shrink-0 w-64 rounded-lg border bg-muted/60 flex flex-col max-h-[70vh] transition-colors ${
                  dropCol === col.key ? "border-primary ring-1 ring-primary" : "border-transparent"
                }`}
                // Fit above the scroller's bottom padding (pb-4).
                style={boardH ? { maxHeight: boardH - 16 } : undefined}
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

/** The board, with the nest's priority levels (task_rules.priorities) in scope
 *  for every card, menu and column below it. */
export function MaturityBoard(props: Props) {
  const settings = useNestSettings(props.nestId);
  const levels = levelsOrDefault(settings.data?.task_rules?.priorities);
  return (
    <PriorityLevelsContext.Provider value={levels}>
      <MaturityBoardInner {...props} />
    </PriorityLevelsContext.Provider>
  );
}
