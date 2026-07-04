import { useEffect, useState, useCallback } from "react";
import {
  ArrowLeft,
  Loader2,
  Play,
  Trash2,
  RefreshCw,
  BookOpen,
  Zap,
  Pencil,
  Bell,
  Plus,
} from "lucide-react";
import {
  listEdges,
  listEdgeTypes,
  createEdge,
  deleteEdge,
  listRuns,
  getRun,
  triggerRun,
  type WorkflowEdge,
  type EdgeType,
  type RunSummary,
  type RunDetail,
  type RunStep,
} from "../lib/api";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { Input } from "./ui/input";

interface Props {
  nestId: string;
  nestName: string;
  onBack: () => void;
}

const statusVariant = (
  s: RunSummary["status"],
): "default" | "secondary" | "destructive" | "outline" => {
  if (s === "succeeded") return "default";
  if (s === "failed" || s === "cancelled") return "destructive";
  return "secondary"; // running
};

// The step-log icon mirrors the run-trace prototype's read/branch/write/notify.
const stepIcon = (action: string) => {
  if (action === "read") return <BookOpen className="h-3.5 w-3.5" />;
  if (action === "branch") return <Zap className="h-3.5 w-3.5" />;
  if (action === "write") return <Pencil className="h-3.5 w-3.5" />;
  if (action === "notify") return <Bell className="h-3.5 w-3.5" />;
  return <span className="h-3.5 w-3.5" />;
};

const timeOf = (iso: string) => {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
};

