/**
 * Admin activity log for a document, a folder, or the nest (CU-wdqcq03aw2).
 * Opened from ⋯ → Activity. Shows who changed, reviewed, commented on,
 * deleted, read, pulled or exported it — newest first, with the agent and the
 * surface (web/API or MCP) where known. GET /nests/:id/activity-log enforces
 * admin-only; the menus only draw the entry for owners and nest admins.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { History, Loader2, RefreshCw, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as api from "../lib/api";
import { formatServerDate } from "../lib/dates";
import { ACTIVITY_FILTERS, describeActivity, surfaceLabel } from "../lib/activity-log";

const PAGE_SIZE = 50;

export function ActivityLogPanel({
  nestId,
  scope,
  label,
  onClose,
  onOpenNode,
}: {
  nestId: string;
  scope: api.ActivityLogScope;
  /** What the log is for, shown in the header ("Pricing", "sales/", nest name). */
  label: string;
  onClose: () => void;
  /** Folder / nest logs link each row to its document. */
  onOpenNode?: (nodeId: string) => void;
}) {
  const [items, setItems] = useState<api.ActivityLogItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [actor, setActor] = useState("");
  const [debouncedActor, setDebouncedActor] = useState("");
  const reqSeq = useRef(0);
  const scopeKey = JSON.stringify(scope);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedActor(actor.trim()), 300);
    return () => clearTimeout(t);
  }, [actor]);

  const load = useCallback(
    async (offset: number) => {
      const seq = ++reqSeq.current;
      setLoading(true);
      setError(null);
      try {
        const types = ACTIVITY_FILTERS.find((f) => f.id === filter)?.types ?? [];
        const page = await api.getActivityLog(nestId, scope, {
          types,
          actor: debouncedActor || undefined,
          limit: PAGE_SIZE,
          offset,
        });
        if (seq !== reqSeq.current) return;
        setItems((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
        setHasMore(page.hasMore);
      } catch (e: any) {
        if (seq !== reqSeq.current) return;
        setError(e?.message || "Couldn't load activity.");
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nestId, scopeKey, filter, debouncedActor],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  const showDoc = scope.kind !== "node";

  return (
    <div
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l bg-background shadow-xl"
      role="dialog"
      aria-label={`Activity for ${label}`}
      data-testid="activity-log-panel"
    >
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <History className="h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Activity</div>
          <div className="truncate text-xs text-muted-foreground" title={label}>
            {label}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void load(0)}
          aria-label="Refresh"
          data-testid="activity-log-refresh"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" data-testid="activity-log-close">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex gap-2 border-b px-4 py-2">
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="h-8 w-40" data-testid="activity-log-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ACTIVITY_FILTERS.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative flex-1">
          <Search className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
          <Input
            className="h-8 pl-8"
            placeholder="Person (email)"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            data-testid="activity-log-actor"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-2">
        {error && (
          <div className="rounded border border-destructive/40 p-2 text-sm text-destructive" role="alert">
            {error}
          </div>
        )}
        {!error && !loading && items.length === 0 && (
          <div className="py-8 text-center text-sm text-muted-foreground">No activity yet.</div>
        )}
        <ul className="divide-y">
          {items.map((it) => {
            const surface = surfaceLabel(it.surface);
            return (
              <li key={it.id} className="py-2 text-sm" data-testid="activity-log-row" data-type={it.type}>
                <div className="break-words">{describeActivity(it)}</div>
                {showDoc && it.nodeId && (
                  <button
                    type="button"
                    className="mt-0.5 block max-w-full truncate text-left text-xs text-primary hover:underline"
                    onClick={() => onOpenNode?.(it.nodeId!)}
                    disabled={!onOpenNode}
                  >
                    {it.title || it.nodeId}
                  </button>
                )}
                {it.detail && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground" title={it.detail}>
                    {it.detail}
                  </div>
                )}
                <div className="mt-0.5 flex gap-2 text-xs text-muted-foreground">
                  <span>{formatServerDate(it.at)}</span>
                  {surface && <span>· {surface}</span>}
                </div>
              </li>
            );
          })}
        </ul>
        {loading && (
          <div className="flex justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {!loading && hasMore && (
          <div className="flex justify-center py-3">
            <Button variant="outline" size="sm" onClick={() => void load(items.length)} data-testid="activity-log-more">
              Load more
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
