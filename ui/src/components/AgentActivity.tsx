/**
 * One metacognition agent's track record: how its runs ended, what they cost,
 * how reviewers judged its proposals, and its recent runs with a way into each
 * trace. Opened from the agent's row in Workflows → Agents.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowUpRight, Loader2 } from "lucide-react";
import { getMetacognitionStats, type AgentRunOutcome, type AgentStats } from "../lib/api";
import { formatServerDate } from "../lib/dates";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

const WINDOWS = [7, 30, 90] as const;

const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
const fmtCost = (n: number | null) => (n === null ? "—" : n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);
const fmtPct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);
function fmtDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
const trigger = (t: string) => (t.startsWith("schedule:") ? "Schedule" : "Manual");

const OUTCOME_LABEL: Record<AgentRunOutcome, string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  timeout: "Timed out",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

/** The label carries the meaning; color only reinforces it. */
function OutcomeBadge({ outcome }: { outcome: AgentRunOutcome }) {
  const tone =
    outcome === "failed"
      ? "border-destructive/40 text-destructive"
      : outcome === "timeout"
        ? "border-amber-500/50 text-amber-700 dark:text-amber-400"
        : outcome === "succeeded"
          ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
          : "text-muted-foreground";
  return (
    <Badge variant="outline" className={cn("text-[10px] font-medium whitespace-nowrap", tone)}>
      {outcome === "running" && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
      {OUTCOME_LABEL[outcome]}
    </Badge>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border bg-card px-3 py-2.5 min-w-0">
      <div className="text-[11px] text-muted-foreground truncate">{label}</div>
      <div className="text-lg font-semibold tabular-nums leading-tight mt-0.5">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground truncate mt-0.5">{sub}</div>}
    </div>
  );
}

export function AgentActivity({
  nestId,
  nodeId,
  onOpenRun,
  refreshKey,
}: {
  nestId: string;
  nodeId: string;
  onOpenRun?: (runId: string) => void;
  /** Bump to reload (e.g. after a run finishes). */
  refreshKey?: unknown;
}) {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    getMetacognitionStats(nestId, nodeId, days)
      .then((s) => {
        if (!live) return;
        setStats(s);
        setError(null);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : "Could not load activity"))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [nestId, nodeId, days, refreshKey]);

  const finished = stats ? stats.runs.total - stats.runs.running : 0;
  const decided = stats ? stats.proposals.approved + stats.proposals.rejected : 0;

  return (
    <div className="space-y-3" data-testid="agent-activity">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">Activity</span>
        <div className="flex-1" />
        <div className="inline-flex rounded-md border p-0.5" role="group" aria-label="Time window">
          {WINDOWS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              aria-pressed={days === d}
              className={cn(
                "px-2 py-0.5 text-[11px] rounded-sm transition-colors",
                days === d ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {loading && !stats ? (
        <div className="py-6 text-center text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin inline" />
        </div>
      ) : stats ? (
        <>
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="agent-activity-tiles">
            <Tile
              label="Runs"
              value={String(stats.runs.total)}
              sub={`${stats.runs.succeeded} ok · ${stats.runs.failed + stats.runs.timeout} failed · ${stats.runs.skipped} skipped`}
            />
            <Tile
              label="Success rate"
              value={finished ? fmtPct(stats.runs.succeeded / finished) : "—"}
              sub={stats.runs.timeout ? `${stats.runs.timeout} hit the time cap` : "of finished runs"}
            />
            <Tile
              label="Proposals approved"
              value={decided ? `${stats.proposals.approved} / ${decided}` : String(stats.proposals.made)}
              sub={
                decided
                  ? `${fmtPct(stats.proposals.approval_rate)} approval · ${stats.proposals.pending} waiting`
                  : stats.proposals.made
                    ? `${stats.proposals.pending} waiting for review`
                    : "none made"
              }
            />
            <Tile
              label="Comments"
              value={String(stats.comments)}
              sub={stats.blocked_by_scope ? `${stats.blocked_by_scope} blocked by scope` : "posted on documents"}
            />
            <Tile
              label="Tokens"
              value={fmtTokens(stats.tokens)}
              sub={finished ? `~${fmtTokens(Math.round(stats.tokens / finished))} per run` : undefined}
            />
            <Tile label="Estimated cost" value={fmtCost(stats.est_cost_usd)} sub={`last ${stats.window_days} days`} />
          </div>

          {stats.last_error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium">Last error · {formatServerDate(stats.last_error.at)}</div>
                <div className="text-muted-foreground font-mono break-all line-clamp-2">{stats.last_error.message}</div>
              </div>
              {onOpenRun && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs shrink-0"
                  onClick={() => onOpenRun(stats.last_error!.run_id)}
                >
                  Trace
                </Button>
              )}
            </div>
          )}

          {stats.history.length === 0 ? (
            <p className="text-xs text-muted-foreground">No runs in the last {stats.window_days} days.</p>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-xs" data-testid="agent-activity-history">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr className="text-left">
                    <th className="font-medium px-3 py-1.5">Started</th>
                    <th className="font-medium px-3 py-1.5">Outcome</th>
                    <th className="font-medium px-3 py-1.5">Trigger</th>
                    <th className="font-medium px-3 py-1.5 text-right">Duration</th>
                    <th className="font-medium px-3 py-1.5 text-right">Tokens</th>
                    <th className="font-medium px-3 py-1.5 text-right">Cost</th>
                    <th className="font-medium px-3 py-1.5">Proposals</th>
                    <th className="px-3 py-1.5">
                      <span className="sr-only">Trace</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {stats.history.map((h) => (
                    <tr key={h.id} className="hover:bg-muted/30">
                      <td className="px-3 py-1.5 whitespace-nowrap">{formatServerDate(h.started_at)}</td>
                      <td className="px-3 py-1.5" title={h.error ?? undefined}>
                        <OutcomeBadge outcome={h.outcome} />
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{trigger(h.triggered_by)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtDuration(h.duration_ms)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtTokens(h.tokens)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{fmtCost(h.est_cost_usd)}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        {h.proposals === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <>
                            {h.proposals}
                            {(h.approved > 0 || h.rejected > 0) && (
                              <span className="text-muted-foreground">
                                {" "}(
                                {[h.approved ? `${h.approved} approved` : "", h.rejected ? `${h.rejected} rejected` : ""]
                                  .filter(Boolean)
                                  .join(", ")}
                                )
                              </span>
                            )}
                          </>
                        )}
                        {h.comments > 0 && (
                          <span className="text-muted-foreground">
                            {" "}· {h.comments} comment{h.comments === 1 ? "" : "s"}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {onOpenRun && (
                          <button
                            type="button"
                            onClick={() => onOpenRun(h.id)}
                            className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground"
                            data-testid="agent-activity-trace"
                          >
                            Trace <ArrowUpRight className="h-3 w-3" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
