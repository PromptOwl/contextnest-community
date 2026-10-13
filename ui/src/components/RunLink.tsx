/**
 * "agent run 1a2b3c4d" — the way back from something an agent produced (a
 * proposal, a comment, an access request) to the run that produced it. Opens
 * the nest's Workflows → Run tab on that run's trace (?run=<id>, read by
 * WorkflowsView). A run pruned by RUN_RETENTION_DAYS shows "no longer kept"
 * there rather than breaking the link.
 */
import { Bot } from "lucide-react";
import { nestPath } from "../lib/nest-url";
import { cn } from "../lib/utils";

export function runTraceHref(nestId: string, runId: string): string {
  return `${nestPath(nestId, "workflows")}?run=${encodeURIComponent(runId)}`;
}

/** run_<uuid> → the first 8 hex of the uuid; anything else, its first 8 chars. */
export function shortRunId(runId: string): string {
  return runId.replace(/^run_/, "").replace(/-/g, "").slice(0, 8);
}

export function RunLink({
  nestId,
  runId,
  className,
}: {
  nestId: string | null | undefined;
  runId: string | null | undefined;
  className?: string;
}) {
  if (!nestId || !runId) return null;
  return (
    <a
      href={runTraceHref(nestId, runId)}
      // Rows that hold this link are often clickable themselves.
      onClick={(e) => e.stopPropagation()}
      title="Filed by an agent run — open its step-by-step trace"
      className={cn(
        "inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline",
        className,
      )}
      data-testid="run-link"
    >
      <Bot className="h-3 w-3 shrink-0" />
      <span>
        agent run <span className="font-mono">{shortRunId(runId)}</span>
      </span>
    </a>
  );
}
