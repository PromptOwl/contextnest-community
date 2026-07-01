/**
 * Superadmin activity trace — every API request and MCP tool call in one
 * simple newest-first table. Operator audit surface: who, what, where,
 * outcome, how long. Server-admin only (the endpoint enforces it too).
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Loader2, RefreshCw, Search } from "lucide-react";
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
}

export function ActivityTracePage({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<TraceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"all" | "api" | "mcp">("all");
  const [user, setUser] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { events } = await api.getAdminTrace({
        kind: kind === "all" ? undefined : kind,
        user: user.trim() || undefined,
      });
      setRows(events);
    } catch (e: any) {
      setError(e?.message || "Failed to load trace");
    } finally {
      setLoading(false);
    }
  }, [kind, user]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
          <h1 className="text-lg font-semibold">Activity trace</h1>
        </div>
        <div className="flex items-center gap-2">
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
              onKeyDown={(e) => e.key === "Enter" && load()}
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
        </div>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th>Time</th>
              <th>Kind</th>
              <th>Call</th>
              <th>Nest</th>
              <th>Caller</th>
              <th>Status</th>
              <th className="text-right">ms</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                  No activity recorded yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border [&>td]:px-3 [&>td]:py-1.5">
                <td className="whitespace-nowrap text-muted-foreground">
                  {new Date(r.ts).toLocaleString()}
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
                <td className="font-mono max-w-[120px] truncate" title={r.nest_id || ""}>
                  {r.nest_id || "—"}
                </td>
                <td className="max-w-[180px] truncate" title={r.caller || ""}>
                  {r.caller || "—"}
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
      <p className="text-xs text-muted-foreground">
        Rolling 14-day window, newest first, up to 200 rows per load.
      </p>
    </div>
  );
}
