/**
 * Message log — every message this server sent: email, Slack / Teams /
 * connector webhooks, in-app inbox rows, and persona (metacognition, Hootie)
 * comments. Superadmin only; the server enforces it and records every read in
 * the access log, which is the second tab here.
 *
 * Bodies are redacted on write (passwords, magic-link tokens, keys, webhook
 * URLs) and kept for the retention window set in Settings.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mail,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageTitle } from "@/components/ui/page-title";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import * as api from "../lib/api";
import type {
  MessageChannel,
  MessageLogView,
  MessageSenderKind,
  MessageStatus,
  OutboundMessageRow,
} from "../lib/api";
import { formatServerDate } from "../lib/dates";

const PAGE_SIZE = 50;

const CHANNEL_LABEL: Record<MessageChannel, string> = {
  email: "Email",
  slack: "Slack",
  msteams: "Teams",
  webhook: "Webhook",
  inbox: "Inbox",
  comment: "Comment",
};

const STATUS_VARIANT: Record<MessageStatus, "success" | "rejected" | "neutral"> = {
  sent: "success",
  failed: "rejected",
  skipped: "neutral",
};

function Pager({
  page,
  total,
  size,
  loading,
  onPage,
}: {
  page: number;
  total: number;
  size: number;
  loading: boolean;
  onPage: (p: number) => void;
}) {
  const from = total === 0 ? 0 : page * size + 1;
  const to = Math.min((page + 1) * size, total);
  return (
    <div className="flex items-center gap-2">
      <span className="tabular-nums">
        {from}–{to} of {total}
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2"
        aria-label="Previous page"
        disabled={page === 0 || loading}
        onClick={() => onPage(Math.max(page - 1, 0))}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2"
        aria-label="Next page"
        disabled={(page + 1) * size >= total || loading}
        onClick={() => onPage(page + 1)}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function SenderCell({ row }: { row: OutboundMessageRow }) {
  if (row.sender_kind === "system") return <span className="text-muted-foreground">System</span>;
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="truncate" title={row.sender ?? ""}>
        {row.sender ?? "—"}
      </span>
      {row.sender_kind === "persona" && (
        <Badge variant="info" className="px-1.5 py-0 text-[10px] font-medium shrink-0">
          Agent
        </Badge>
      )}
    </span>
  );
}

/**
 * Inbox rows and webhook posts carry a machine label as their subject (the
 * notification kind, or the connector that posted). Show it as words.
 */
function subjectText(r: OutboundMessageRow): string {
  const s = r.subject ?? "";
  if (r.channel === "inbox" && /^[a-z_]+$/.test(s)) {
    const words = s.replace(/_/g, " ");
    return `${words.charAt(0).toUpperCase()}${words.slice(1)} notification`;
  }
  if (s === "server-slack" || s === "slack") return "Server Slack channel";
  if (s === "server-msteams" || s === "msteams") return "Server Teams channel";
  if (s.startsWith("connector:")) return "Nest connector";
  return s || "—";
}