export function WorkflowsView({ nestId, nestName, onBack }: Props) {
  const [tab, setTab] = useState("edges");

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <div>
          <div className="text-xs text-muted-foreground">
            {nestName} · Workflows
          </div>
          <h1 className="text-lg font-semibold leading-tight">Workflow plane</h1>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="edges">Edges</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>
        <TabsContent value="edges" className="mt-4">
          <EdgesPanel nestId={nestId} />
        </TabsContent>
        <TabsContent value="runs" className="mt-4">
          <RunsPanel nestId={nestId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Edges: the spreadsheet of typed connections ─────────────────────────

function EdgesPanel({ nestId }: { nestId: string }) {
  const [edges, setEdges] = useState<WorkflowEdge[]>([]);
  const [types, setTypes] = useState<EdgeType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  // New-row draft.
  const [nFrom, setNFrom] = useState("");
  const [nTo, setNTo] = useState("");
  const [nType, setNType] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [e, t] = await Promise.all([
        listEdges(nestId),
        listEdgeTypes(nestId),
      ]);
      setEdges(e);
      setTypes(t);
      if (!nType && t.length) setNType(t.find((x) => x.is_flow)?.name ?? t[0].name);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load edges");
    } finally {
      setLoading(false);
    }
  }, [nestId, nType]);

  useEffect(() => {
    void load();
  }, [load]);

  const addRow = async () => {
    if (!nFrom.trim() || !nTo.trim() || !nType) return;
    setSaving(true);
    try {
      await createEdge(nestId, {
        from_node: nFrom.trim(),
        to_node: nTo.trim(),
        type: nType,
      });
      setNFrom("");
      setNTo("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add edge");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteEdge(nestId, id);
      setEdges((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete edge");
    }
  };

  const shown = edges.filter((e) => {
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return (
      e.from_node.toLowerCase().includes(q) ||
      e.to_node.toLowerCase().includes(q) ||
      e.type.name.toLowerCase().includes(q)
    );
  });

  return (
    <div>
      <p className="text-sm text-muted-foreground mb-3">
        A spreadsheet of connections. The columns <em>are</em> the API —{" "}
        <code className="text-xs">from · type · to · condition</code>. Flow
        types (▶) form the DAG the runner walks.
      </p>

      <div className="flex items-center gap-2 mb-2">
        <Input
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-56 h-8"
        />
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <th className="text-left font-semibold px-3 py-2">From</th>
              <th className="text-left font-semibold px-3 py-2">Type</th>
              <th className="text-left font-semibold px-3 py-2">To</th>
              <th className="text-left font-semibold px-3 py-2">Condition</th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin inline" />
                </td>
              </tr>
            ) : (
              shown.map((e) => (
                <tr key={e.id} className="border-t hover:bg-muted/30">
                  <td className="px-3 py-1.5 font-mono text-xs">{e.from_node}</td>
                  <td className="px-3 py-1.5">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="h-2 w-2 rounded-sm inline-block"
                        style={{ background: e.type.color ?? "#94a3b8" }}
                      />
                      {e.type.is_flow && (
                        <span className="text-[10px] text-muted-foreground">▶</span>
                      )}
                      {e.type.name}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 font-mono text-xs">{e.to_node}</td>
                  <td className="px-3 py-1.5">
                    {e.condition ? (
                      <span
                        className={
                          e.condition_mode === "nl"
                            ? "italic text-amber-600 text-xs"
                            : "font-mono text-xs"
                        }
                      >
                        {e.condition}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => void remove(e.id)}
                      title="Delete edge"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))
            )}
            {/* New-row: type a node to add an edge, spreadsheet-style. */}
            <tr className="border-t bg-muted/20">
              <td className="px-3 py-1.5">
                <Input
                  value={nFrom}
                  onChange={(e) => setNFrom(e.target.value)}
                  placeholder="nodes/from…"
                  className="h-7 font-mono text-xs"
                />
              </td>
              <td className="px-3 py-1.5">
                <select
                  value={nType}
                  onChange={(e) => setNType(e.target.value)}
                  className="h-7 rounded-md border bg-background px-2 text-xs"
                >
                  {types.map((t) => (
                    <option key={t.id} value={t.name}>
                      {t.is_flow ? "▶ " : ""}
                      {t.name}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-3 py-1.5">
                <Input
                  value={nTo}
                  onChange={(e) => setNTo(e.target.value)}
                  placeholder="nodes/to…"
                  className="h-7 font-mono text-xs"
                />
              </td>
              <td className="px-3 py-1.5 text-xs text-muted-foreground">
                (structured / nl conditions: coming to the formula bar)
              </td>
              <td className="px-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  disabled={saving || !nFrom.trim() || !nTo.trim()}
                  onClick={() => void addRow()}
                  title="Add edge"
                >
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Runs: list + replayable trace ───────────────────────────────────────

function RunsPanel({ nestId }: { nestId: string }) {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triggerNode, setTriggerNode] = useState("");
  const [triggering, setTriggering] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRuns(await listRuns(nestId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load runs");
    } finally {
      setLoading(false);
    }
  }, [nestId]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (id: string) => {
    try {
      setSelected(await getRun(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load run");
    }
  };

  const trigger = async () => {
    if (!triggerNode.trim()) return;
    setTriggering(true);
    try {
      await triggerRun(nestId, triggerNode.trim());
      setTriggerNode("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to trigger run");
    } finally {
      setTriggering(false);
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-[minmax(0,320px)_1fr] gap-4">
      <div>
        <div className="flex items-center gap-2 mb-2">
          <Input
            placeholder="nodes/agent to run…"
            value={triggerNode}
            onChange={(e) => setTriggerNode(e.target.value)}
            className="h-8 font-mono text-xs"
          />
          <Button
            size="sm"
            disabled={triggering || !triggerNode.trim()}
            onClick={() => void trigger()}
            title="Create a run (a runner executes it)"
          >
            {triggering ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground mb-2">
          Triggering creates a run record + bundle. A runner (the
          contextnest-runner) walks it and posts each step back here.
        </p>

        {error && (
          <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="rounded-lg border divide-y">
          {loading ? (
            <div className="px-3 py-6 text-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin inline" />
            </div>
          ) : runs.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              No runs yet. Trigger an agent above.
            </div>
          ) : (
            runs.map((r) => (
              <button
                key={r.id}
                onClick={() => void open(r.id)}
                className={`w-full text-left px-3 py-2 hover:bg-muted/40 ${
                  selected?.id === r.id ? "bg-muted/60" : ""
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs truncate">
                    {r.id.slice(0, 12)}
                  </span>
                  <Badge variant={statusVariant(r.status)} className="text-[10px]">
                    {r.status}
                  </Badge>
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {r.agent_node} · {timeOf(r.started_at)}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Trace */}
      <div className="rounded-lg border p-4">
        {!selected ? (
          <div className="text-sm text-muted-foreground">
            Select a run to see its replayable trace.
          </div>
        ) : (
          <RunTrace run={selected} />
        )}
      </div>
    </div>
  );
}

function RunTrace({ run }: { run: RunDetail }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <span className="font-mono text-sm">{run.id}</span>
        <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
      </div>
      <div className="text-xs text-muted-foreground mb-4">
        agent {run.agent_node} · started {timeOf(run.started_at)}
        {run.finished_at ? ` · finished ${timeOf(run.finished_at)}` : ""} ·
        triggered by {run.triggered_by}
      </div>

      {run.trace?.error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive font-mono break-all">
          {run.trace.error}
        </div>
      )}

      <div className="space-y-0">
        {run.steps.length === 0 ? (
          <div className="text-xs text-muted-foreground">
            No steps recorded.
          </div>
        ) : (
          run.steps.map((s: RunStep) => (
            <div
              key={s.seq}
              className="grid grid-cols-[24px_1fr] gap-3 py-2 border-b border-dashed last:border-0"
            >
              <div className="text-muted-foreground pt-0.5">
                {stepIcon(s.action)}
              </div>
              <div>
                <div className="text-xs">
                  <span className="text-muted-foreground">
                    {timeOf(s.at)} ·{" "}
                  </span>
                  <span className="font-medium">{s.action}</span>
                  {s.node_id && (
                    <span className="font-mono text-muted-foreground">
                      {" "}
                      {s.node_id}
                    </span>
                  )}
                </div>
                {s.detail && (
                  <div className="text-[11px] text-muted-foreground font-mono mt-0.5 break-all">
                    {typeof s.detail === "string"
                      ? s.detail
                      : JSON.stringify(s.detail)}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
