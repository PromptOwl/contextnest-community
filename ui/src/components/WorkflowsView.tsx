import { useEffect, useState, useCallback } from "react";
import type React from "react";
import {
  ArrowLeft,
  ArrowRight,
  Loader2,
  Play,
  Trash2,
  RefreshCw,
  BookOpen,
  Zap,
  Pencil,
  Bell,
  Plus,
  Bot,
  FileText,
  FileCode2,
  CornerDownRight,
} from "lucide-react";
import {
  listEdges,
  listEdgeTypes,
  createEdge,
  deleteEdge,
  listRuns,
  getRun,
  triggerRun,
  listNodes,
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

// ─── Edges: flows first, spreadsheet second ──────────────────────────────
//
// The raw edge table read as a database dump — you couldn't see the workflow
// in it. This panel now leads with FLOWS: every chain of flow-type edges is
// grouped under its starting node and rendered step by step with document
// titles, type icons, and a plain-language condition pill per hop. Adding a
// step is a guided composer (pick two docs, pick when it fires) instead of a
// blank spreadsheet row. Non-flow (reference) edges keep a compact list at
// the bottom.

/** Small type glyph reused across flow rows; mirrors NodeTypeIcon colors. */
function TypeGlyph({ type }: { type?: string }) {
  if (type === "agent") return <Bot className="h-3.5 w-3.5 text-violet-500 shrink-0" />;
  if (type === "skill") return <Zap className="h-3.5 w-3.5 text-blue-500 shrink-0" />;
  if (type === "artifact") return <FileCode2 className="h-3.5 w-3.5 text-amber-500 shrink-0" />;
  return <FileText className="h-3.5 w-3.5 text-slate-400 shrink-0" />;
}

/** "always" / if "…" / metric CAC > 500 — one pill per edge. */
function ConditionPill({ edge }: { edge: WorkflowEdge }) {
  if (!edge.condition_mode || !edge.condition) {
    return (
      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
        always
      </span>
    );
  }
  if (edge.condition_mode === "nl") {
    return (
      <span
        className="rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-300 px-2 py-0.5 text-[10px] italic max-w-[260px] truncate inline-block align-middle"
        title={`AI judges: "${edge.condition}"`}
      >
        if “{String(edge.condition)}”
      </span>
    );
  }
  // structured: {term, op, value} or arbitrary JSON
  let text = "";
  try {
    const c = typeof edge.condition === "string" ? JSON.parse(edge.condition) : edge.condition;
    text = c && c.term ? `${c.term} ${c.op ?? ""} ${c.value ?? ""}` : JSON.stringify(c);
  } catch {
    text = String(edge.condition);
  }
  return (
    <span
      className="rounded-full bg-blue-500/10 text-blue-700 dark:text-blue-300 px-2 py-0.5 text-[10px] font-mono max-w-[260px] truncate inline-block align-middle"
      title={`Deterministic check: ${text}`}
    >
      {text}
    </span>
  );
}

function EdgesPanel({ nestId }: { nestId: string }) {
  const [edges, setEdges] = useState<WorkflowEdge[]>([]);
  const [types, setTypes] = useState<EdgeType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [nodes, setNodes] = useState<Array<{ id: string; title?: string; type?: string }>>([]);

  // Composer draft: pick two docs, choose when the step fires; metric
  // conditions are three plain fields (term / op / value), never raw JSON.
  const [nFrom, setNFrom] = useState("");
  const [nTo, setNTo] = useState("");
  const [nType, setNType] = useState("");
  const [nWhen, setNWhen] = useState<"" | "nl" | "structured">("");
  const [nIf, setNIf] = useState("");
  const [nTerm, setNTerm] = useState("");
  const [nOp, setNOp] = useState(">");
  const [nValue, setNValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [e, t, n] = await Promise.all([
        listEdges(nestId),
        listEdgeTypes(nestId),
        listNodes(nestId).then((r) => r.nodes).catch(() => []),
      ]);
      setEdges(e);
      setTypes(t);
      setNodes(n);
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
      const condition =
        nWhen === "structured"
          ? { term: nTerm.trim(), op: nOp, value: isNaN(Number(nValue)) ? nValue.trim() : Number(nValue) }
          : nWhen === "nl"
            ? nIf.trim()
            : null;
      await createEdge(nestId, {
        from_node: nFrom.trim(),
        to_node: nTo.trim(),
        type: nType,
        condition_mode: nWhen || null,
        condition: nWhen ? condition : null,
      });
      setNTo("");
      setNIf("");
      setNTerm("");
      setNValue("");
      setNWhen("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add edge");
    } finally {
      setSaving(false);
    }
  };

  /** Open the composer pre-aimed at a source node (the per-step “+” button). */
  const composeFrom = (fromId: string) => {
    setNFrom(fromId);
    setComposerOpen(true);
  };

  const remove = async (id: string) => {
    try {
      await deleteEdge(nestId, id);
      setEdges((prev) => prev.filter((e) => e.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete edge");
    }
  };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const labelOf = (id: string) => byId.get(id)?.title || id.replace(/^nodes\//, "");
  const typeOf = (id: string) => byId.get(id)?.type;

  // Flow chains: every flow-type edge grouped under its starting node (a
  // source no flow edge points AT). Chains render depth-first; a shared
  // downstream doc renders under each of its parents (it's a DAG, so no
  // cycles — `seen` only guards duplicate expansion).
  const flowEdges = edges.filter((e) => e.type.is_flow);
  const refEdges = edges.filter((e) => !e.type.is_flow);
  const defaultFlowType = types.find((t) => t.is_flow)?.name;
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const e of flowEdges) {
    if (!outgoing.has(e.from_node)) outgoing.set(e.from_node, []);
    outgoing.get(e.from_node)!.push(e);
  }
  const hasIncoming = new Set(flowEdges.map((e) => e.to_node));
  const roots = [...outgoing.keys()].filter((k) => !hasIncoming.has(k)).sort();

  // Agents first in the pickers — they're what flows start from.
  const nodeOptions = [...nodes].sort((a, b) => {
    const rank = (n: { type?: string }) =>
      n.type === "agent" ? 0 : n.type === "skill" ? 1 : 2;
    return (
      rank(a) - rank(b) ||
      String(a.title || a.id).localeCompare(String(b.title || b.id))
    );
  });

  const renderChain = (id: string, depth: number, seen: Set<string>) => {
    const rows: React.ReactNode[] = [];
    for (const e of outgoing.get(id) ?? []) {
      rows.push(
        <div
          key={e.id}
          className="flex items-center gap-2 py-1 rounded px-1 -mx-1 hover:bg-muted/40 group"
          style={{ marginLeft: `${depth * 1.5}rem` }}
        >
          <CornerDownRight className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
          <ConditionPill edge={e} />
          <ArrowRight className="h-3 w-3 text-muted-foreground/50 shrink-0" />
          <TypeGlyph type={typeOf(e.to_node)} />
          <span className="text-sm truncate" title={e.to_node}>
            {labelOf(e.to_node)}
          </span>
          {e.type.name !== defaultFlowType && (
            <span className="text-[10px] text-muted-foreground shrink-0">
              ({e.type.name})
            </span>
          )}
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100 text-muted-foreground"
            onClick={() => composeFrom(e.to_node)}
            title="Add a step after this document"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
            onClick={() => void remove(e.id)}
            title="Remove this step"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>,
      );
      if (!seen.has(e.to_node)) {
        seen.add(e.to_node);
        rows.push(...renderChain(e.to_node, depth + 1, seen));
      }
    }
    return rows;
  };

  const composer = (
    <div className="rounded-lg border bg-muted/20 p-3" id="wf-composer">
      <div className="text-xs font-medium mb-2">Connect two documents</div>
      <div className="flex items-center flex-wrap gap-2">
        <select
          value={nFrom}
          onChange={(e) => setNFrom(e.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-sm max-w-[220px]"
          data-testid="wf-compose-from"
        >
          <option value="">When this runs…</option>
          {nodeOptions.map((n) => (
            <option key={n.id} value={n.id}>
              {n.type === "agent" ? "🤖 " : n.type === "skill" ? "⚡ " : ""}
              {n.title || n.id}
            </option>
          ))}
        </select>
        <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
        {/* When does the step fire? Chips, not a mode dropdown. */}
        <div className="flex items-center rounded-md border h-8 text-xs overflow-hidden">
          {(
            [
              ["", "always"],
              ["nl", "if…"],
              ["structured", "metric"],
            ] as const
          ).map(([mode, label], i) => (
            <button
              key={mode}
              type="button"
              className={`px-2.5 h-full ${i > 0 ? "border-l" : ""} ${
                nWhen === mode
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted"
              }`}
              onClick={() => setNWhen(mode)}
            >
              {label}
            </button>
          ))}
        </div>
        {nWhen === "nl" && (
          <Input
            value={nIf}
            onChange={(e) => setNIf(e.target.value)}
            placeholder='e.g. "lost on price, not product"'
            className="h-8 text-sm italic w-60"
            title="An AI judges this plain-English rule against the run's context"
          />
        )}
        {nWhen === "structured" && (
          <span className="flex items-center gap-1">
            <Input
              value={nTerm}
              onChange={(e) => setNTerm(e.target.value)}
              placeholder="CAC"
              className="h-8 text-sm w-24 font-mono"
              title="A term from your governed definitions"
            />
            <select
              value={nOp}
              onChange={(e) => setNOp(e.target.value)}
              className="h-8 rounded-md border bg-background px-1.5 text-sm font-mono"
            >
              {[">", "<", ">=", "<=", "=", "!="].map((op) => (
                <option key={op} value={op}>{op}</option>
              ))}
            </select>
            <Input
              value={nValue}
              onChange={(e) => setNValue(e.target.value)}
              placeholder="500"
              className="h-8 text-sm w-20 font-mono"
            />
          </span>
        )}
        <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
        <select
          value={nTo}
          onChange={(e) => setNTo(e.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-sm max-w-[220px]"
          data-testid="wf-compose-to"
        >
          <option value="">…continue to</option>
          {nodeOptions.map((n) => (
            <option key={n.id} value={n.id}>
              {n.type === "agent" ? "🤖 " : n.type === "skill" ? "⚡ " : ""}
              {n.title || n.id}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          className="h-8"
          disabled={saving || !nFrom || !nTo || (nWhen === "nl" && !nIf.trim()) || (nWhen === "structured" && !nTerm.trim())}
          onClick={() => void addRow()}
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="h-3.5 w-3.5 mr-1" />
          )}
          Add step
        </Button>
        {/* Edge type stays available but out of the way — "next" is right
            for flow steps; reference types annotate the ontology. */}
        <select
          value={nType}
          onChange={(e) => setNType(e.target.value)}
          className="h-8 rounded-md border bg-background px-1.5 text-xs text-muted-foreground ml-auto"
          title="Edge type — flow types (▶) are walked by the runner; others are reference links"
        >
          {types.map((t) => (
            <option key={t.id} value={t.name}>
              {t.is_flow ? "▶ " : ""}
              {t.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted-foreground">
          Each card is a flow the runner can walk, starting from its top node.
        </p>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin inline" />
        </div>
      ) : roots.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p className="text-sm font-medium mb-1">No flows yet</p>
          <p className="text-xs text-muted-foreground max-w-md mx-auto">
            A flow is a chain of steps: an <b>agent</b> runs, and each
            connection says what happens next — always, when an AI judges a
            rule true, or when a metric crosses a threshold. Connect your
            first two documents below.
          </p>
        </div>
      ) : (
        roots.map((rootId) => (
          <div key={rootId} className="rounded-lg border p-3">
            <div className="flex items-center gap-2 mb-2">
              <TypeGlyph type={typeOf(rootId)} />
              <span className="font-medium text-sm truncate" title={rootId}>
                {labelOf(rootId)}
              </span>
              <Badge variant="secondary" className="text-[10px]">
                {typeOf(rootId) === "agent" ? "agent · start" : "start"}
              </Badge>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                onClick={() => composeFrom(rootId)}
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Step
              </Button>
            </div>
            {renderChain(rootId, 0, new Set([rootId]))}
          </div>
        ))
      )}

      {(composerOpen || roots.length === 0 || refEdges.length + flowEdges.length === 0) ? (
        composer
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setComposerOpen(true)}
        >
          <Plus className="h-3.5 w-3.5 mr-1" /> Connect documents
        </Button>
      )}

      {refEdges.length > 0 && (
        <details className="rounded-lg border px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none">
            Reference links ({refEdges.length}) — ontology edges the runner
            doesn't walk
          </summary>
          <div className="mt-2 space-y-1">
            {refEdges.map((e) => (
              <div key={e.id} className="flex items-center gap-2 text-sm group">
                <TypeGlyph type={typeOf(e.from_node)} />
                <span className="truncate" title={e.from_node}>{labelOf(e.from_node)}</span>
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] text-muted-foreground border"
                  style={{ borderColor: e.type.color ?? undefined }}
                >
                  {e.type.name}
                </span>
                <TypeGlyph type={typeOf(e.to_node)} />
                <span className="truncate" title={e.to_node}>{labelOf(e.to_node)}</span>
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                  onClick={() => void remove(e.id)}
                  title="Delete link"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </details>
      )}

      <p className="text-[11px] text-muted-foreground">
        <b>always</b> = the step fires whenever the previous one runs ·{" "}
        <b>if…</b> = an AI judges a plain-English rule against the run's
        context · <b>metric</b> = a deterministic check like{" "}
        <code>CAC &gt; 500</code>, resolved from your governed terms.
      </p>
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

        <details className="mb-3 rounded-md border bg-muted/30 px-3 py-2 text-[11px]">
          <summary className="cursor-pointer font-medium">
            How do I run one? (the runner is a separate process)
          </summary>
          <div className="mt-2 space-y-1.5 text-muted-foreground">
            <p>
              The <b>trigger</b> button just records a run. The{" "}
              <b>runner</b> is a small stateless container that actually walks
              it and calls the LLM. Point it at this nest:
            </p>
            <pre className="overflow-x-auto rounded bg-background border p-2 font-mono text-[10.5px] leading-relaxed">
{`docker run --rm --network host \\
  -e CONTEXTNEST_SERVER=http://localhost:4040 \\
  -e CONTEXTNEST_NEST=${nestId} \\
  -e CONTEXTNEST_KEY=cnst_localdev \\
  -e ANTHROPIC_API_KEY=sk-ant-... \\
  contextnest-runner:local run <agent-node-id>`}
            </pre>
            <p>
              Or run <code>schedule</code> instead of <code>run</code> to poll
              this nest continuously. Steps stream back into the trace on the
              right — refresh to watch.
            </p>
          </div>
        </details>

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
