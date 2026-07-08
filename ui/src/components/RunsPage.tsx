/**
 * Runs — the "turing" workflow plane's run surface.
 * Lists a nest's agent runs and shows a trace viewer for a single run's steps.
 * A "Trigger run" action creates a run record + executable bundle, but the
 * server still never EXECUTES: an external runner (agent, worker, or the MCP
 * workflow_run tool) must walk the bundle and report steps back. So this stays
 * primarily an observability surface; triggering just seeds the record.
 *
 * Feature-flagged: the whole plane (and this page's nav entry) only appears
 * when the "Workflow plane" admin toggle is on. `inputs`/`trace`/`detail`
 * arrive null when the caller lacks write tier — the server redacts them.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Activity, Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as api from "../lib/api";
import type { Run, RunStep } from "../lib/api";

interface Props {
  nestId: string;
  nestName: string;
  onBack: () => void;
}

type BadgeVariant =
  | "info"
  | "success"
  | "destructive"
  | "neutral";

const STATUS_VARIANT: Record<Run["status"], BadgeVariant> = {
  running: "info",
  succeeded: "success",
  failed: "destructive",
  cancelled: "neutral",
};

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

function fmt(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function StatusBadge({ status }: { status: Run["status"] }) {
  return <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>;
}

/** Pretty-print a redactable field, or a muted note when the server withheld it. */
function RedactableJson({ value }: { value: unknown | null }) {
  if (value == null) {
    return (
      <span className="text-xs text-muted-foreground italic">
        redacted (needs write access)
      </span>
    );
  }
  return (
    <pre className="text-[11px] font-mono bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function RunsPage({ nestId, nestName, onBack }: Props) {
  const [rows, setRows] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [agentFilter, setAgentFilter] = useState<string>("");

  // Detail view: the selected run + its lazily-loaded trace.
  const [selected, setSelected] = useState<Run | null>(null);
  const [detail, setDetail] = useState<{ run: Run; steps: RunStep[] } | null>(
    null,
  );
  const [detailLoading, setDetailLoading] = useState(false);

  // Trigger form: creates a run record + bundle. The server never executes;
  // an external runner must pick the bundle up (see the note in the panel).
  const [showTrigger, setShowTrigger] = useState(false);
  const [triggerAgent, setTriggerAgent] = useState("");
  const [triggerInputs, setTriggerInputs] = useState("");
  const [triggering, setTriggering] = useState(false);
  // Runnable nodes (agent/skill) for the trigger picker — filtered server-side.
  const [runnables, setRunnables] = useState<api.Runnable[]>([]);

  useEffect(() => {
    api
      .listRunnables(nestId)
      .then(({ runnables }) => setRunnables(runnables))
      .catch(() => {});
  }, [nestId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { runs } = await api.listRuns(nestId, {
        agent: agentFilter.trim() || undefined,
        status: statusFilter === "all" ? undefined : statusFilter,
      });
      setRows(runs);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load runs");
    } finally {
      setLoading(false);
    }
  }, [nestId, agentFilter, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const openRun = useCallback(async (run: Run) => {
    setSelected(run);
    setDetail(null);
    setDetailLoading(true);
    try {
      const d = await api.getRun(run.id);
      setDetail(d);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load run trace");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeRun = () => {
    setSelected(null);
    setDetail(null);
  };

  const submitTrigger = async () => {
    const agent = triggerAgent.trim();
    if (!agent) {
      toast.error("Select an agent or skill node");
      return;
    }
    let inputs: unknown;
    if (triggerInputs.trim()) {
      try {
        inputs = JSON.parse(triggerInputs);
      } catch {
        toast.error("Inputs must be valid JSON");
        return;
      }
    }
    setTriggering(true);
    try {
      const bundle = await api.triggerRun(nestId, agent, inputs);
      toast.success(
        `Run ${bundle.run_id} created. The server does not execute — hand the bundle to a runner.`,
      );
      setShowTrigger(false);
      setTriggerAgent("");
      setTriggerInputs("");
      await load();
      // Jump straight to the new run's (empty) trace.
      openRun({
        id: bundle.run_id,
        nest_id: nestId,
        agent_node: bundle.agent.id,
        triggered_by: "",
        status: "running",
        inputs: null,
        trace: null,
        started_at: new Date().toISOString(),
        finished_at: null,
      });
    } catch (e: any) {
      toast.error(e?.message || "Failed to trigger run");
    } finally {
      setTriggering(false);
    }
  };

  // ── Detail view ──────────────────────────────────────────────────────
  if (selected) {
    const run = detail?.run ?? selected;
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={closeRun}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back to runs
          </Button>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Run · {run.agent_node}
          </h1>
        </div>

        {/* Run meta */}
        <div className="border border-border rounded-lg bg-card p-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Agent</div>
              <div className="font-mono">{run.agent_node}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Status</div>
              <StatusBadge status={run.status} />
              {run.status === "running" && (
                <p className="text-xs text-muted-foreground mt-1">
                  Waiting for an external runner. The server never executes —{" "}
                  <span className="font-mono">running</span> means the run is
                  seeded and unclaimed until a runner walks the bundle and
                  reports steps back.
                </p>
              )}
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Triggered by</div>
              <div>{run.triggered_by}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Run ID</div>
              <div className="font-mono text-xs break-all">{run.id}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Started</div>
              <div>{fmt(run.started_at)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Finished</div>
              <div>{fmt(run.finished_at)}</div>
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Inputs</div>
            <RedactableJson value={run.inputs} />
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Trace</div>
            <RedactableJson value={run.trace} />
          </div>
        </div>

        {/* Steps */}
        <div className="border border-border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
                <th>#</th>
                <th>Action</th>
                <th>Node</th>
                <th>Edge</th>
                <th>At</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {detailLoading && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-8 text-center text-muted-foreground"
                  >
                    <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                    Loading trace…
                  </td>
                </tr>
              )}
              {!detailLoading && detail && detail.steps.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-8 text-center text-muted-foreground"
                  >
                    No steps recorded for this run.
                  </td>
                </tr>
              )}
              {!detailLoading &&
                detail?.steps.map((s) => (
                  <tr
                    key={s.seq}
                    className="border-t border-border align-top [&>td]:px-3 [&>td]:py-2"
                  >
                    <td className="whitespace-nowrap font-mono text-xs">
                      {s.seq}
                    </td>
                    <td className="whitespace-nowrap">
                      <Badge variant="neutral">{s.action}</Badge>
                    </td>
                    <td className="font-mono text-xs">{s.node_id ?? "—"}</td>
                    <td className="font-mono text-xs">{s.edge_id ?? "—"}</td>
                    <td className="whitespace-nowrap text-xs text-muted-foreground">
                      {fmt(s.at)}
                    </td>
                    <td className="max-w-[280px]">
                      <RedactableJson value={s.detail} />
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ── List view ────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Runs · {nestName}
        </h1>
        <div className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowTrigger((v) => !v)}
          >
            <Play className="h-3.5 w-3.5 mr-1" /> Trigger run
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Observability for this nest's agent runs. Select a run to inspect its
        step trace. Inputs and traces are visible only to write-tier callers.
      </p>

      {/* Trigger panel — creates the run record + bundle; does NOT execute. */}
      {showTrigger && (
        <div className="border border-border rounded-lg bg-card p-4 space-y-3">
          <div className="text-sm font-medium">Trigger a run</div>
          <p className="text-xs text-muted-foreground">
            This creates a run record and returns the executable bundle. The
            server never executes — an external runner (an agent, a worker, or
            the MCP <code className="font-mono">workflow_run</code> tool) must
            walk the bundle and report steps back, or the run stays{" "}
            <span className="font-mono">running</span>.
          </p>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              Agent / skill node
            </label>
            {runnables.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No skills or agents added for this nest.
              </p>
            ) : (
              <Select value={triggerAgent} onValueChange={setTriggerAgent}>
                <SelectTrigger className="w-full max-w-[420px]">
                  <SelectValue placeholder="Select an agent or skill node…" />
                </SelectTrigger>
                <SelectContent>
                  {runnables.map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      {n.title}
                      <span className="text-muted-foreground"> · {n.type}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              Inputs (optional JSON)
            </label>
            <Textarea
              value={triggerInputs}
              onChange={(e) => setTriggerInputs(e.target.value)}
              placeholder='{ "date": "2026-07-07" }'
              className="w-full max-w-[420px] font-mono text-xs"
              rows={3}
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={submitTrigger} disabled={triggering}>
              {triggering && (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              )}
              Create run
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowTrigger(false)}
              disabled={triggering}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Status</label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Agent node</label>
          <Input
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
            placeholder="Filter by agent node…"
            className="w-[220px]"
          />
        </div>
      </div>

      {/* Runs table */}
      <div className="border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground text-xs">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th>Agent</th>
              <th>Status</th>
              <th>Triggered by</th>
              <th>Started</th>
              <th>Finished</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-8 text-center text-muted-foreground"
                >
                  <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                  Loading…
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-8 text-center text-muted-foreground"
                >
                  No runs match. Runs appear here once agents execute in this
                  nest.
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => openRun(r)}
                  className="border-t border-border align-top cursor-pointer hover:bg-accent/50 [&>td]:px-3 [&>td]:py-2"
                >
                  <td className="font-mono font-medium whitespace-nowrap">
                    {r.agent_node}
                  </td>
                  <td className="whitespace-nowrap">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="whitespace-nowrap">{r.triggered_by}</td>
                  <td className="whitespace-nowrap text-xs text-muted-foreground">
                    {fmt(r.started_at)}
                  </td>
                  <td className="whitespace-nowrap text-xs text-muted-foreground">
                    {fmt(r.finished_at)}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
