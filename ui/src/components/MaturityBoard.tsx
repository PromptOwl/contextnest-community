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
} from "lucide-react";
import { toast } from "sonner";
import * as api from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { deriveNestCaps } from "../lib/nest-caps";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  STATUS_ORDER,
  UNCATEGORIZED,
  groupByColumn,
  planMove,
  type BoardNode,
  type BoardConfig,
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

function loadConfig(nestId: string): BoardConfig {
  try {
    const raw = localStorage.getItem(CONFIG_PREFIX + nestId);
    if (raw) {
      const p = JSON.parse(raw);
      const dimension: DimensionKind =
        p.dimension === "status" || p.dimension === "tag" ? p.dimension : "folder";
      return {
        dimension,
        tagNamespace:
          typeof p.tagNamespace === "string" ? p.tagNamespace : "",
      };
    }
  } catch {
    // ignore corrupt storage — fall through to default
  }
  // Empty namespace = group by every tag, which is the only setting that shows
  // real columns on a vault of flat (un-namespaced) tags.
  return { dimension: "folder", tagNamespace: "" };
}

function saveConfig(nestId: string, config: BoardConfig) {
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
  const [config, setConfig] = useState<BoardConfig>(() => loadConfig(nestId));
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
    (patch: Partial<BoardConfig>) => {
      setConfig((prev) => {
        const next = { ...prev, ...patch };
        saveConfig(nestId, next);
        return next;
      });
    },
    [nestId],
  );

  const effectiveConfig = useMemo<BoardConfig>(
    () => ({
      ...config,
      columnOrder:
        config.dimension === "status" ? STATUS_ORDER : config.columnOrder,
    }),
    [config],
  );

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
        } else if (plan.kind === "set-tag") {
          await api.updateNode(nestId, id, { tags: plan.tags });
          toast.success("Updated");
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
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
          </Button>
        </div>
      </NestPageHeader>

      {config.dimension === "status" ? (
        <p className="text-xs text-muted-foreground">
          Status reflects the governance lifecycle and is read-only here — moving
          a doc through review happens in the document view. Switch to Folder for
          a draggable board.
        </p>
      ) : config.dimension === "tag" ? (
        <p className="text-xs text-muted-foreground">
          {config.tagNamespace?.trim()
            ? `Grouped by ${config.tagNamespace.trim().split(":")[0]}: tags — only documents carrying one appear in a column. Clear the box to group by every tag instead.`
            : "Grouped by tag — one column per tag, so a document with several tags appears in each of them. Type a namespace (e.g. stage) to group by stage: values only."}{" "}
          Read-only: a document has many tags, so dragging it out of one column
          has no single meaning.
        </p>
      ) : !canEditDocs ? (
        <p className="text-xs text-muted-foreground">
          You have read-only access to this nest, so cards can't be moved. Ask
          the nest owner for write access to rearrange the board.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Drag a card between columns to move it to that folder.
        </p>
      )}

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
                  if (!draggable) return;
                  e.preventDefault();
                  setDropCol(col.key);
                }}
                onDragLeave={() =>
                  setDropCol((c) => (c === col.key ? null : c))
                }
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(col.key);
                }}
                className={`flex-shrink-0 w-64 rounded-lg border bg-muted/30 flex flex-col max-h-[70vh] transition-colors ${
                  isDropTarget
                    ? "border-primary ring-1 ring-primary"
                    : "border-border"
                }`}
              >
                <div className="flex items-center justify-between px-3 py-2 border-b border-border sticky top-0">
                  <span
                    className={`text-sm font-medium truncate capitalize ${
                      col.key === UNCATEGORIZED ? "text-muted-foreground" : ""
                    }`}
                    title={col.title}
                  >
                    {col.label}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {cards.length}
                  </span>
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
                        <span className="flex-1 leading-snug break-words">
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
