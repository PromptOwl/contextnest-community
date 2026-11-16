/**
 * Context pull log + compiled-context trace — the side panel of the Graph
 * view's retrieval replay (po-1252). Pure presentation: the Graph view owns
 * the data, the selected pull and the replay clock.
 */
import { ArrowLeft, ExternalLink, FileText, Loader2, RefreshCw, RotateCcw, Route, Search } from "lucide-react";
import type { ContextPull, PullStep } from "../lib/api";
import { formatBytes, pullTitle, relativeTime, stepHowLabel, toolLabel } from "../lib/pull-replay";
import { cn } from "@/lib/utils";

function ToolIcon({ tool, className }: { tool: string | null; className?: string }) {
  const Icon = tool === "context_search" || tool === "search" ? Search : tool === "context_get" || tool === "version" || !tool ? FileText : Route;
  return <Icon className={className} aria-hidden />;
}

function Meta({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-muted-foreground tabular-nums">{children}</span>;
}

export function PullList({
  pulls,
  loading,
  error,
  accessLogEnabled,
  identities,
  hasMore,
  selectedId,
  onSelect,
  onLoadMore,
  onRefresh,
}: {
  pulls: ContextPull[];
  loading: boolean;
  error: string | null;
  accessLogEnabled: boolean;
  identities: boolean;
  hasMore: boolean;
  selectedId: string | null;
  onSelect: (p: ContextPull) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <div>
          <div className="text-sm font-medium">Context pulls</div>
          <div className="text-xs text-muted-foreground">
            {identities ? "What agents and people retrieved. Click one to replay it." : "What was retrieved. Click one to replay it."}
          </div>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh pulls"
          title="Refresh"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
        </button>
      </div>
      {error ? (
        <p className="px-3 pb-3 text-xs text-red-600">{error}</p>
      ) : !accessLogEnabled && pulls.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-muted-foreground">
          The access log is off for this nest, so pulls aren't recorded. The owner can turn it on in nest settings.
        </p>
      ) : pulls.length === 0 && !loading && hasMore ? (
        <p className="px-3 pb-3 text-xs text-muted-foreground">
          None of the most recent pulls touched documents you can read. Older pulls may have.
        </p>
      ) : pulls.length === 0 && !loading ? (
        <p className="px-3 pb-3 text-xs text-muted-foreground">
          No pulls yet. When an agent or a teammate retrieves context from this nest, each pull shows up here and can be replayed on the graph.
        </p>
      ) : (
        <ul className="border-t border-border" data-testid="graph-pull-list">
          {pulls.map((p) => (
            <li key={p.id} className="border-b border-border last:border-b-0">
              <button
                type="button"
                data-testid="graph-pull-item"
                aria-pressed={selectedId === p.id}
                onClick={() => onSelect(p)}
                className={cn(
                  "flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selectedId === p.id && "bg-accent",
                )}
              >
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
                  <ToolIcon tool={p.tool} className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">{pullTitle(p)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground" title={new Date(p.at).toLocaleString()}>
                      {relativeTime(p.at)}
                    </span>
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground tabular-nums">
                    <span>{toolLabel(p.tool, p.action)}</span>
                    <span aria-hidden>·</span>
                    <span>
                      {p.documents} doc{p.documents === 1 ? "" : "s"}
                    </span>
                    {p.bytes != null && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{formatBytes(p.bytes)}</span>
                      </>
                    )}
                    {p.maxHop != null && p.maxHop > 0 && (
                      <>
                        <span aria-hidden>·</span>
                        <span>
                          {p.maxHop} hop{p.maxHop === 1 ? "" : "s"}
                        </span>
                      </>
                    )}
                  </span>
                  {p.agent && p.actor && (
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">for {p.actor}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {loading && pulls.length === 0 && (
        <div className="flex items-center gap-2 px-3 pb-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading pulls…
        </div>
      )}
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loading}
          className="border-t border-border px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          Older pulls
        </button>
      )}
    </div>
  );
}

export function PullTrace({
  pull,
  step,
  playing,
  drawn,
  titleOf,
  onBack,
  onReplay,
  onJump,
  onOpenDocument,
}: {
  pull: ContextPull;
  /** Index of the step lit last. */
  step: number;
  playing: boolean;
  /** Document ids drawn on the canvas — others can't light up. */
  drawn: Set<string>;
  titleOf: (id: string) => string;
  onBack: () => void;
  onReplay: () => void;
  onJump: (i: number) => void;
  onOpenDocument?: (id: string) => void;
}) {
  const who = pull.agent && pull.actor ? `for ${pull.actor}` : null;
  return (
    <div className="flex flex-col" data-testid="graph-pull-trace">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-2">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> All pulls
        </button>
        <button
          type="button"
          onClick={onReplay}
          data-testid="graph-pull-replay-button"
          className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-accent"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Replay
        </button>
      </div>

      <div className="space-y-3 px-3 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ToolIcon tool={pull.tool} className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="truncate text-sm font-semibold">{pullTitle(pull)}</div>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <code className="rounded bg-muted px-1 py-px font-mono text-[11px] text-foreground">{pull.tool ?? pull.action}</code>
            <span>{pull.surface === "mcp" ? "MCP" : "API"}</span>
            {who && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{who}</span>
              </>
            )}
            <span aria-hidden>·</span>
            <span title={new Date(pull.at).toLocaleString()}>{relativeTime(pull.at)}</span>
          </div>
        </div>

        <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-border bg-border text-center">
          {(
            [
              ["Documents", String(pull.documents)],
              ["Size", formatBytes(pull.bytes)],
              ["Depth", pull.maxHop == null ? "—" : pull.maxHop === 0 ? "Direct" : `${pull.maxHop} hop${pull.maxHop === 1 ? "" : "s"}`],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="bg-card px-2 py-1.5">
              <dt className="text-[11px] text-muted-foreground">{k}</dt>
              <dd className="text-sm font-medium tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="px-3 pb-1 text-xs font-medium text-muted-foreground">Compiled context, in order</div>
      <ol className="pb-2" aria-label="Compiled context">
        {pull.steps.map((s: PullStep, i) => {
          const lit = i <= step;
          const current = i === step && playing;
          const how = stepHowLabel(s, titleOf);
          const offCanvas = !drawn.has(s.nodeId);
          return (
            <li key={`${s.nodeId}-${i}`}>
              <div
                data-testid="graph-pull-step"
                data-lit={lit ? "true" : "false"}
                className={cn(
                  "group flex items-start gap-2.5 px-3 py-1.5 transition-colors",
                  i === step ? "bg-orange-50 dark:bg-orange-950/40" : "hover:bg-accent",
                )}
              >
                <button
                  type="button"
                  onClick={() => onJump(i)}
                  aria-label={`Show step ${i + 1}`}
                  className={cn(
                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold tabular-nums transition-colors",
                    lit ? "border-orange-600 bg-orange-600 text-white" : "border-border text-muted-foreground",
                    current && "ring-2 ring-orange-300",
                  )}
                >
                  {i + 1}
                </button>
                <button type="button" onClick={() => onJump(i)} className={cn("min-w-0 flex-1 text-left", !lit && "opacity-60")}>
                  <span className="block truncate text-sm">{s.title ?? titleOf(s.nodeId)}</span>
                  <span className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground tabular-nums">
                    {s.version != null && <span>v{s.version}</span>}
                    {s.version != null && <span aria-hidden>·</span>}
                    <span>{formatBytes(s.bytes)}</span>
                    {how && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{how}</span>
                      </>
                    )}
                    {offCanvas && (
                      <>
                        <span aria-hidden>·</span>
                        <span>not on the graph</span>
                      </>
                    )}
                  </span>
                </button>
                {onOpenDocument && (
                  <button
                    type="button"
                    onClick={() => onOpenDocument(s.nodeId)}
                    aria-label={`Open ${s.title ?? titleOf(s.nodeId)}`}
                    title="Open document"
                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {pull.steps.some((s) => s.hop == null) && (
        <p className="px-3 pb-3 text-xs text-muted-foreground">
          <Meta>This call's walk through the graph isn't recorded, so links between documents it returned stand in for the path.</Meta>
        </p>
      )}
    </div>
  );
}
