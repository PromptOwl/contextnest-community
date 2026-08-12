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
import { useCallback, useEffect, useMemo, useState } from "react";
import { NestPageHeader } from "./NestPageHeader";
import {
  RefreshCw,
  Loader2,
  FileText,
  Zap,
  Bot,
  Database,
  GripVertical,
  X,
  Plus,
} from "lucide-react";
import { toast } from "sonner";
import * as api from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { deriveNestCaps } from "../lib/nest-caps";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  UNCATEGORIZED,
  cardColumnKeys,
  groupByColumn,
  layoutKey,
  planMove,
  resolveConfig,
  type BoardNode,
  type BoardSettings,
  type ColumnLayout,
  type DimensionKind,
} from "../lib/board-dimensions";

interface Props {
  nestId: string;
  nestName: string;
  isOwner: boolean;
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
          layouts[k] = {
            columnOrder: strings((v as any).columnOrder),
            hiddenColumns: strings((v as any).hiddenColumns),
          };
        }
      }
      // Saves from before layouts existed kept one shared order; file it under
      // whichever dimension was active when it was written.
      const legacy = {
        columnOrder: strings(p.columnOrder),
        hiddenColumns: strings(p.hiddenColumns),
      };
      if (legacy.columnOrder || legacy.hiddenColumns) {
        layouts[layoutKey({ dimension, tagNamespace })] ??= legacy;
      }
      return { dimension, tagNamespace, layouts };
    }
  } catch {
    // ignore corrupt storage — fall through to default
  }
  // Empty namespace = group by every tag, which is the only setting that shows
  // real columns on a vault of flat (un-namespaced) tags.
  return { dimension: "folder", tagNamespace: "", layouts: {} };
}

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
  return <FileText className={`${cls} text-muted-foreground`} />;
}

export function MaturityBoard({
  nestId,
  nestName,
  isOwner,
  onBack,
  onOpenDocument,
}: Props) {
  const { isAdmin } = useAuth();
  const [nodes, setNodes] = useState<BoardNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<BoardSettings>(() => loadConfig(nestId));
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Same derivation NestView uses. Starts false so a read-only viewer never
  // sees a draggable card during the fetch, then flips on for writers.
  const [canEditDocs, setCanEditDocs] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getNest(nestId)
      .then((meta: any) => {
        if (cancelled) return;
        setCanEditDocs(
          deriveNestCaps({
            roles: meta?.roles ?? [],
            permission: meta?.permission ?? null,
            myStewards: meta?.myStewards ?? [],
            isOwner,
            isAdmin,
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
  }, [nestId, isOwner, isAdmin]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { nodes: raw } = await api.listNodes(nestId);
      setNodes(
        (raw as any[]).map((n) => ({
          id: n.id,
          title: n.title ?? n.id,
          type: n.type ?? "document",
          tags: Array.isArray(n.tags) ? n.tags : [],
          status: n.status ?? "",
        })),
      );
    } catch (e: any) {
      setError(e?.message || "Failed to load nodes");
    } finally {
      setLoading(false);
    }
  }, [nestId]);

  useEffect(() => {
    load();
  }, [load]);

  const updateConfig = useCallback(
    (patch: Partial<BoardSettings>) => {
      setConfig((prev) => {
        const next = { ...prev, ...patch };
        saveConfig(nestId, next);
        return next;
      });
    },
    [nestId],
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
        saveConfig(nestId, next);
        return next;
      });
    },
    [nestId],
  );

  const effectiveConfig = useMemo(() => resolveConfig(config), [config]);

  const { columns, byColumn } = useMemo(
    () => groupByColumn(nodes, effectiveConfig),
    [nodes, effectiveConfig],
  );

  const handleDrop = useCallback(
    async (targetKey: string) => {
      const id = dragId;
      setDragId(null);
      setDropCol(null);
      if (!id) return;
      const node = nodes.find((n) => n.id === id);
      if (!node) return;

      const plan = planMove(node, targetKey, effectiveConfig);
      if (plan.kind === "unsupported") {
        // Silent for a pure no-op (same column); explain the real blockers.
        if (plan.reason !== "Already in this column.") toast(plan.reason);
        return;
      }

      setBusy(true);
      try {
        if (plan.kind === "move-folder") {
          await api.moveNode(nestId, id, plan.folder);
          toast.success("Moved");
        }
        await load();
      } catch (e: any) {
        toast.error(e?.message || "Move failed");
      } finally {
        setBusy(false);
      }
    },
    [dragId, nodes, effectiveConfig, nestId, load],
  );

  // Folder is the only dimension a drag can set. Status moves through the
  // review workflow, and a tag column can hold the same doc more than once
  // (a doc has many tags), so "moved out of this column" has no single
  // meaning. Write access is the second, independent condition.
  const dimensionDraggable = effectiveConfig.dimension === "folder";
  const draggable = dimensionDraggable && canEditDocs;

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
        hiddenColumns: [
          ...new Set([...(effectiveConfig.hiddenColumns ?? []), key]),
        ],
      }),
    [effectiveConfig.hiddenColumns, updateLayout],
  );

  const addTagColumn = useCallback(
    (value: string) => {
      const v = value.trim();
      if (!v) return;
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
    [orderedKeys, effectiveConfig.hiddenColumns, updateLayout],
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
            onChange={(e) =>
              updateConfig({ dimension: e.target.value as DimensionKind })
            }
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
          {config.dimension === "tag" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                addTagColumn(newColumn);
              }}
              className="flex items-center gap-1"
            >
              <Input
                value={newColumn}
                onChange={(e) => setNewColumn(e.target.value)}
                placeholder="add column…"
                list="board-tag-values"
                className="h-8 w-32"
                title="Add a tag column — pick an existing tag or type a new value"
              />
              <datalist id="board-tag-values">
                {availableTagValues.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={!newColumn.trim()}
                title="Add column"
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
              Cards are{" "}
              <span className="font-medium text-foreground">read-only</span>;
              drag a header to reorder.
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
          </>
        )}
      </ul>

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading board…
        </div>
      ) : error ? (
        <div className="text-sm text-destructive py-8">{error}</div>
      ) : columns.length === 0 ? (
        <div className="text-sm text-muted-foreground py-8">
          No documents to show.
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {columns.map((col) => {
            const cards = byColumn[col.key] ?? [];
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
                    className={`min-w-0 text-sm font-medium truncate capitalize ${
                      col.key === UNCATEGORIZED ? "text-muted-foreground" : ""
                    }`}
                  >
                    {col.label}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {cards.length}
                    </span>
                    {effectiveConfig.dimension === "tag" &&
                      col.key !== UNCATEGORIZED && (
                        <button
                          type="button"
                          onClick={() => hideColumn(col.key)}
                          className="text-muted-foreground/50 hover:text-foreground"
                          title="Remove this column — its cards move to Uncategorized"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {cards.map((n) => (
                    <div
                      key={n.id}
                      draggable={draggable}
                      onDragStart={(e) => {
                        setDragId(n.id);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", n.id);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setDropCol(null);
                      }}
                      onClick={() => onOpenDocument(n.id)}
                      className={`group rounded-md border border-border bg-card px-2.5 py-2 text-sm cursor-pointer hover:border-primary/60 hover:shadow-sm transition ${
                        dragId === n.id ? "opacity-50" : ""
                      } ${busy ? "pointer-events-none" : ""}`}
                    >
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
                    </div>
                  ))}
                  {cards.length === 0 && (
                    <div className="text-xs text-muted-foreground/60 text-center py-6">
                      {draggable ? "Drop here" : "Empty"}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
