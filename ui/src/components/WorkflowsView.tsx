import { useEffect, useState, useCallback } from "react";
import type React from "react";
import { formatServerDate } from "../lib/dates";
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
  Clock3,
  Wrench,
  Table2,
  X,
} from "lucide-react";
import {
  listEdges,
  listEdgeTypes,
  createEdge,
  updateEdge,
  deleteEdge,
  listRuns,
  getRun,
  triggerRun,
  cancelRun,
  isQueued,
  listNodes,
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  queryContext,
  listNodeWatchers,
  addNodeWatcher,
  removeNodeWatcher,
  listEnv,
  putEnv,
  deleteEnv,
  getHealth,
  listHooks,
  createHook,
  deleteHook,
  listConnectors,
  createConnector,
  updateConnector,
  deleteConnector,
  type EnvEntry,
  type TriggerHook,
  type Connector,
  type WorkflowEdge,
  type EdgeType,
  type RunSummary,
  type RunDetail,
  type RunStep,
  type Schedule,
} from "../lib/api";
import { copyTextWithToast } from "../lib/clipboard";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { Input } from "./ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select";
import { useAuth } from "../auth/AuthContext";
import { NodeTypeIcon } from "./NestView";
import { NestPageHeader } from "./NestPageHeader";

interface Props {
  nestId: string;
  nestName: string;
  onBack: () => void;
}

const statusVariant = (
  s: string,
): "default" | "secondary" | "destructive" | "outline" => {
  if (s === "succeeded") return "default";
  if (s === "failed" || s === "cancelled") return "destructive";
  if (s === "queued") return "outline";
  return "secondary"; // running
};

// The wire status is "running" from creation; a run is only really executing
// once a runner has claimed it, so show the unclaimed stretch as "queued".
const runStatus = (r: Pick<RunSummary, "status" | "claimed_by">) =>
  isQueued(r) ? "queued" : r.status;
const QUEUED_HINT = "Created — waiting for a runner to claim it";

// The step-log icon mirrors the run-trace prototype's read/branch/write/notify.
const stepIcon = (action: string) => {
  if (action === "read") return <BookOpen className="h-3.5 w-3.5" />;
  if (action === "branch") return <Zap className="h-3.5 w-3.5" />;
  if (action === "write") return <Pencil className="h-3.5 w-3.5" />;
  if (action === "notify") return <Bell className="h-3.5 w-3.5" />;
  return <span className="h-3.5 w-3.5" />;
};

const timeOf = (iso: string) => formatServerDate(iso) || iso;

