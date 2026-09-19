/**
 * Activity trace — every API request and MCP tool call in one simple
 * newest-first table. Operator audit surface: who, what, where, outcome,
 * how long. Two modes:
 *   - server-wide (default): GET /admin/trace, server-admin only.
 *   - nest-scoped (`nestId` prop): GET /nests/:id/trace, owner/nest-admin
 *     only — the server pins every row to that nest, so the nest column
 *     and filter are hidden.
 * The endpoints enforce authorization either way.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ScrollText,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageTitle } from "@/components/ui/page-title";
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
import { formatClient, type ClientAttribution } from "../lib/client-attribution";

interface TraceRow {
  id: number;
  ts: string;
  kind: "api" | "mcp";
  method: string | null;
  path: string | null;
  tool: string | null;
  nest_id: string | null;
  caller: string | null;
  status: number | null;
  duration_ms: number | null;
  /** Caller attribution the call carried (§9.4) — which agent, in which
   *  session. Absent when it carried none. Self-reported, never authenticated:
   *  `caller` above is the identity this server actually verified. */
  client?: ClientAttribution;
}

const PAGE_SIZE = 25;

export function ActivityTracePage({
  onBack,
  nestId,
}: {
  /** Nest-scoped only: the way out of the nest. The app page has the rail. */
  onBack?: () => void;
  /** Nest-scoped steward mode: fetch this nest's rows only, hide the nest column. */
  nestId?: string;
}) {
  const [rows, setRows] = useState<TraceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0); // 0-based
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"all" | "api" | "mcp">("all");
  const [user, setUser] = useState("");
  const [debouncedUser, setDebouncedUser] = useState("");

  // Monotonic request id — only the newest in-flight response is applied, so a
  // slow narrow query (e.g. "a") can't overwrite a later, more specific one
  // (e.g. "alice") that resolved first.
  const reqSeq = useRef(0);

  // Debounce the user filter into a single fetch 300ms after typing stops,
  // instead of one request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedUser(user), 300);
    return () => clearTimeout(t);
  }, [user]);

  // Any filter change resets to the first page (offset would otherwise point
  // past the end of a smaller filtered result set).
  useEffect(() => {
    setPage(0);
  }, [kind, debouncedUser]);

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    try {
      const params = {
        kind: kind === "all" ? undefined : kind,
        user: debouncedUser.trim() || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      };
      const res = nestId
        ? await api.getNestTrace(nestId, params)
        : await api.getAdminTrace(params);
      if (seq !== reqSeq.current) return; // superseded by a newer request
      setRows(res.events);
      setTotal(res.total);
    } catch (e: any) {
      if (seq !== reqSeq.current) return;
      setError(e?.message || "Failed to load trace");
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [kind, debouncedUser, page, nestId]);

  useEffect(() => {
    load();
  }, [load]);

  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, total);
  const hasPrev = page > 0;
  const hasNext = (page + 1) * PAGE_SIZE < total;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack} className="mt-1">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
        )}
        <PageTitle
          icon={ScrollText}
          title="Activity trace"
          className="mb-0 flex-1"
          actions={
        <>
          <Select value={kind} onValueChange={(v) => setKind(v as any)}>
            <SelectTrigger className="h-8 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="api">API</SelectItem>
              <SelectItem value="mcp">MCP</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && setDebouncedUser(user)}
              placeholder="Filter by user…"
              className="h-8 pl-8 w-48"
            />
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
        </>
          }
        />
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th>Time</th>
              <th>Kind</th>
              <th>Call</th>
              {!nestId && <th>Nest</th>}
              <th>Caller</th>
              <th>Status</th>
              <th className="text-right">ms</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={nestId ? 6 : 7} className="px-3 py-8 text-center text-muted-foreground">
                  No activity recorded yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border [&>td]:px-3 [&>td]:py-1.5">
                <td className="whitespace-nowrap text-muted-foreground">
                  {formatServerDate(r.ts)}
                </td>
                <td>
                  <span
                    className={
                      r.kind === "mcp"
                        ? "rounded bg-violet-50 text-violet-700 px-1.5 py-0.5"
                        : "rounded bg-blue-50 text-blue-700 px-1.5 py-0.5"
                    }
                  >
                    {r.kind}
                  </span>
                </td>
                <td className="font-mono max-w-[340px] truncate" title={r.path || r.tool || ""}>
                  {r.kind === "mcp" ? r.tool : `${r.method} ${r.path}`}
                </td>
                {!nestId && (
                  <td className="font-mono max-w-[120px] truncate" title={r.nest_id || ""}>
                    {r.nest_id || "—"}
                  </td>
                )}
                <td className="max-w-[180px] truncate" title={r.caller || ""}>
                  {r.caller || "—"}
                  {r.client && (
                    <div
                      className="text-[11px] text-muted-foreground truncate font-mono"
                      title={formatClient(r.client)}
                    >
                      {formatClient(r.client)}
                    </div>
                  )}
                </td>
                <td>
                  {r.status == null ? (
                    "—"
                  ) : (
                    <span className={r.status >= 400 ? "text-red-600" : "text-green-700"}>
                      {r.status}
                    </span>
                  )}
                </td>
                <td className="text-right text-muted-foreground">
                  {r.duration_ms ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Rolling retention window (server setting), newest first.</span>
        <div className="flex items-center gap-2">
          <span>
            {from}–{to} of {total}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            disabled={!hasPrev || loading}
            onClick={() => setPage((p) => Math.max(p - 1, 0))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2"
            disabled={!hasNext || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
