/**
 * Agent activity (CU-wdqcq0314v) — what agents did to this nest, with an Undo
 * per change. Lives on the Review tab beside the feed.
 *
 * Undo is decided by the server, twice: each row carries its verdict (why a
 * row can't be undone is shown next to the disabled button), and the undo
 * request re-checks at click time — the document may have changed since the
 * list loaded, in which case the 409's reason is shown and the list refreshed.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bot, Loader2, Undo2 } from "lucide-react";
import * as api from "../../lib/api";
import { keys } from "../../lib/queries";
import { timeAgo } from "./node-display";
import { kindLabel, undoPromise } from "../../lib/agent-activity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const PAGE = 50;

interface Props {
  nestId: string;
  onOpenDocument: (nodeId: string) => void;
}

export function AgentActivityPanel({ nestId, onOpenDocument }: Props) {
  const qc = useQueryClient();
  const [scope, setScope] = useState<"agents" | "all">("agents");
  const [agent, setAgent] = useState("");
  const [offset, setOffset] = useState(0);
  const [confirming, setConfirming] = useState<api.AgentActivityItem | null>(null);
  const [undoing, setUndoing] = useState(false);

  const q = useQuery({
    queryKey: keys.agentActivity(nestId, scope, agent, offset),
    queryFn: () => api.getAgentActivity(nestId, { scope, agent: agent || undefined, limit: PAGE, offset }),
  });
  const items = q.data?.items ?? [];
  // Agents seen on this page — enough to filter by without a second request.
  const agents = [...new Set(items.map((i) => i.agent).filter((a): a is string => !!a))].sort();

  const runUndo = async (item: api.AgentActivityItem) => {
    setUndoing(true);
    try {
      const res = await api.undoAgentChange(nestId, item.nodeId, item.version!);
      const doc = item.title || item.nodeId;
      if (res.effect === "restore") {
        toast.success(
          res.status === "draft"
            ? `Restored “${doc}” to version ${res.restoredVersion} as a draft — approve it to make it live`
            : `Restored “${doc}” to version ${res.restoredVersion}`,
        );
      } else if (res.effect === "discard") {
        toast.success(`Discarded the agent's draft of “${doc}”`);
      } else {
        toast.success(`Removed “${doc}”`);
      }
    } catch (e: any) {
      console.error("[AgentActivity] undo failed", nestId, item.nodeId, item.version, e);
      toast.error(e?.message || "Couldn't undo that change");
    } finally {
      setUndoing(false);
      setConfirming(null);
      // The nest changed (or the row's verdict did) — reread everything.
      void qc.invalidateQueries({ queryKey: keys.nest(nestId) });
    }
  };

  return (
    <Card data-testid="agent-activity-panel">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Bot className="h-4 w-4" />
          Agent activity
        </CardTitle>
        <CardDescription>
          Every change an agent made to this nest. Undo puts the document back through the normal
          review rules — nothing is erased from its history.
        </CardDescription>
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <div className="flex items-center gap-1" role="group" aria-label="Whose changes">
            {(["agents", "all"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setScope(s);
                  setOffset(0);
                }}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${
                  scope === s
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
                data-testid={`agent-activity-scope-${s}`}
              >
                {s === "agents" ? "Agents" : "Everyone"}
              </button>
            ))}
          </div>
          {(agents.length > 0 || agent) && (
            <select
              aria-label="Filter by agent"
              className="h-7 rounded-md border bg-background px-2 text-xs"
              value={agent}
              onChange={(e) => {
                setAgent(e.target.value);
                setOffset(0);
              }}
              data-testid="agent-activity-agent-filter"
            >
              <option value="">All agents</option>
              {[...new Set([...agents, ...(agent ? [agent] : [])])].map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {q.isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        )}
        {q.isError && (
          <p className="text-sm text-destructive">
            {(q.error as any)?.message || "Couldn't load agent activity."}
          </p>
        )}
        {!q.isLoading && !q.isError && items.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="agent-activity-empty">
            {scope === "agents"
              ? "No agent changes here that you can undo. Owners, admins and reviewers see what agents changed."
              : "No changes here that you can undo."}
          </p>
        )}
        {items.map((item) => (
          <div
            key={item.id}
            data-testid="agent-activity-item"
            className="flex items-start gap-3 rounded-md border px-3 py-2 text-sm"
          >
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="text-[10px]">
                  {kindLabel(item.kind)}
                </Badge>
                {item.kind === "delete" ? (
                  <span className="font-medium truncate">{item.nodeId}</span>
                ) : (
                  <button
                    type="button"
                    className="font-medium truncate text-left hover:underline"
                    onClick={() => onOpenDocument(item.nodeId)}
                  >
                    {item.title || item.nodeId}
                  </button>
                )}
                {item.version !== undefined && (
                  <span className="text-xs text-muted-foreground">v{item.version}</span>
                )}
                {item.status && item.status !== "published" && (
                  <Badge variant="secondary" className="text-[10px]">
                    {item.status.replace("_", " ")}
                  </Badge>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {item.agent ? (
                  <>
                    <span className="font-medium text-foreground">{item.agent}</span> as {item.actor}
                  </>
                ) : (
                  item.actor
                )}{" "}
                · {timeAgo(item.at)}
                {item.changeNote && <> · “{item.changeNote}”</>}
              </div>
              {!item.undo.available && item.undo.reason && (
                <div className="text-xs text-muted-foreground italic" data-testid="agent-activity-undo-reason">
                  {item.undo.reason}
                </div>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 h-7 px-2"
              disabled={!item.undo.available || undoing}
              title={item.undo.available ? "Undo this change" : item.undo.reason}
              onClick={() => setConfirming(item)}
              data-testid="agent-activity-undo"
            >
              <Undo2 className="h-3.5 w-3.5 mr-1" /> Undo
            </Button>
          </div>
        ))}
        {(offset > 0 || q.data?.hasMore) && (
          <div className="flex justify-between pt-1">
            <Button size="sm" variant="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Newer
            </Button>
            <Button size="sm" variant="ghost" disabled={!q.data?.hasMore} onClick={() => setOffset(offset + PAGE)}>
              Older
            </Button>
          </div>
        )}
      </CardContent>
      <AlertDialog open={!!confirming} onOpenChange={(open) => !open && !undoing && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo this change?</AlertDialogTitle>
            <AlertDialogDescription>{confirming ? undoPromise(confirming) : ""}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={undoing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={undoing}
              onClick={(e) => {
                e.preventDefault();
                if (confirming) void runUndo(confirming);
              }}
              data-testid="agent-activity-undo-confirm"
            >
              {undoing ? <Loader2 className="h-4 w-4 animate-spin" /> : "Undo"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