export function WorkflowsView({ nestId, nestName, onBack }: Props) {
  const [tab, setTab] = useState("canvas");

  return (
    <div>
      <NestPageHeader nestName={nestName} onBack={onBack} />

      {/* One mental model, four views of it: the CANVAS is the workflow
          itself (structure + per-wire conditions), the TABLE is the same
          graph as a readable list (grouped flows + composer), RUN is
          on-demand execution (trigger an agent → run log → replayable
          trace), and ACTIVITY is the standing setup around runs — key,
          schedules, connectors, tool env. Run split out from Activity so
          "run it now" doesn't collide with the schedule/config in one
          scroll. */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="canvas">Canvas</TabsTrigger>
          <TabsTrigger value="table">Table</TabsTrigger>
          <TabsTrigger value="run">Run</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="canvas" className="mt-4">
          <CanvasPanel nestId={nestId} />
        </TabsContent>
        <TabsContent value="table" className="mt-4">
          <EdgesPanel nestId={nestId} />
        </TabsContent>
        <TabsContent value="run" className="mt-4">
          <RunsPanel nestId={nestId} />
        </TabsContent>
        <TabsContent value="activity" className="mt-4 space-y-6">
          <RunnerKeyCallout nestId={nestId} />
          <SchedulesPanel nestId={nestId} />
          <ConnectorsPanel nestId={nestId} />
          <EnvPanel nestId={nestId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Shared glyphs ───────────────────────────────────────────────────────

/** Small type glyph reused across flow rows; mirrors NodeTypeIcon colors. */
function TypeGlyph({ type }: { type?: string }) {
  if (type === "agent") return <Bot className="h-3.5 w-3.5 text-violet-500 shrink-0" />;
  if (type === "skill") return <Zap className="h-3.5 w-3.5 text-blue-500 shrink-0" />;
  if (type === "artifact") return <FileCode2 className="h-3.5 w-3.5 text-amber-500 shrink-0" />;
  if (type === "tool") return <Wrench className="h-3.5 w-3.5 text-teal-500 shrink-0" />;
  if (type === "table") return <Table2 className="h-3.5 w-3.5 text-cyan-500 shrink-0" />;
  return <FileText className="h-3.5 w-3.5 text-slate-400 shrink-0" />;
}

// ─── Table: the flows list — the spreadsheet twin of the canvas ─────────

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
    const dup = edges.find(
      (e) =>
        e.from_node === nFrom.trim() &&
        e.to_node === nTo.trim() &&
        e.type.name === nType,
    );
    if (dup) {
      setError(
        `${labelOf(dup.from_node)} → ${labelOf(dup.to_node)} is already connected with "${nType}".`,
      );
      return;
    }
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
              className={`px-2.5 h-full ${i > 0 ? "border-l" : ""} ${nWhen === mode
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

// Fallback caps if /health hasn't loaded yet — the LIVE values come from the
// server via useAuth (subagentMaxDepth/Children), so an operator's env
// override (config.ts) stays in sync with the pickers. Root runs are depth 0,
// so a run already at the depth cap can't parent a deeper child, and one at
// the fan-out cap can't parent another; both — plus the re-entrancy (loop)
// rule — are surfaced up front instead of failing only after submit.
const SUBAGENT_MAX_DEPTH_FALLBACK = 8;
const SUBAGENT_MAX_CHILDREN_FALLBACK = 16;

/**
 * Agent/skill picker that renders the SAME type icon as the document list
 * (NodeTypeIcon) in each option — a native <select> can't hold an SVG, so
 * this uses the Radix Select. Empty value shows the placeholder.
 */
function AgentSelect({
  value,
  onValueChange,
  runnables,
  placeholder,
  testId,
  disabledReason,
}: {
  value: string;
  onValueChange: (v: string) => void;
  runnables: Array<{ id: string; title?: string; type?: string }>;
  placeholder: string;
  testId?: string;
  /** Return a short reason to grey an agent out (e.g. re-entrancy), else null. */
  disabledReason?: (id: string) => string | null;
}) {
  return (
    <Select value={value || undefined} onValueChange={onValueChange}>
      <SelectTrigger className="h-9 w-full" data-testid={testId} disabled={!runnables.length}>
        <SelectValue placeholder={runnables.length ? placeholder : "No runnable agents yet"} />
      </SelectTrigger>
      <SelectContent>
        {runnables.map((n) => {
          const reason = disabledReason?.(n.id) ?? null;
          return (
            <SelectItem key={n.id} value={n.id} disabled={!!reason}>
              <span className="flex items-center gap-2">
                <NodeTypeIcon type={n.type} className="h-3.5 w-3.5" />
                {n.title || n.id}
                {reason && (
                  <span className="text-[10px] text-muted-foreground">— {reason}</span>
                )}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

/**
 * Parent-run picker for the Trigger form. A native <select> can't show the
 * type icon, a badge, or two lines, so this uses the Radix Select:
 *   line 1:  <icon> <agent name>  <run id>  [reason badge]
 *   line 2:  depth D → D+1 · <start time>
 * The start time + id disambiguate several running runs of the same agent.
 * Ineligible parents (depth/fan-out/loop) render disabled with the reason.
 */
function ParentSelect({
  value,
  onValueChange,
  runs,
  runLabel,
  runType,
  blockedReason,
}: {
  value: string;
  onValueChange: (v: string) => void;
  runs: RunSummary[];
  runLabel: (id: string) => string;
  runType: (id: string) => string | undefined;
  blockedReason: (r: RunSummary) => string | null;
}) {
  const NONE = "__none__";
  const running = runs.filter((r) => r.status === "running");
  return (
    <Select value={value || NONE} onValueChange={(v) => onValueChange(v === NONE ? "" : v)}>
      <SelectTrigger className="h-auto min-h-9 w-full" data-testid="run-parent-lookup">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>— None (top-level run)</SelectItem>
        {running.map((r) => {
          const reason = blockedReason(r);
          const d = r.depth ?? 0;
          return (
            <SelectItem key={r.id} value={r.id} disabled={!!reason}>
              <span className="flex flex-col gap-0.5 py-0.5">
                <span className="flex items-center gap-1.5">
                  <NodeTypeIcon type={runType(r.agent_node)} className="h-3.5 w-3.5" />
                  <span className="font-medium">{runLabel(r.agent_node)}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {r.id.replace(/^run_/, "").slice(0, 8)}
                  </span>
                  {reason && (
                    <Badge variant="outline" className="text-[10px]">
                      {reason}
                    </Badge>
                  )}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  depth {d} → {d + 1} · {timeOf(r.started_at)}
                </span>
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function RunsPanel({ nestId }: { nestId: string }) {
  const { subagentRunsEnabled, subagentMaxDepth, subagentMaxChildren } = useAuth();
  // Live server caps (fall back to defaults until /health resolves).
  const maxDepth = subagentMaxDepth || SUBAGENT_MAX_DEPTH_FALLBACK;
  const maxChildren = subagentMaxChildren || SUBAGENT_MAX_CHILDREN_FALLBACK;
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [triggerNode, setTriggerNode] = useState("");
  const [triggering, setTriggering] = useState(false);
  const [triggerInputs, setTriggerInputs] = useState("");
  // Optional parent in the top form → spawn a top-level trigger as a
  // sub-agent under a running run (only offered when the feature is on).
  const [triggerParent, setTriggerParent] = useState("");
  // Inline sub-agent spawn: which run row's spawn form is open, plus its
  // own agent/inputs draft. Lives on the row (like a version-list action),
  // not the top form — there can be many running runs to parent under.
  const [spawnParent, setSpawnParent] = useState("");
  const [spawnAgent, setSpawnAgent] = useState("");
  const [spawnInputs, setSpawnInputs] = useState("");
  const [spawning, setSpawning] = useState(false);
  // Spawn errors render inline in the row form (the top card's error banner
  // is off-screen when the user is spawning from a deep row).
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [nodes, setNodes] = useState<Array<{ id: string; title?: string; type?: string }>>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, n] = await Promise.all([
        // Wider window (server clamps to 500) so childCount/chainAgents see
        // more of the tree — the eligibility checks derive from this list.
        listRuns(nestId, undefined, 500),
        listNodes(nestId).then((x) => x.nodes).catch(() => []),
      ]);
      setRuns(r);
      setNodes(n);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load runs");
    } finally {
      setLoading(false);
    }
  }, [nestId]);

  const runnables = nodes.filter((n) => n.type === "agent" || n.type === "skill");

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

  // Cancel a queued/running run. The server rejects a PATCH once terminal, so
  // a stale row just surfaces that conflict instead of silently reopening.
  const cancel = async (id: string) => {
    setCancelling(id);
    try {
      await cancelRun(id);
      await load();
      if (selected?.id === id) await open(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel run");
    } finally {
      setCancelling(null);
    }
  };

  // Inputs: JSON object if it parses as one, otherwise wrapped prose — either
  // way the bundle carries it and conditions/vars can read it.
  const parseInputs = (raw: string): Record<string, unknown> | undefined => {
    const t = raw.trim();
    if (!t) return undefined;
    try {
      const parsed = JSON.parse(t);
      return typeof parsed === "object" && parsed !== null ? parsed : { input: parsed };
    } catch {
      return { input: t };
    }
  };

  const trigger = async () => {
    if (!triggerNode.trim()) return;
    setTriggering(true);
    try {
      await triggerRun(
        nestId,
        triggerNode.trim(),
        parseInputs(triggerInputs),
        triggerParent || undefined,
      );
      setTriggerNode("");
      setTriggerInputs("");
      setTriggerParent("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to trigger run");
    } finally {
      setTriggering(false);
    }
  };

  // Spawn a sub-agent under a specific running run (the row action). Errors
  // land in spawnError so they show inline, right at the form.
  const spawnSub = async (parentId: string) => {
    if (!spawnAgent.trim()) return;
    setSpawning(true);
    setSpawnError(null);
    try {
      await triggerRun(nestId, spawnAgent.trim(), parseInputs(spawnInputs), parentId);
      setSpawnParent("");
      setSpawnAgent("");
      setSpawnInputs("");
      await load();
    } catch (err) {
      setSpawnError(err instanceof Error ? err.message : "Failed to spawn sub-agent");
    } finally {
      setSpawning(false);
    }
  };

  // Runs are a call tree, not a flat log: a run can spawn sub-agent children
  // (parent_run_id / depth). Group children under their parent so the
  // sub-agent flow reads as the tree it is. Roots = runs with no parent (or
  // whose parent isn't in this page). Order stays started_at DESC.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const runLabel = (id: string) => byId.get(id)?.title || id.replace(/^nodes\//, "");
  const runType = (id: string) => byId.get(id)?.type;
  const childrenOf = new Map<string, RunSummary[]>();
  const knownIds = new Set(runs.map((r) => r.id));
  const roots: RunSummary[] = [];
  for (const r of runs) {
    if (r.parent_run_id && knownIds.has(r.parent_run_id)) {
      if (!childrenOf.has(r.parent_run_id)) childrenOf.set(r.parent_run_id, []);
      childrenOf.get(r.parent_run_id)!.push(r);
    } else {
      roots.push(r);
    }
  }

  // Eligibility, computed client-side so the pickers grey out ineligible
  // choices BEFORE submit (mirrors the server's resolveParentRun guards).
  // Caveat: this is derived from the loaded run window (up to 500), NOT the
  // full nest history — in a very busy nest childCount may undercount and an
  // ancestor may fall outside the window, so these checks are ADVISORY. The
  // server (unbounded COUNT / ancestor walk) is the authoritative guard; if a
  // stale check slips through, the spawn just fails inline instead of silently.
  const runById = new Map(runs.map((r) => [r.id, r]));
  const childCount = (runId: string) => childrenOf.get(runId)?.length ?? 0;
  // Agent nodes in a run's own node + every ancestor — the re-entrancy set.
  // Spawning an agent already in here would create a cycle (server rejects).
  // `break` on a missing ancestor = window edge; the server still catches it.
  const chainAgents = (runId: string): Set<string> => {
    const set = new Set<string>();
    let cur: string | null = runId;
    for (let i = 0; cur && i <= maxDepth + 1; i++) {
      const r = runById.get(cur);
      if (!r) break;
      set.add(r.agent_node);
      cur = r.parent_run_id ?? null;
    }
    return set;
  };
  // Why a run can't parent a NEW child of `childAgent` ("" = agent not chosen
  // yet, so only parent-side caps are checked). null = eligible.
  const parentBlockedReason = (p: RunSummary, childAgent: string): string | null => {
    if ((p.depth ?? 0) >= maxDepth) return "at max depth";
    if (childCount(p.id) >= maxChildren)
      return `${maxChildren}/${maxChildren} full`;
    if (childAgent && chainAgents(p.id).has(childAgent)) return "would loop";
    return null;
  };
  // The currently-picked form parent, and why it's blocked (if it is) for the
  // currently-picked agent — drives the inline hint + Create-button guard.
  const selectedParent = triggerParent ? runById.get(triggerParent) ?? null : null;
  const triggerParentReason = selectedParent
    ? parentBlockedReason(selectedParent, triggerNode)
    : null;

  const renderRun = (r: RunSummary, level: number): React.ReactNode => {
    const kids = childrenOf.get(r.id) ?? [];
    const indent = level ? `${0.75 + level * 1.1}rem` : undefined;
    // Depth badges below prefer the server's `r.depth` and fall back to render
    // `level` only if it's missing. These can differ when a run's parent is
    // outside the loaded window (rendered as a root at level 0 though its true
    // depth is higher) — the server value is authoritative; `level` is a
    // last-resort label for that window-edge case.
    return (
      <div key={r.id}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => void open(r.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") void open(r.id);
          }}
          className={`group w-full cursor-pointer px-3 py-2 hover:bg-muted/40 ${selected?.id === r.id ? "bg-muted/60" : ""
            }`}
          style={{ paddingLeft: indent }}
        >
          <div className="flex items-center gap-2">
            {level > 0 && (
              <CornerDownRight className="h-3 w-3 text-muted-foreground/50 shrink-0" />
            )}
            <NodeTypeIcon type={runType(r.agent_node)} className="h-3.5 w-3.5" />
            <span className="font-mono text-xs truncate">
              {r.id.slice(0, 12)}
            </span>
            <Badge
              variant={statusVariant(runStatus(r))}
              className="text-[10px]"
              title={isQueued(r) ? QUEUED_HINT : undefined}
            >
              {runStatus(r)}
            </Badge>
            {level > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] shrink-0"
                title={`Sub-agent at depth ${r.depth ?? level}`}
              >
                sub · d{r.depth ?? level}
              </Badge>
            )}
            {kids.length > 0 && (
              <span className="text-[10px] text-muted-foreground shrink-0" title="Sub-agents spawned">
                {kids.length} child{kids.length === 1 ? "" : "ren"}
              </span>
            )}
            {/* Row actions — one right-aligned group, revealed on hover.
                Sub-agent: only running runs can parent one; hidden when the
                feature is off or this run is at the depth / fan-out cap (a
                deeper/wider child would be rejected server-side).
                Cancel: the only way out of a run no runner ever claims. */}
            {r.status === "running" && (
              <div className="ml-auto flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                {subagentRunsEnabled &&
                  (r.depth ?? 0) < maxDepth &&
                  childCount(r.id) < maxChildren && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px] text-muted-foreground"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSpawnParent(spawnParent === r.id ? "" : r.id);
                        setSpawnAgent("");
                        setSpawnInputs("");
                        setSpawnError(null);
                      }}
                      title="Spawn a sub-agent nested under this run"
                    >
                      <Plus className="h-3 w-3 mr-1" /> sub-agent
                    </Button>
                  )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                  disabled={cancelling === r.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    void cancel(r.id);
                  }}
                  title="Cancel this run"
                >
                  {cancelling === r.id ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <X className="h-3 w-3 mr-1" />
                  )}
                  cancel
                </Button>
              </div>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">
            {runLabel(r.agent_node)} · {timeOf(r.started_at)}
          </div>
          {r.status === "failed" && r.trace?.error && (
            <div
              className="text-[11px] text-destructive truncate mt-0.5"
              title={String(r.trace.error)}
            >
              {String(r.trace.error).replace(/^\d+ /, "").slice(0, 110)}
            </div>
          )}
        </div>

        {/* Inline spawn form for this run — agent + inputs, nested under it. */}
        {subagentRunsEnabled && spawnParent === r.id && (
          <div
            className="border-t bg-muted/20 px-3 py-2.5 space-y-2"
            style={{ paddingLeft: `${0.75 + (level + 1) * 1.1}rem` }}
          >
            <div className="text-[11px] font-medium text-muted-foreground">
              New sub-agent under{" "}
              <span className="font-mono">{r.id.slice(0, 12)}</span> —{" "}
              {runLabel(r.agent_node)} · depth {r.depth ?? level} → child depth{" "}
              {(r.depth ?? level) + 1}
            </div>
            <AgentSelect
              value={spawnAgent}
              onValueChange={setSpawnAgent}
              runnables={runnables}
              placeholder="Choose an agent…"
              testId="spawn-agent-lookup"
              disabledReason={(id) =>
                chainAgents(r.id).has(id) ? "already in this chain" : null
              }
            />
            <textarea
              value={spawnInputs}
              onChange={(e) => setSpawnInputs(e.target.value)}
              placeholder='Inputs (optional) — plain text or JSON'
              className="w-full rounded-md border bg-background px-2 py-1.5 text-xs font-mono min-h-[44px]"
            />
            {spawnError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
                {spawnError}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="h-7"
                disabled={spawning || !spawnAgent.trim()}
                onClick={() => void spawnSub(r.id)}
              >
                {spawning ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : (
                  <Plus className="h-3.5 w-3.5 mr-1" />
                )}
                Create sub-agent
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7"
                onClick={() => {
                  setSpawnParent("");
                  setSpawnError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {kids.map((k) => renderRun(k, level + 1))}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Trigger a run — full-width form card at the top: a top-level run
          (agent + inputs). Sub-agents are spawned per-row from the list
          below, since there can be many running runs to parent under. */}
      <div className="rounded-lg border p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Trigger a run</h3>
          <p className="text-xs text-muted-foreground">
            Creates a run record + bundle (inputs ride along). The server
            never executes — a runner (the contextnest-runner) walks the
            bundle and posts each step back into the trace below.
          </p>
        </div>

        <div>
          <label className="block text-[11px] font-medium text-muted-foreground mb-1">
            Agent / skill node
          </label>
          {/* Agent lookup, not a raw node-id field — pick from the nest's
              runnable nodes. Same type icon as the document list. */}
          <AgentSelect
            value={triggerNode}
            onValueChange={setTriggerNode}
            runnables={runnables}
            placeholder="Choose an agent to run…"
            testId="run-agent-lookup"
          />
        </div>

        {/* Optional parent → make this a sub-agent under a running run.
            Only offered when the sub-agent feature is on. Running runs only
            (the backend rejects closed parents). Per-row spawn stays too. */}
        {subagentRunsEnabled && (
          <div>
            <label className="block text-[11px] font-medium text-muted-foreground mb-1">
              Parent run (optional — spawn as a sub-agent)
            </label>
            <ParentSelect
              value={triggerParent}
              onValueChange={setTriggerParent}
              runs={runs}
              runLabel={runLabel}
              runType={runType}
              blockedReason={(r) => parentBlockedReason(r, triggerNode)}
            />
            {triggerParentReason && (
              <p className="text-[11px] text-destructive mt-1">
                This parent can't be used ({triggerParentReason}) — pick another
                or change the agent.
              </p>
            )}
          </div>
        )}

        <div>
          <label className="block text-[11px] font-medium text-muted-foreground mb-1">
            Inputs (optional — plain text or JSON)
          </label>
          <textarea
            value={triggerInputs}
            onChange={(e) => setTriggerInputs(e.target.value)}
            placeholder='e.g. {"account":"Foley"}'
            className="w-full rounded-md border bg-background px-2 py-1.5 text-xs font-mono min-h-[64px]"
          />
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button
            disabled={triggering || !triggerNode.trim() || !!triggerParentReason}
            onClick={() => void trigger()}
            title="Create a run (a runner executes it)"
          >
            {triggering ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5 mr-1.5" />
            )}
            Create run
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5 mr-1" /> Refresh
          </Button>
        </div>

        <details className="rounded-md border bg-muted/30 px-3 py-2 text-[11px]">
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
              {`docker run -d --name cn-runner --network host \\
  -e CONTEXTNEST_SERVER=http://localhost:4040 \\
  -e CONTEXTNEST_NEST=${nestId} \\
  -e CONTEXTNEST_KEY=cnst_localdev \\
  contextnest-runner:local poll`}
            </pre>
            <p>
              <b>poll</b> claims every run this server creates (Schedule tab,
              Run buttons) and executes it — one standing container per nest.
              No Anthropic key flag needed: set{" "}
              <code>ANTHROPIC_API_KEY</code> in Activity → Tool environment
              and the runner picks it up from the run bundle. Steps stream
              back into the trace below — refresh to watch.
            </p>
          </div>
        </details>
      </div>

      {/* Run list + trace side by side, so the details stay visually tied to
          the selected row. Single column until there's a selection (and on
          narrow screens, where there's no room for two). */}
      <div
        className={`grid gap-4 items-start ${selected ? "lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]" : "grid-cols-1"
          }`}
      >
        <div className="rounded-lg border divide-y min-w-0">
          {loading ? (
            <div className="px-3 py-6 text-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin inline" />
            </div>
          ) : runs.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              No runs yet. Trigger an agent above.
            </div>
          ) : (
            roots.map((r) => renderRun(r, 0))
          )}
        </div>

        {/* Trace / editor — right-hand pane, appears when a run is selected. */}
        {selected && (
          <div className="rounded-lg border p-4 min-w-0 lg:sticky lg:top-4">
            <RunTrace
              run={selected}
              children={runs.filter((r) => r.parent_run_id === selected.id)}
              parent={
                selected.parent_run_id
                  ? runs.find((r) => r.id === selected.parent_run_id) ?? null
                  : null
              }
              label={runLabel}
              typeOf={runType}
              onOpen={(id) => void open(id)}
              onCancel={(id) => void cancel(id)}
              cancelling={cancelling === selected.id}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function RunTrace({
  run,
  children = [],
  parent = null,
  label = (id) => id,
  typeOf = () => undefined,
  onOpen,
  onCancel,
  cancelling = false,
}: {
  run: RunDetail;
  children?: RunSummary[];
  parent?: RunSummary | null;
  label?: (id: string) => string;
  typeOf?: (id: string) => string | undefined;
  onOpen?: (id: string) => void;
  onCancel?: (id: string) => void;
  cancelling?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <NodeTypeIcon type={typeOf(run.agent_node)} className="h-4 w-4" />
        <span className="font-mono text-sm">{run.id}</span>
        <Badge
          variant={statusVariant(runStatus(run))}
          title={isQueued(run) ? QUEUED_HINT : undefined}
        >
          {runStatus(run)}
        </Badge>
        {(run.depth ?? 0) > 0 && (
          <Badge variant="outline" className="text-[10px]">
            sub-agent · depth {run.depth}
          </Badge>
        )}
        {run.status === "running" && onCancel && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7"
            disabled={cancelling}
            onClick={() => onCancel(run.id)}
            title="Cancel this run"
          >
            {cancelling ? (
              <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
            ) : (
              <X className="h-3.5 w-3.5 mr-1" />
            )}
            Cancel run
          </Button>
        )}
      </div>
      <div className="text-xs text-muted-foreground mb-4">
        agent {label(run.agent_node)} · started {timeOf(run.started_at)}
        {run.finished_at ? ` · finished ${timeOf(run.finished_at)}` : ""} ·
        triggered by {run.triggered_by}
      </div>

      {parent && (
        <button
          type="button"
          onClick={() => onOpen?.(parent.id)}
          className="mb-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          title="Open the run that spawned this one"
        >
          <ArrowLeft className="h-3 w-3" /> Spawned by {label(parent.agent_node)}{" "}
          <span className="font-mono">({parent.id.slice(0, 8)})</span>
        </button>
      )}

      {children.length > 0 && (
        <div className="mb-4 rounded-md border bg-muted/20 p-2.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
            Sub-agents spawned ({children.length})
          </div>
          <div className="space-y-1">
            {children.map((k) => (
              <button
                key={k.id}
                type="button"
                onClick={() => onOpen?.(k.id)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-muted/50"
              >
                <CornerDownRight className="h-3 w-3 text-muted-foreground/50 shrink-0" />
                <NodeTypeIcon type={typeOf(k.agent_node)} className="h-3.5 w-3.5" />
                <span className="truncate">{label(k.agent_node)}</span>
                <Badge variant={statusVariant(runStatus(k))} className="text-[10px] shrink-0">
                  {runStatus(k)}
                </Badge>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground shrink-0">
                  {k.id.slice(0, 8)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {run.trace?.error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive font-mono break-all">
          {run.trace.error}
        </div>
      )}

      <div className="space-y-0">
        {run.steps.length === 0 ? (
          <div className="text-xs text-muted-foreground">
            {isQueued(run)
              ? "No steps yet — queued, waiting for a runner to claim it. Start a runner (see “How do I run one?” above) or cancel the run."
              : "No steps recorded."}
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

// ─── Canvas: the n8n-feel visual builder ─────────────────────────────────
//
// Ported from the workflow-canvas prototype: left→right auto-layout, node
// cards, colored bezier wires with condition labels, and a config panel on
// the right. The boxes are documents/agents, the wires are governed typed
// edges — not an operation palette. Drag from a node's right port onto
// another card to connect; click a wire or card to edit it in the panel.

interface CanvasNode {
  id: string;
  x: number;
  y: number;
}

const CARD_W = 168;
const CARD_H = 56;
const COL_GAP = 260;
const ROW_GAP = 100;
const PAD_X = 30;
const PAD_Y = 70;

function CanvasPanel({ nestId }: { nestId: string }) {
  const [edges, setEdges] = useState<WorkflowEdge[]>([]);
  const [types, setTypes] = useState<EdgeType[]>([]);
  const [nodes, setNodes] = useState<Array<{ id: string; title?: string; type?: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [selNode, setSelNode] = useState<string | null>(null);
  // Drag-to-connect ghost wire: source node + current pointer (svg coords).
  const [connect, setConnect] = useState<{ from: string; x: number; y: number } | null>(null);
  const svgRef = { current: null as SVGSVGElement | null };

  // Edge editor draft (config panel).
  const [eType, setEType] = useState("");
  const [eWhen, setEWhen] = useState<"" | "nl" | "structured">("");
  const [eIf, setEIf] = useState("");
  const [eTerm, setETerm] = useState("");
  const [eOp, setEOp] = useState(">");
  const [eValue, setEValue] = useState("");
  const [saving, setSaving] = useState(false);
  // Add-step target (node panel).
  const [stepTo, setStepTo] = useState("");
  // Node-panel extras: schedules, run-now feedback, ctx-command copy state.
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [schedEvery, setSchedEvery] = useState(60);
  const [runFeedback, setRunFeedback] = useState("");
  const [hops, setHops] = useState(1);
  const [copied, setCopied] = useState("");
  // Test-it-out: run the node's ctx query and show what a runner would read.
  const [preview, setPreview] = useState<{ text: string; nodes: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // Shelf search: find a doc/artifact by name, then drag its port to wire it.
  const [shelfSearch, setShelfSearch] = useState("");
  // HITL tags: people watching the selected node (notified on its output).
  const [watchers, setWatchers] = useState<string[]>([]);
  const [watcherEmail, setWatcherEmail] = useState("");
  // Inbound trigger hooks for the selected runnable node.
  const [nodeHooks, setNodeHooks] = useState<TriggerHook[]>([]);
  const [hookPreset, setHookPreset] = useState<TriggerHook["preset"]>("slack");
  // Full trigger URLs are revealed exactly once, at creation (API-key
  // semantics) — cache them for this session so copy keeps working.
  const [revealedHookUrls, setRevealedHookUrls] = useState<Record<string, string>>({});
  // Actual visible width of the scroll viewport, measured — the shelf reflows
  // to this so cards never clip under the config panel at the default view.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [canvasW, setCanvasW] = useState(0);
  useEffect(() => {
    if (!scrollEl) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w) setCanvasW(w);
    });
    ro.observe(scrollEl);
    setCanvasW(scrollEl.clientWidth);
    return () => ro.disconnect();
  }, [scrollEl]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [e, t, n, s] = await Promise.all([
        listEdges(nestId),
        listEdgeTypes(nestId),
        listNodes(nestId).then((r) => r.nodes).catch(() => []),
        listSchedules(nestId).catch(() => []),
      ]);
      setEdges(e);
      setTypes(t);
      setNodes(n);
      setSchedules(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load canvas");
    } finally {
      setLoading(false);
    }
  }, [nestId]);

  useEffect(() => {
    if (!selNode) return;
    let cancelled = false;
    listNodeWatchers(nestId, selNode)
      .then((w) => !cancelled && setWatchers(w.map((x) => x.user_email)))
      .catch(() => !cancelled && setWatchers([]));
    listHooks(nestId, selNode)
      .then((h) => !cancelled && setNodeHooks(h))
      .catch(() => !cancelled && setNodeHooks([]));
    return () => {
      cancelled = true;
    };
  }, [nestId, selNode]);

  const copy = (key: string, text: string) => {
    void copyTextWithToast(text).then((ok) => {
      if (!ok) return;
      setCopied(key);
      setTimeout(() => setCopied(""), 1500);
    });
  };

  useEffect(() => {
    void load();
  }, [load]);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const labelOf = (id: string) => byId.get(id)?.title || id.replace(/^nodes\//, "");
  const typeOf = (id: string) => byId.get(id)?.type;

  // Layout: longest-path layering over flow edges (left→right), then stack
  // each column. Reference-edge-only nodes sit in the column their neighbors
  // suggest (fallback 0).
  const flowEdges = edges.filter((e) => e.type.is_flow);
  const placed = new Map<string, CanvasNode>();
  {
    const ids = new Set<string>();
    for (const e of edges) {
      ids.add(e.from_node);
      ids.add(e.to_node);
    }
    const depth = new Map<string, number>();
    const incoming = new Set(flowEdges.map((e) => e.to_node));
    const queue: string[] = [...ids].filter((id) => !incoming.has(id)).sort();
    for (const id of queue) depth.set(id, 0);
    // Longest-path relaxation; flow graph is a DAG so this terminates.
    for (let pass = 0; pass < ids.size; pass++) {
      let changed = false;
      for (const e of flowEdges) {
        const d = (depth.get(e.from_node) ?? 0) + 1;
        if (d > (depth.get(e.to_node) ?? 0)) {
          depth.set(e.to_node, d);
          changed = true;
        }
      }
      if (!changed) break;
    }
    const cols = new Map<number, string[]>();
    for (const id of [...ids].sort((a, b) => String(labelOf(a)).localeCompare(labelOf(b)))) {
      const d = depth.get(id) ?? 0;
      if (!cols.has(d)) cols.set(d, []);
      cols.get(d)!.push(id);
    }
    for (const [d, colIds] of cols) {
      colIds.forEach((id, i) => {
        placed.set(id, { id, x: PAD_X + d * COL_GAP, y: PAD_Y + i * ROW_GAP });
      });
    }
  }
  // Intrinsic width the flow graph itself needs (no fixed floor); the shelf
  // reflows on top of this and the SVG grows to whichever is wider.
  const flowGraphWidth = PAD_X * 2 + (Math.max(0, ...[...placed.values()].map((p) => p.x)) + CARD_W + 60);
  const flowHeight = Math.max(300, PAD_Y + (Math.max(-PAD_Y + 40, ...[...placed.values()].map((p) => p.y)) + CARD_H + 40));

  // Shelf: every doc NOT yet wired into any edge, laid out as a grid below a
  // divider. Same cards, same out-ports — so the FIRST edge is a drag on the
  // canvas too, no detour through the Flows tab. The search box narrows the
  // shelf (find the artifact, then drag it onto a card).
  const q = shelfSearch.trim().toLowerCase();
  const shelfIds = nodes
    .map((n) => n.id)
    .filter((id) => !placed.has(id))
    .filter(
      (id) => !q || labelOf(id).toLowerCase().includes(q) || id.toLowerCase().includes(q),
    )
    .sort((a, b) => {
      const rank = (id: string) =>
        typeOf(id) === "agent" ? 0 : typeOf(id) === "skill" ? 1 : 2;
      return rank(a) - rank(b) || labelOf(a).localeCompare(labelOf(b));
    });
  const shelfTop = flowHeight + 46;
  // Reflow to the measured viewport width, not a fixed assumed one — so the
  // rightmost cards don't clip under the config panel. Only exceed the
  // viewport when the flow graph genuinely needs it (scroll then is intended).
  const layoutWidth = Math.max(flowGraphWidth, canvasW > 0 ? Math.floor(canvasW) : 920);
  const perRow = Math.max(1, Math.floor((layoutWidth - PAD_X * 2) / (CARD_W + 46)));
  shelfIds.forEach((id, i) => {
    placed.set(id, {
      id,
      x: PAD_X + (i % perRow) * (CARD_W + 46),
      y: shelfTop + Math.floor(i / perRow) * (CARD_H + 28),
    });
  });
  const width = layoutWidth;
  const height = shelfIds.length
    ? shelfTop + Math.ceil(shelfIds.length / perRow) * (CARD_H + 28) + 30
    : flowHeight + 20;

  const portOf = (id: string, side: "out" | "in") => {
    const p = placed.get(id);
    if (!p) return { x: 0, y: 0 };
    return { x: side === "out" ? p.x + CARD_W : p.x, y: p.y + CARD_H / 2 };
  };

  // `bow` pushes the curve's midpoint this many px off the straight run — how
  // parallel edges (same pair, different type) stay individually readable
  // instead of stacking into one wire with overprinted labels. Control points
  // move 4/3 × bow because a cubic's midpoint travels 3/4 of that.
  const wirePath = (from: string, to: string, bow = 0) => {
    const a = portOf(from, "out");
    const b = portOf(to, "in");
    const dx = Math.max(40, (b.x - a.x) / 2);
    const k = (bow * 4) / 3;
    return `M${a.x},${a.y} C${a.x + dx},${a.y + k} ${b.x - dx},${b.y + k} ${b.x},${b.y}`;
  };

  // Edge id → its bow, fanned symmetrically around the direct line.
  const bowOf = new Map<string, number>();
  {
    const byPair = new Map<string, WorkflowEdge[]>();
    for (const e of edges) {
      const key = `${e.from_node} ${e.to_node}`;
      const list = byPair.get(key) ?? [];
      list.push(e);
      byPair.set(key, list);
    }
    for (const list of byPair.values()) {
      if (list.length < 2) continue;
      list.forEach((e, i) => bowOf.set(e.id, (i - (list.length - 1) / 2) * 34));
    }
  }

  const edgeColor = (e: WorkflowEdge) =>
    e.type.color || (e.type.is_flow ? "#34a853" : "#94a3b8");

  const selectEdge = (e: WorkflowEdge) => {
    setSelNode(null);
    setPreview(null);
    setSelEdge(e.id);
    setEType(e.type.name);
    setEWhen((e.condition_mode as "" | "nl" | "structured") || "");
    if (e.condition_mode === "nl") {
      setEIf(String(e.condition ?? ""));
    } else if (e.condition_mode === "structured" && e.condition) {
      try {
        const c = typeof e.condition === "string" ? JSON.parse(e.condition) : e.condition;
        setETerm(String(c.term ?? ""));
        setEOp(String(c.op ?? ">"));
        setEValue(String(c.value ?? ""));
      } catch {
        setETerm("");
        setEValue("");
      }
    }
  };

  const saveEdge = async () => {
    if (!selEdge) return;
    const self = edges.find((e) => e.id === selEdge);
    const clash =
      self &&
      edges.find(
        (e) =>
          e.id !== selEdge &&
          e.from_node === self.from_node &&
          e.to_node === self.to_node &&
          e.type.name === eType,
      );
    if (clash) {
      setError(
        `${labelOf(clash.from_node)} → ${labelOf(clash.to_node)} is already connected with "${eType}".`,
      );
      return;
    }
    setSaving(true);
    try {
      await updateEdge(nestId, selEdge, {
        type: eType,
        condition_mode: eWhen || null,
        condition:
          eWhen === "nl"
            ? eIf.trim()
            : eWhen === "structured"
              ? { term: eTerm.trim(), op: eOp, value: isNaN(Number(eValue)) ? eValue.trim() : Number(eValue) }
              : null,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save edge");
    } finally {
      setSaving(false);
    }
  };

  const removeEdge = async (id: string) => {
    try {
      await deleteEdge(nestId, id);
      setSelEdge(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete edge");
    }
  };

  const connectNodes = async (from: string, to: string) => {
    if (from === to) return;
    const flowType = types.find((t) => t.is_flow)?.name ?? types[0]?.name;
    if (!flowType) return;
    // Catch the duplicate here rather than on the server 409: the loaded edges
    // answer it, and this side knows the document titles the canvas shows.
    const dup = edges.find(
      (e) => e.from_node === from && e.to_node === to && e.type.name === flowType,
    );
    if (dup) {
      setError(
        `${labelOf(from)} → ${labelOf(to)} is already connected with "${flowType}".`,
      );
      selectEdge(dup);
      return;
    }
    try {
      const created = await createEdge(nestId, {
        from_node: from,
        to_node: to,
        type: flowType,
        condition_mode: null,
        condition: null,
      });
      await load();
      selectEdge(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    }
  };

  const svgPoint = (ev: React.MouseEvent) => {
    const rect = (ev.currentTarget as SVGSVGElement).closest("svg")!.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  const selectedEdgeObj = edges.find((e) => e.id === selEdge) ?? null;
  const distinctColors = [...new Set(edges.map(edgeColor))];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-4">
      <div className="rounded-lg border overflow-hidden bg-background">
        <div className="flex items-center gap-2 px-3 py-2 border-b text-xs text-muted-foreground">
          <span className="hidden md:inline">
            Drag from a card's <b>right port</b> onto another card to connect.
            Click a wire or card to edit it.
          </span>
          <div className="flex-1" />
          <Input
            value={shelfSearch}
            onChange={(e) => setShelfSearch(e.target.value)}
            placeholder="Find a document to wire in…"
            className="h-7 w-56 text-xs"
            data-testid="canvas-shelf-search"
          />
          <Button variant="outline" size="sm" className="h-7" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        {error && (
          <div className="mx-3 mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        {loading ? (
          <div className="py-16 text-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin inline" />
          </div>
        ) : placed.size === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            No documents in this nest yet — create one from the Documents tab
            and it appears here, ready to wire up.
          </div>
        ) : (
          <div className="overflow-auto max-h-[70vh]" ref={setScrollEl}>
            <svg
              width={width}
              height={height}
              ref={(el) => {
                svgRef.current = el;
              }}
              style={{
                background: "radial-gradient(circle, hsl(var(--muted-foreground) / 0.18) 1px, transparent 1px)",
                backgroundSize: "20px 20px",
              }}
              onMouseMove={(ev) => {
                if (!connect) return;
                const rect = (ev.currentTarget as SVGSVGElement).getBoundingClientRect();
                setConnect({ ...connect, x: ev.clientX - rect.left, y: ev.clientY - rect.top });
              }}
              onMouseUp={() => setConnect(null)}
              onClick={() => {
                setSelEdge(null);
                setSelNode(null);
              }}
            >
              <defs>
                {distinctColors.map((c) => (
                  <marker
                    key={c}
                    id={`ah-${c.replace(/[^a-z0-9]/gi, "")}`}
                    markerWidth="9"
                    markerHeight="9"
                    refX="7"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L7,3 L0,6 z" fill={c} />
                  </marker>
                ))}
              </defs>

              {edges.map((e) => {
                if (!placed.has(e.from_node) || !placed.has(e.to_node)) return null;
                const bow = bowOf.get(e.id) ?? 0;
                const d = wirePath(e.from_node, e.to_node, bow);
                const color = edgeColor(e);
                const mid = {
                  x: (portOf(e.from_node, "out").x + portOf(e.to_node, "in").x) / 2,
                  y:
                    (portOf(e.from_node, "out").y + portOf(e.to_node, "in").y) / 2 +
                    bow -
                    7,
                };
                let condText = "";
                if (e.condition_mode === "nl" && e.condition) condText = `“${e.condition}”`;
                else if (e.condition_mode === "structured" && e.condition) {
                  try {
                    const c = typeof e.condition === "string" ? JSON.parse(e.condition) : e.condition;
                    condText = c?.term ? `${c.term} ${c.op ?? ""} ${c.value ?? ""}` : "";
                  } catch { /* label stays type-only */ }
                }
                return (
                  <g key={e.id}>
                    <path
                      d={d}
                      fill="none"
                      stroke={color}
                      strokeWidth={selEdge === e.id ? 3 : 2}
                      strokeDasharray={e.type.is_flow ? undefined : "4 4"}
                      markerEnd={`url(#ah-${color.replace(/[^a-z0-9]/gi, "")})`}
                      opacity={selEdge && selEdge !== e.id ? 0.45 : 1}
                    />
                    {/* fat invisible twin for clickability */}
                    <path
                      d={d}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={14}
                      style={{ cursor: "pointer" }}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        selectEdge(e);
                      }}
                    />
                    <text
                      x={mid.x}
                      y={mid.y}
                      textAnchor="middle"
                      className="pointer-events-none"
                      style={{ font: "10px ui-monospace, monospace", fill: "hsl(var(--muted-foreground))" }}
                    >
                      {e.type.name}
                      {condText ? ` · ${condText.slice(0, 34)}` : ""}
                    </text>
                  </g>
                );
              })}

              {connect && (
                <path
                  d={`M${portOf(connect.from, "out").x},${portOf(connect.from, "out").y} C${portOf(connect.from, "out").x + 60},${portOf(connect.from, "out").y} ${connect.x - 60},${connect.y} ${connect.x},${connect.y}`}
                  fill="none"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                />
              )}

              {/* Shelf divider — everything below is not wired in yet. */}
              {shelfIds.length > 0 && (
                <g>
                  <line
                    x1={PAD_X}
                    y1={shelfTop - 26}
                    x2={width - PAD_X}
                    y2={shelfTop - 26}
                    stroke="hsl(var(--border))"
                    strokeDasharray="3 3"
                  />
                  <text
                    x={PAD_X}
                    y={shelfTop - 32}
                    style={{ font: "10px sans-serif", fill: "hsl(var(--muted-foreground))" }}
                  >
                    NOT WIRED IN YET ({shelfIds.length}
                    {q ? " matching" : ""}) — drag a right port onto any card to connect
                  </text>
                </g>
              )}

              {[...placed.values()].map((p) => {
                const t = typeOf(p.id);
                const isSel = selNode === p.id;
                return (
                  <g key={p.id}>
                    <foreignObject x={p.x} y={p.y} width={CARD_W} height={CARD_H + 6}>
                      <div
                        className={`rounded-lg border-2 bg-background px-2.5 py-1.5 shadow-sm cursor-pointer select-none ${isSel ? "border-primary ring-2 ring-primary/20" : "border-border"
                          }`}
                        style={{ width: CARD_W, height: CARD_H }}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setSelEdge(null);
                          setPreview(null);
                          setSelNode(p.id);
                        }}
                        onMouseUp={() => {
                          if (connect && connect.from !== p.id) {
                            void connectNodes(connect.from, p.id);
                            setConnect(null);
                          }
                        }}
                        title={p.id}
                      >
                        <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                          <TypeGlyph type={t} />
                          {t ?? "document"}
                        </div>
                        <div className="text-xs font-semibold truncate mt-0.5">
                          {labelOf(p.id)}
                        </div>
                      </div>
                    </foreignObject>
                    {/* out-port: drag here to connect */}
                    <circle
                      cx={p.x + CARD_W}
                      cy={p.y + CARD_H / 2}
                      r={6}
                      fill="hsl(var(--background))"
                      stroke="hsl(var(--primary))"
                      strokeWidth={1.5}
                      style={{ cursor: "crosshair" }}
                      onMouseDown={(ev) => {
                        ev.stopPropagation();
                        ev.preventDefault();
                        const pt = svgPoint(ev);
                        setConnect({ from: p.id, x: pt.x, y: pt.y });
                      }}
                    />
                  </g>
                );
              })}
            </svg>
          </div>
        )}
      </div>

      {/* Config panel — the n8n interaction: click a thing, edit it here. */}
      <div className="rounded-lg border p-4 h-fit">
        {selectedEdgeObj ? (
          <div>
            <h3 className="text-sm font-semibold">Edge · {selectedEdgeObj.type.name}</h3>
            <p className="text-xs text-muted-foreground mb-3">
              {labelOf(selectedEdgeObj.from_node)} → {labelOf(selectedEdgeObj.to_node)}
            </p>

            <label className="block text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              Type
            </label>
            <select
              value={eType}
              onChange={(e) => setEType(e.target.value)}
              className="w-full h-8 rounded-md border bg-background px-2 text-sm mb-3"
            >
              {types.map((t) => (
                <option key={t.id} value={t.name}>
                  {t.is_flow ? "▶ " : ""}
                  {t.name}
                </option>
              ))}
            </select>

            <label className="block text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
              Fires
            </label>
            <div className="flex items-center rounded-md border h-8 text-xs overflow-hidden w-fit mb-2">
              {(
                [
                  ["", "always"],
                  ["nl", "if…"],
                  ["structured", "metric"],
                ] as const
              ).map(([mode, lbl], i) => (
                <button
                  key={mode}
                  type="button"
                  className={`px-2.5 h-full ${i > 0 ? "border-l" : ""} ${eWhen === mode ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                    }`}
                  onClick={() => setEWhen(mode)}
                >
                  {lbl}
                </button>
              ))}
            </div>
            {eWhen === "nl" && (
              <Input
                value={eIf}
                onChange={(e) => setEIf(e.target.value)}
                placeholder='e.g. "lost on price, not product"'
                className="h-8 text-sm italic mb-2"
              />
            )}
            {eWhen === "structured" && (
              <div className="grid grid-cols-[1fr_58px_1fr] gap-1.5 mb-2">
                <Input value={eTerm} onChange={(e) => setETerm(e.target.value)} placeholder="CAC" className="h-8 text-sm font-mono" />
                <select
                  value={eOp}
                  onChange={(e) => setEOp(e.target.value)}
                  className="h-8 rounded-md border bg-background px-1 text-sm font-mono"
                >
                  {[">", "<", ">=", "<=", "=", "!="].map((op) => (
                    <option key={op} value={op}>{op}</option>
                  ))}
                </select>
                <Input value={eValue} onChange={(e) => setEValue(e.target.value)} placeholder="500" className="h-8 text-sm font-mono" />
              </div>
            )}

            <div className="flex gap-2 mt-4">
              <Button size="sm" className="flex-1" disabled={saving} onClick={() => void saveEdge()}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                onClick={() => void removeEdge(selectedEdgeObj.id)}
              >
                Delete
              </Button>
            </div>
          </div>
        ) : selNode ? (
          (() => {
            const runnable = ["agent", "skill"].includes(typeOf(selNode) ?? "");
            const mySchedule = schedules.find((s) => s.agent_node === selNode);
            const origin = window.location.origin;
            const selector = `[[${labelOf(selNode)}]]`;
            const readCmd = `curl -s -X POST ${origin}/nests/${nestId}/context -H 'Content-Type: application/json' -d '{"selector":"${selector}","hops":${hops},"max_tokens":4000}'`;
            const writeCmd = `curl -s -X PATCH ${origin}/nests/${nestId}/nodes/${selNode} -H 'Content-Type: application/json' -d '{"append":"<your update>","changeNote":"via ctx"}'`;
            return (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center gap-2">
                    <TypeGlyph type={typeOf(selNode)} />
                    <h3 className="text-sm font-semibold truncate">{labelOf(selNode)}</h3>
                  </div>
                  <p className="text-xs text-muted-foreground font-mono truncate">{selNode}</p>
                </div>

                {runnable && (
                  <div className="space-y-2">
                    <Button
                      size="sm"
                      className="w-full"
                      onClick={async () => {
                        try {
                          await triggerRun(nestId, selNode);
                          setRunFeedback("Run created — a polling runner will pick it up");
                          setTimeout(() => setRunFeedback(""), 3000);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : "Trigger failed");
                        }
                      }}
                    >
                      <Play className="h-3.5 w-3.5 mr-1.5" /> Run now
                    </Button>
                    {runFeedback && (
                      <p className="text-[11px] text-emerald-600">{runFeedback}</p>
                    )}
                    <label className="block text-[10px] uppercase tracking-wide text-muted-foreground">
                      Schedule
                    </label>
                    {mySchedule ? (
                      <div className="rounded-md border px-2.5 py-2 text-xs space-y-1.5">
                        <div className="flex items-center gap-2">
                          <span>
                            every{" "}
                            <b>
                              {mySchedule.every_minutes >= 60
                                ? `${mySchedule.every_minutes / 60}h`
                                : `${mySchedule.every_minutes}m`}
                            </b>
                            {mySchedule.enabled ? "" : " · paused"}
                          </span>
                          <div className="flex-1" />
                          <button
                            type="button"
                            className="text-primary hover:underline"
                            onClick={async () => {
                              await updateSchedule(nestId, mySchedule.id, {
                                enabled: !mySchedule.enabled,
                              });
                              await load();
                            }}
                          >
                            {mySchedule.enabled ? "Pause" : "Resume"}
                          </button>
                          <button
                            type="button"
                            className="text-destructive hover:underline"
                            onClick={async () => {
                              await deleteSchedule(nestId, mySchedule.id);
                              await load();
                            }}
                          >
                            Remove
                          </button>
                        </div>
                        {mySchedule.enabled && mySchedule.next_due_at && (
                          <div className="text-muted-foreground">
                            next fire ~{timeOf(mySchedule.next_due_at)}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <select
                          value={schedEvery}
                          onChange={(e) => setSchedEvery(Number(e.target.value))}
                          className="h-8 rounded-md border bg-background px-2 text-sm flex-1"
                        >
                          <option value={15}>every 15 minutes</option>
                          <option value={60}>every hour</option>
                          <option value={360}>every 6 hours</option>
                          <option value={1440}>every day</option>
                        </select>
                        <Button
                          size="sm"
                          className="h-8"
                          onClick={async () => {
                            try {
                              await createSchedule(nestId, {
                                agent_node: selNode,
                                every_minutes: schedEvery,
                              });
                              await load();
                            } catch (err) {
                              setError(err instanceof Error ? err.message : "Schedule failed");
                            }
                          }}
                        >
                          Schedule
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {runnable && (
                  <div className="space-y-1.5">
                    <label className="block text-[10px] uppercase tracking-wide text-muted-foreground">
                      Triggers — call this agent from outside
                    </label>
                    {nodeHooks.map((h) => (
                      <div key={h.id} className="rounded-md border px-2 py-1.5 text-[11px] space-y-1">
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="text-[10px]">{h.preset}</Badge>
                          <span className="text-muted-foreground">
                            fired {h.fire_count}×
                          </span>
                          <div className="flex-1" />
                          <button
                            type="button"
                            className="text-destructive hover:underline"
                            onClick={async () => {
                              await deleteHook(nestId, h.id);
                              setNodeHooks(await listHooks(nestId, selNode));
                            }}
                          >
                            Remove
                          </button>
                        </div>
                        {(h.url ?? revealedHookUrls[h.id]) ? (
                          <button
                            type="button"
                            className="w-full text-left font-mono break-all rounded bg-muted/40 px-1.5 py-1 hover:border-primary border border-transparent"
                            title="Copy the trigger URL — paste into a Slack slash command / Events API, Teams outgoing webhook, or any system that can POST"
                            onClick={() => copy(`hook-${h.id}`, h.url ?? revealedHookUrls[h.id])}
                          >
                            {copied === `hook-${h.id}` ? "✓ copied" : (h.url ?? revealedHookUrls[h.id])}
                          </button>
                        ) : (
                          <p className="text-muted-foreground px-1.5">
                            URL was shown at creation only (like an API key).
                            Remove + re-add to mint a fresh one.
                          </p>
                        )}
                      </div>
                    ))}
                    <div className="flex items-center gap-1.5">
                      <select
                        value={hookPreset}
                        onChange={(e) => setHookPreset(e.target.value as TriggerHook["preset"])}
                        className="h-7 rounded-md border bg-background px-1.5 text-xs flex-1"
                      >
                        <option value="slack">Slack (slash command / @mention)</option>
                        <option value="teams">Teams (outgoing webhook)</option>
                        <option value="webhook">Webhook (any system)</option>
                      </select>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2"
                        onClick={async () => {
                          const created = await createHook(nestId, selNode, hookPreset);
                          if (created.url) {
                            // List responses mask the id (hk_xxxx…yyyy) —
                            // key the reveal cache by that same masked form.
                            const maskedId = `${created.id.slice(0, 7)}…${created.id.slice(-4)}`;
                            setRevealedHookUrls((prev) => ({ ...prev, [maskedId]: created.url! }));
                          }
                          setNodeHooks(await listHooks(nestId, selNode));
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Each trigger is a secret URL that queues a run — message
                      text becomes the run's inputs. Add
                      SLACK_SIGNING_SECRET to the Tool environment to verify
                      Slack requests.
                    </p>
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="block text-[10px] uppercase tracking-wide text-muted-foreground">
                    Notify on output
                  </label>
                  {watchers.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {watchers.map((w) => (
                        <span
                          key={w}
                          className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px]"
                        >
                          {w}
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-destructive"
                            title="Stop notifying"
                            onClick={async () => {
                              const next = await removeNodeWatcher(nestId, selNode, w);
                              setWatchers(next.map((x) => x.user_email));
                            }}
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <Input
                      value={watcherEmail}
                      onChange={(e) => setWatcherEmail(e.target.value)}
                      placeholder="person@team.com"
                      className="h-7 text-xs flex-1"
                      onKeyDown={async (e) => {
                        if (e.key === "Enter" && watcherEmail.includes("@")) {
                          const next = await addNodeWatcher(nestId, selNode, watcherEmail.trim());
                          setWatchers(next.map((x) => x.user_email));
                          setWatcherEmail("");
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2"
                      disabled={!watcherEmail.includes("@")}
                      onClick={async () => {
                        const next = await addNodeWatcher(nestId, selNode, watcherEmail.trim());
                        setWatchers(next.map((x) => x.user_email));
                        setWatcherEmail("");
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    Tagged people get an inbox notification when this node's
                    output lands for review. (Slack/webhook delivery comes
                    later — same table.)
                  </p>
                </div>

                <div>
                  <label className="block text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                    Add a step after this
                  </label>
                  <div className="flex items-center gap-1.5">
                    <select
                      value={stepTo}
                      onChange={(e) => setStepTo(e.target.value)}
                      className="h-8 rounded-md border bg-background px-2 text-sm flex-1 min-w-0"
                    >
                      <option value="">Choose a document…</option>
                      {nodes
                        .filter((n) => n.id !== selNode)
                        .map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.title || n.id}
                          </option>
                        ))}
                    </select>
                    <Button
                      size="sm"
                      className="h-8"
                      disabled={!stepTo}
                      onClick={() => {
                        void connectNodes(selNode, stepTo);
                        setStepTo("");
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    Or drag from the node's right port straight onto another card.
                  </p>
                </div>

                {/* Grab this node as a ctx command — reader (deterministic
                    /context assembly) and writer (governed append). */}
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Use from CLI / agent
                    </label>
                    <div className="flex-1" />
                    <select
                      value={hops}
                      onChange={(e) => setHops(Number(e.target.value))}
                      className="h-6 rounded border bg-background px-1 text-[11px]"
                      title="How many hops of linked context to pull with it"
                    >
                      {[0, 1, 2, 3].map((h) => (
                        <option key={h} value={h}>{h} hop{h === 1 ? "" : "s"}</option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    className="w-full text-left rounded-md border bg-muted/40 px-2 py-1.5 text-[10.5px] font-mono break-all hover:border-primary"
                    onClick={() => copy("sel", selector)}
                    title="Copy the selector"
                  >
                    {copied === "sel" ? "✓ copied" : selector}
                  </button>
                  <button
                    type="button"
                    className="w-full text-left rounded-md border bg-muted/40 px-2 py-1.5 text-[10.5px] font-mono break-all hover:border-primary"
                    onClick={() => copy("read", readCmd)}
                    title="Copy — deterministic read: this node + linked context"
                  >
                    {copied === "read" ? "✓ copied" : `read → ${readCmd.slice(0, 64)}…`}
                  </button>
                  <button
                    type="button"
                    className="w-full text-left rounded-md border bg-muted/40 px-2 py-1.5 text-[10.5px] font-mono break-all hover:border-primary"
                    onClick={() => copy("write", writeCmd)}
                    title="Copy — governed write: append to this node (lands as a new version / review request)"
                  >
                    {copied === "write" ? "✓ copied" : `write → ${writeCmd.slice(0, 64)}…`}
                  </button>
                  {/* Test it out: execute the same deterministic read a runner
                      does and show the assembled context right here. */}
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full h-7 text-xs"
                    disabled={previewing}
                    onClick={async () => {
                      setPreviewing(true);
                      try {
                        const r = await queryContext(nestId, selector, hops);
                        setPreview({
                          text: r.context || "(empty context)",
                          nodes:
                            r.trace?.nodes_traversed ?? r.nodes_traversed ?? 0,
                        });
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Preview failed");
                      } finally {
                        setPreviewing(false);
                      }
                    }}
                  >
                    {previewing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <>Test: preview what it reads ({hops} hop{hops === 1 ? "" : "s"})</>
                    )}
                  </Button>
                  {preview && (
                    <div className="rounded-md border bg-muted/30 p-2">
                      <div className="flex items-center text-[10px] text-muted-foreground mb-1">
                        <span>{preview.nodes} node{preview.nodes === 1 ? "" : "s"} assembled — exactly what a run reads</span>
                        <button
                          type="button"
                          className="ml-auto hover:text-foreground"
                          onClick={() => setPreview(null)}
                        >
                          ✕
                        </button>
                      </div>
                      <pre className="max-h-56 overflow-auto whitespace-pre-wrap text-[10.5px] leading-relaxed">
                        {preview.text.slice(0, 4000)}
                        {preview.text.length > 4000 ? "\n…(truncated)" : ""}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            );
          })()
        ) : (
          <div className="text-sm text-muted-foreground">
            <p className="font-medium text-foreground mb-1">Nothing selected</p>
            <p className="text-xs">
              Click a <b>wire</b> to change its type or condition, click a{" "}
              <b>card</b> to add a next step, or drag from a card's right port
              onto another card to connect them.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Schedules: standing triggers, separated from run history ────────────
//
// A schedule is a standing decision ("this agent runs every hour"); a run is
// one execution of it. They read differently and change at different rates,
// so they get their own tab — Runs stays the log, this is the control panel.

function SchedulesPanel({ nestId }: { nestId: string }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [nodes, setNodes] = useState<Array<{ id: string; title?: string; type?: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newAgent, setNewAgent] = useState("");
  const [newEvery, setNewEvery] = useState(60);
  const [newMaxRuns, setNewMaxRuns] = useState<number | "">("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, n] = await Promise.all([
        listSchedules(nestId),
        listNodes(nestId).then((x) => x.nodes).catch(() => []),
      ]);
      setSchedules(s);
      setNodes(n);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, [nestId]);

  useEffect(() => {
    void load();
  }, [load]);

  const labelOf = (id: string) =>
    nodes.find((n) => n.id === id)?.title || id.replace(/^nodes\//, "");
  const typeOf = (id: string) => nodes.find((n) => n.id === id)?.type;
  const runnables = nodes.filter((n) => n.type === "agent" || n.type === "skill");
  const unscheduled = runnables.filter(
    (n) => !schedules.some((s) => s.agent_node === n.id),
  );
  const everyLabel = (m: number) => (m >= 1440 ? `${m / 1440}d` : m >= 60 ? `${m / 60}h` : `${m}m`);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        A schedule decides <b>when a run starts</b> and its stop-after bound
        decides <b>when it's done</b>. What happens <em>inside</em> a run —
        which step fires, on what condition — lives on the wires in the
        Canvas (click a wire to set always / if… / metric). Scheduled output
        still lands as a review request; scheduling doesn't skip governance.
      </p>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin inline" />
        </div>
      ) : schedules.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <Clock3 className="h-6 w-6 text-muted-foreground/50 mx-auto mb-2" />
          <p className="text-sm font-medium mb-1">Nothing on the clock yet</p>
          <p className="text-xs text-muted-foreground">
            {runnables.length
              ? "Pick an agent below — every interval, the server files a run for it."
              : "This nest has no runnable agents yet. Create one from Documents → New → type Agent (its body is the instructions), then schedule it here."}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border divide-y">
          {schedules.map((s) => (
            <div key={s.id} className="px-3 py-2.5 flex items-center gap-2 text-sm">
              <TypeGlyph type={typeOf(s.agent_node)} />
              <span className="truncate font-medium" title={s.agent_node}>
                {labelOf(s.agent_node)}
              </span>
              <Badge variant="secondary" className="text-[10px] shrink-0">
                every {everyLabel(s.every_minutes)}
              </Badge>
              {s.max_runs !== null && (
                <Badge variant="outline" className="text-[10px] shrink-0" title="Stops automatically after this many runs">
                  {s.runs_created}/{s.max_runs} runs
                </Badge>
              )}
              {s.enabled ? (
                s.next_due_at && (
                  <span className="text-[11px] text-muted-foreground shrink-0">
                    next ~{timeOf(s.next_due_at)}
                  </span>
                )
              ) : s.max_runs !== null && s.runs_created >= s.max_runs ? (
                <Badge className="text-[10px] shrink-0 bg-emerald-600">done</Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] shrink-0">
                  paused
                </Badge>
              )}
              <div className="flex-1" />
              <select
                value={s.every_minutes}
                onChange={async (e) => {
                  await updateSchedule(nestId, s.id, {
                    every_minutes: Number(e.target.value),
                  });
                  await load();
                }}
                className="h-7 rounded-md border bg-background px-1.5 text-xs shrink-0"
                title="Change the interval"
              >
                {[15, 60, 360, 1440].map((m) => (
                  <option key={m} value={m}>{everyLabel(m)}</option>
                ))}
                {![15, 60, 360, 1440].includes(s.every_minutes) && (
                  <option value={s.every_minutes}>{everyLabel(s.every_minutes)}</option>
                )}
              </select>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs shrink-0"
                onClick={async () => {
                  await updateSchedule(nestId, s.id, { enabled: !s.enabled });
                  await load();
                }}
              >
                {s.enabled ? "Pause" : "Resume"}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                onClick={async () => {
                  await deleteSchedule(nestId, s.id);
                  await load();
                }}
                title="Remove schedule"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border bg-muted/20 p-3">
        <div className="text-xs font-medium mb-2">Put an agent on the clock</div>
        <div className="flex items-center gap-2">
          <select
            value={newAgent}
            onChange={(e) => setNewAgent(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-sm flex-1 min-w-0"
            data-testid="schedule-agent-lookup"
          >
            <option value="">
              {unscheduled.length ? "Choose an agent…" : "Every runnable agent is scheduled"}
            </option>
            {unscheduled.map((n) => (
              <option key={n.id} value={n.id}>
                {n.type === "agent" ? "🤖 " : "⚡ "}
                {n.title || n.id}
              </option>
            ))}
          </select>
          <select
            value={newEvery}
            onChange={(e) => setNewEvery(Number(e.target.value))}
            className="h-8 rounded-md border bg-background px-2 text-sm"
          >
            <option value={15}>every 15 minutes</option>
            <option value={60}>every hour</option>
            <option value={360}>every 6 hours</option>
            <option value={1440}>every day</option>
          </select>
          <select
            value={newMaxRuns}
            onChange={(e) =>
              setNewMaxRuns(e.target.value === "" ? "" : Number(e.target.value))
            }
            className="h-8 rounded-md border bg-background px-2 text-sm"
            title="The stop condition: pause automatically after this many runs"
          >
            <option value="">until stopped</option>
            <option value={1}>once</option>
            <option value={5}>stop after 5</option>
            <option value={10}>stop after 10</option>
            <option value={25}>stop after 25</option>
          </select>
          <Button
            size="sm"
            className="h-8"
            disabled={saving || !newAgent}
            onClick={async () => {
              setSaving(true);
              try {
                await createSchedule(nestId, {
                  agent_node: newAgent,
                  every_minutes: newEvery,
                  max_runs: newMaxRuns === "" ? null : newMaxRuns,
                });
                setNewAgent("");
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Schedule failed");
              } finally {
                setSaving(false);
              }
            }}
          >
            <Plus className="h-3.5 w-3.5 mr-1" /> Schedule
          </Button>
        </div>
      </div>
    </div>
  );
}


// ─── Env: the tool credential store ──────────────────────────────────────
//
// Key/value pairs the runner hands to TOOL nodes (via the run bundle).
// Values are write-only here — the API masks them on read. Not encrypted at
// rest; same trust domain as the nest content (it says so in the UI).

function EnvPanel({ nestId }: { nestId: string }) {
  const [env, setEnv] = useState<EnvEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setEnv(await listEnv(nestId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load env");
    }
  }, [nestId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <details className="rounded-lg border px-4 py-3">
      <summary className="cursor-pointer select-none text-sm font-medium flex items-center gap-2">
        <Wrench className="h-4 w-4 text-teal-500 inline" /> Tool environment
        ({env.length} key{env.length === 1 ? "" : "s"})
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-[11px] text-muted-foreground">
          Credentials for <b>tool</b> nodes. Values are write-only here and
          travel to the runner inside the run bundle. Stored alongside nest
          content, not encrypted — treat this box like the nest itself.
        </p>
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        {env.length > 0 && (
          <div className="rounded-md border divide-y">
            {env.map((e) => (
              <div key={e.key} className="px-3 py-1.5 flex items-center gap-2 text-xs">
                <span className="font-mono font-medium">{e.key}</span>
                <span className="font-mono text-muted-foreground">{e.value_masked}</span>
                <div className="flex-1" />
                <span className="text-muted-foreground">{e.updated_by}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  title="Delete key"
                  onClick={async () => {
                    await deleteEnv(nestId, e.key);
                    await load();
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <Input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value.toUpperCase())}
            placeholder="SLACK_TOKEN"
            className="h-8 text-xs font-mono w-44"
          />
          <Input
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder="value (write-only)"
            type="password"
            className="h-8 text-xs font-mono flex-1"
          />
          <Button
            size="sm"
            className="h-8"
            disabled={saving || !/^[A-Z][A-Z0-9_]*$/.test(newKey) || !newValue}
            onClick={async () => {
              setSaving(true);
              try {
                await putEnv(nestId, newKey, newValue);
                setNewKey("");
                setNewValue("");
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Save failed");
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Set"}
          </Button>
        </div>
      </div>
    </details>
  );
}


// ─── First-run key prompt ────────────────────────────────────────────────
//
// The single thing every new workflow user hits: runs don't execute without
// an Anthropic key. Until the nest env store carries ANTHROPIC_API_KEY,
// this callout sits at the top of Activity with an inline input — no hunting
// through collapsed sections or env files.

function RunnerKeyCallout({ nestId }: { nestId: string }) {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSet, setJustSet] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listEnv(nestId).catch(() => null),
      getHealth().catch(() => null),
    ]).then(([env, health]) => {
      if (cancelled) return;
      // Server-wide key (super-admin Settings) satisfies runners for every
      // nest — only prompt when NEITHER level has one.
      if (health?.runner_key_configured) return setHasKey(true);
      if (!env) return setHasKey(null);
      setHasKey(env.some((e) => e.key === "ANTHROPIC_API_KEY"));
    });
    return () => {
      cancelled = true;
    };
  }, [nestId]);

  if (hasKey !== false) {
    return justSet ? (
      <div className="rounded-lg border border-emerald-400/50 bg-emerald-500/5 px-4 py-3 text-sm">
        ✓ Key stored (masked from here on). Runners pick it up from the run
        bundle — start one in poll mode and your queued runs execute.
      </div>
    ) : null;
  }

  return (
    <div className="rounded-lg border border-amber-400/60 bg-amber-500/5 px-4 py-3">
      <div className="text-sm font-medium mb-1">
        🔑 Add your Anthropic API key to execute runs
      </div>
      <p className="text-xs text-muted-foreground mb-2">
        Runs are created here, but a runner needs a key to call the model.
        Paste it once — it's stored write-only for this nest (masked
        everywhere, delivered to runners inside the run bundle). Get one at
        console.anthropic.com → Settings → API keys.
      </p>
      {error && (
        <p className="text-xs text-destructive mb-2">{error}</p>
      )}
      <div className="flex items-center gap-2">
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="sk-ant-…"
          className="h-8 text-sm font-mono flex-1"
          data-testid="runner-key-input"
        />
        <Button
          size="sm"
          className="h-8"
          disabled={saving || !value.trim().startsWith("sk-")}
          onClick={async () => {
            setSaving(true);
            try {
              await putEnv(nestId, "ANTHROPIC_API_KEY", value.trim());
              setValue("");
              setHasKey(true);
              setJustSet(true);
            } catch (err) {
              setError(err instanceof Error ? err.message : "Save failed");
            } finally {
              setSaving(false);
            }
          }}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save key"}
        </Button>
      </div>
    </div>
  );
}


// ─── Connectors: outbound event → channel bricks ─────────────────────────
//
// Rows the dispatch engine fans events into. Channel is a preset (slack /
// teams / raw webhook); url may be a literal https URL or an env:KEY
// reference into the Tool environment — same secret store as tools. The
// server-wide Settings webhook remains an implicit slack connector.

const CONNECTOR_EVENTS = [
  ["review_requested", "review requested"],
  ["review_approved", "approved"],
  ["review_rejected", "rejected"],
  ["run_failed", "run failed"],
] as const;

function ConnectorsPanel({ nestId }: { nestId: string }) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<Connector["channel"]>("slack");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(["*"]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setConnectors(await listConnectors(nestId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load connectors");
    }
  }, [nestId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleEvent = (k: string) => {
    setEvents((prev) => {
      if (k === "*") return ["*"];
      const without = prev.filter((e) => e !== "*" && e !== k);
      return prev.includes(k) ? (without.length ? without : ["*"]) : [...without, k];
    });
  };

  return (
    <details className="rounded-lg border px-4 py-3" open={connectors.length > 0}>
      <summary className="cursor-pointer select-none text-sm font-medium">
        📤 Connectors ({connectors.length}) — send events to Slack / Teams / webhooks
      </summary>
      <div className="mt-3 space-y-3">
        <p className="text-[11px] text-muted-foreground">
          Governance + run events post to each matching channel.
          Fire-and-forget — a channel outage never blocks a review. The
          server-wide Slack webhook (super-admin Settings) always fires too.
        </p>
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        {connectors.length > 0 && (
          <div className="rounded-md border divide-y">
            {connectors.map((con) => (
              <div key={con.id} className="px-3 py-2 flex items-center gap-2 text-xs">
                <Badge variant="secondary" className="text-[10px] shrink-0">{con.channel}</Badge>
                <span className="font-mono truncate">{con.url}</span>
                <span className="text-muted-foreground shrink-0">
                  {con.events.includes("*") ? "all events" : con.events.join(", ")}
                </span>
                <div className="flex-1" />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-[11px] px-2 shrink-0"
                  onClick={async () => {
                    await updateConnector(nestId, con.id, { enabled: !con.enabled });
                    await load();
                  }}
                >
                  {con.enabled ? "Pause" : "Resume"}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={async () => {
                    await deleteConnector(nestId, con.id);
                    await load();
                  }}
                  title="Delete connector"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <div className="space-y-2 rounded-md border bg-muted/20 p-2.5">
          <div className="flex items-center gap-1.5">
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as Connector["channel"])}
              className="h-8 rounded-md border bg-background px-1.5 text-xs"
            >
              <option value="slack">Slack</option>
              <option value="teams">Teams</option>
              <option value="webhook">Webhook (raw JSON)</option>
            </select>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://hooks.slack.com/… or env:SLACK_WEBHOOK"
              className="h-8 text-xs font-mono flex-1"
            />
            <Button
              size="sm"
              className="h-8"
              disabled={saving || !(url.startsWith("https://") || url.startsWith("env:"))}
              onClick={async () => {
                setSaving(true);
                try {
                  await createConnector(nestId, { channel, url: url.trim(), events });
                  setUrl("");
                  setEvents(["*"]);
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Create failed");
                } finally {
                  setSaving(false);
                }
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex items-center flex-wrap gap-1 text-[11px]">
            <button
              type="button"
              className={`rounded-full border px-2 py-0.5 ${events.includes("*") ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted"}`}
              onClick={() => toggleEvent("*")}
            >
              all events
            </button>
            {CONNECTOR_EVENTS.map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`rounded-full border px-2 py-0.5 ${events.includes(k) ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted"}`}
                onClick={() => toggleEvent(k)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </details>
  );
}