function recipientsText(r: string[]): string {
  if (r.length === 0) return "—";
  return r.length === 1 ? r[0] : `${r[0]} +${r.length - 1}`;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-3 py-1.5 border-b border-border last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function MessageDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [msg, setMsg] = useState<OutboundMessageRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    setMsg(null);
    setError(null);
    api
      .getMessageLogEntry(id)
      .then((r) => setMsg(r.message))
      .catch((e) => setError(e?.message || "Failed to load message"));
  }, [id]);
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="pr-6">{msg ? subjectText(msg) : "Message"}</DialogTitle>
          <DialogDescription>
            Secrets are redacted before a message is stored. Opening it is recorded in the access log.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!msg && !error && (
          <div className="flex justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {msg && (
          <div className="space-y-4 text-sm">
            <dl>
              <Field label="Sent">{formatServerDate(msg.created_at)}</Field>
              <Field label="Channel">{CHANNEL_LABEL[msg.channel] ?? msg.channel}</Field>
              <Field label="From">
                <SenderCell row={msg} />
              </Field>
              <Field label="To">
                <span className="font-mono text-xs">{msg.recipients.join(", ") || "—"}</span>
              </Field>
              <Field label="Status">
                <Badge variant={STATUS_VARIANT[msg.status]} className="font-medium">
                  {msg.status}
                </Badge>
                {msg.error && <p className="mt-1 text-xs text-red-600">{msg.error}</p>}
              </Field>
              {msg.via_proxy != null && (
                <Field label="Route">{msg.via_proxy ? "Through the egress proxy" : "Direct"}</Field>
              )}
              {msg.nest_id && <Field label="Nest">{msg.nest_name || msg.nest_id}</Field>}
              {msg.node_id && (
                <Field label="Document">
                  <span className="font-mono text-xs">{msg.node_id}</span>
                </Field>
              )}
              {msg.run_id && (
                <Field label="Agent run">
                  <span className="font-mono text-xs">{msg.run_id}</span>
                </Field>
              )}
              {msg.provider_id && (
                <Field label="Provider ID">
                  <span className="font-mono text-xs">{msg.provider_id}</span>
                </Field>
              )}
            </dl>
            <div>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">Body</div>
              {msg.body ? (
                <pre className="max-h-80 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap break-words font-mono">
                  {msg.body}
                </pre>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No body stored — bodies are off in Settings, or this message had none.
                </p>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MessagesTab() {
  const [rows, setRows] = useState<OutboundMessageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [meta, setMeta] = useState<{ retention: number; bodies: boolean } | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<"all" | MessageChannel>("all");
  const [senderKind, setSenderKind] = useState<"all" | MessageSenderKind>("all");
  const [status, setStatus] = useState<"all" | MessageStatus>("all");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const reqSeq = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setPage(0), [channel, senderKind, status, debounced]);

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getMessageLog({
        channel: channel === "all" ? undefined : channel,
        sender_kind: senderKind === "all" ? undefined : senderKind,
        status: status === "all" ? undefined : status,
        q: debounced.trim() || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      if (seq !== reqSeq.current) return;
      setRows(res.messages);
      setTotal(res.total);
      setMeta({ retention: res.retention_days, bodies: res.store_bodies });
    } catch (e: any) {
      if (seq !== reqSeq.current) return;
      setError(e?.message || "Failed to load the message log");
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [channel, senderKind, status, debounced, page]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setDebounced(search)}
            placeholder="Search subject or recipient…"
            className="h-8 pl-8 w-64"
            aria-label="Search subject or recipient"
          />
        </div>
        <Select value={channel} onValueChange={(v) => setChannel(v as any)}>
          <SelectTrigger className="h-8 w-32" aria-label="Channel">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All channels</SelectItem>
            {(Object.keys(CHANNEL_LABEL) as MessageChannel[]).map((c) => (
              <SelectItem key={c} value={c}>
                {CHANNEL_LABEL[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={senderKind} onValueChange={(v) => setSenderKind(v as any)}>
          <SelectTrigger className="h-8 w-32" aria-label="Sender">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All senders</SelectItem>
            <SelectItem value="human">People</SelectItem>
            <SelectItem value="persona">Agents</SelectItem>
            <SelectItem value="system">System</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => setStatus(v as any)}>
          <SelectTrigger className="h-8 w-28" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any status</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
            <SelectItem value="skipped">Skipped</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" className="h-8" onClick={load} disabled={loading} aria-label="Refresh">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th>Time</th>
              <th>Channel</th>
              <th>From</th>
              <th>To</th>
              <th>Subject</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                  No messages match.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr
                key={r.id}
                tabIndex={0}
                onClick={() => setOpenId(r.id)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpenId(r.id)}
                className="border-t border-border cursor-pointer hover:bg-muted/40 focus:bg-muted/40 focus:outline-none [&>td]:px-3 [&>td]:py-2"
              >
                <td className="whitespace-nowrap text-muted-foreground tabular-nums">
                  {formatServerDate(r.created_at)}
                </td>
                <td className="whitespace-nowrap">{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                <td className="max-w-[220px]">
                  <SenderCell row={r} />
                </td>
                <td className="max-w-[220px] truncate font-mono" title={r.recipients.join(", ")}>
                  {recipientsText(r.recipients)}
                </td>
                <td className="max-w-[320px] truncate" title={r.subject ?? ""}>
                  {subjectText(r)}
                  {r.nest_name && <span className="text-muted-foreground"> · {r.nest_name}</span>}
                </td>
                <td>
                  <Badge variant={STATUS_VARIANT[r.status]} className="px-1.5 py-0 text-[11px] font-medium">
                    {r.status}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {meta
            ? `Kept ${meta.retention === 0 ? "forever" : `${meta.retention} days`} · bodies ${
                meta.bodies ? "stored, redacted" : "not stored"
              } · change in Settings`
            : "Newest first."}
        </span>
        <Pager page={page} total={total} size={PAGE_SIZE} loading={loading} onPage={setPage} />
      </div>
      <MessageDetail id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

const ACTION_LABEL: Record<MessageLogView["action"], string> = {
  list: "Searched the log",
  detail: "Opened a message",
  views: "Viewed the access log",
};

function AccessTab() {
  const [rows, setRows] = useState<MessageLogView[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getMessageLogViews({ limit: PAGE_SIZE, offset: page * PAGE_SIZE });
      setRows(res.views);
      setTotal(res.total);
    } catch (e: any) {
      setError(e?.message || "Failed to load the access log");
    } finally {
      setLoading(false);
    }
  }, [page]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Every look at the message log, kept for a year. This view is recorded too.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:font-medium">
              <th>Time</th>
              <th>Who</th>
              <th>What</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={4} className="px-3 py-10 text-center text-muted-foreground">
                  No access recorded yet.
                </td>
              </tr>
            )}
            {rows.map((v) => (
              <tr key={v.id} className="border-t border-border [&>td]:px-3 [&>td]:py-2">
                <td className="whitespace-nowrap text-muted-foreground tabular-nums">{formatServerDate(v.at)}</td>
                <td className="max-w-[220px] truncate">{v.viewer ?? "—"}</td>
                <td className="whitespace-nowrap">{ACTION_LABEL[v.action] ?? v.action}</td>
                <td className="max-w-[360px] truncate font-mono text-muted-foreground">
                  {v.message_id
                    ? v.message_id
                    : v.filters && Object.keys(v.filters).length
                      ? Object.entries(v.filters)
                          .map(([k, val]) => `${k}=${val}`)
                          .join("  ")
                      : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end text-xs text-muted-foreground">
        <Pager page={page} total={total} size={PAGE_SIZE} loading={loading} onPage={setPage} />
      </div>
    </div>
  );
}

export function MessageLogPage() {
  const [tab, setTab] = useState("messages");
  return (
    <div className="space-y-4">
      <PageTitle icon={Mail} title="Message log" className="mb-0" />
      <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span>
          Everything this server sent — email, Slack and Teams, webhooks, inbox notifications, and agent comments —
          across every nest. Visible to superadmins only. Passwords, sign-in links, keys and webhook URLs are redacted
          before storage, and every view is recorded in the access log.
        </span>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="access">Access log</TabsTrigger>
        </TabsList>
        <TabsContent value="messages" className="mt-3">
          <MessagesTab />
        </TabsContent>
        <TabsContent value="access" className="mt-3">
          {tab === "access" && <AccessTab />}
        </TabsContent>
      </Tabs>
    </div>
  );
}
