/**
 * Control room → Decision ledger (po-1186 CR2): every agent decision in the
 * range — including the decisions to do nothing — with filters, the totals
 * for the filtered range, export, and a drill-down trace drawer. Private-nest
 * rows render "DM · private nest · title hidden" for anyone but the owner
 * (N1, AC-CR-07c): the server already removed their title, source and people.
 *
 * At 1440 it is a table; under 800px each row is two lines (title + verdict,
 * then when · agent · outcome) and the rest lives in the drawer — the
 * prototype's six-line stacked rows made a 25-row page about 5,600px tall.
 */
import { useEffect, useMemo, useState } from "react";
import { Download, FileText, Hash, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { getLedger, getRollups, ledgerExportUrl, type CrLedgerPage } from "../../../lib/api";
import {
  STATE_BADGE,
  agentRows,
  fmtWhen,
  sourceCell,
  usd,
  verdictBadge,
  whatCell,
  type LedgerEntry,
  type VerdictFilter,
} from "../../../lib/control-room-overview";
import { AgentIcon, Card, EmptyState, ErrorLine, Loading, ToneBadge } from "./parts";
import { useRead, type ControlRoomScope } from "./scope";
import { TraceSheet } from "./TraceSheet";
import { cn } from "@/lib/utils";

const PAGE = 25;
const VERDICTS: Array<{ value: VerdictFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "propose", label: "Proposed" },
  { value: "no_op", label: "No proposal" },
  { value: "error", label: "Failed" },
];

export function Ledger({
  scope,
  openEntry,
  onOpenEntry,
  onSetup,
  onAgents,
  onOpenDoc,
}: {
  scope: ControlRoomScope;
  openEntry: string | null;
  onOpenEntry: (id: string | null) => void;
  onSetup: (() => void) | null;
  onAgents: () => void;
  onOpenDoc: (nestId: string, nodeId: string) => void;
}) {
  const { nestId, range, tick } = scope;
  const [verdict, setVerdict] = useState<VerdictFilter>("all");
  const [agent, setAgent] = useState<string>("");
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const filters = { from: range.from, to: range.to, verdict: verdict === "all" ? undefined : verdict, agent: agent || undefined, q: q || undefined };
  const [pages, setPages] = useState<CrLedgerPage[]>([]);
  const [more, setMore] = useState(false);
  const first = useRead(() => getLedger(nestId, { ...filters, limit: PAGE }), [nestId, range.from, tick, verdict, agent, q]);
  useEffect(() => setPages(first.data ? [first.data] : []), [first.data]);
  const agents = useRead(() => getRollups(nestId, { from: range.from, to: range.to, by: "agent", grain: "week" }), [nestId, range.from, tick]);
  const agentOptions = useMemo(() => agentRows(agents.data?.rows ?? []), [agents.data]);

  const entries = pages.flatMap((p) => p.entries);
  const last = pages[pages.length - 1];
  const totals = first.data?.totals;

  const loadMore = async () => {
    if (!last?.next_cursor) return;
    setMore(true);
    try {
      const next = await getLedger(nestId, { ...filters, limit: PAGE, cursor: last.next_cursor });
      setPages((p) => [...p, next]);
    } finally {
      setMore(false);
    }
  };

  const noData = !!agents.data && agents.data.totals.entries === 0;
  const filtered = verdict !== "all" || !!agent || !!q;

  return (
    <div className="space-y-3" data-testid="cr-ledger">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-56 sm:max-w-xs">
          <span className="sr-only">Search titles</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={qInput} onChange={(e) => setQInput(e.target.value)} placeholder="Search titles" className="h-9 pl-8" disabled={noData} />
        </label>
        <div role="group" aria-label="Verdict" className="flex flex-wrap gap-1.5">
          {VERDICTS.map((v) => (
            <button
              key={v.value}
              type="button"
              aria-pressed={verdict === v.value}
              disabled={noData}
              onClick={() => setVerdict(v.value)}
              className={cn(
                "h-8 rounded-full border px-3 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                verdict === v.value ? "border-foreground bg-foreground text-background" : "bg-background text-foreground hover:bg-muted",
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
        <select
          aria-label="Agent"
          className="h-9 min-w-0 max-w-full rounded-md border bg-background px-2 text-sm sm:w-56"
          value={agent}
          disabled={noData}
          onChange={(e) => setAgent(e.target.value)}
        >
          <option value="">All agents</option>
          {[...new Map(agentOptions.map((a) => [a.nodeId, a])).values()].map((a) => (
            <option key={a.nodeId} value={a.nodeId}>
              {a.name}
            </option>
          ))}
        </select>
        <div className="ml-auto">
          <ExportButton scope={scope} disabled={noData} query={filters} />
        </div>
      </div>

      {first.error && !first.data && <ErrorLine text={first.error} />}
      {!first.data && !first.error && <Loading what="the ledger" />}
      {first.data && noData && (
        <EmptyState icon={FileText} title="No agent actions yet" testId="cr-empty-ledger">
          <p>
            Every time an agent looks at something and decides, it lands here, including the times it decides to do nothing. Listeners start writing rows once a channel is on. Your own agents can report through the API.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {onSetup && <Button onClick={onSetup}>Set up Slack</Button>}
            <Button variant="outline" onClick={onAgents}>
              Connect an agent
            </Button>
          </div>
        </EmptyState>
      )}
      {first.data && !noData && totals && (
        <>
          <p className="text-sm text-muted-foreground" data-testid="cr-ledger-totals">
            <b className="font-semibold tabular-nums text-foreground">{totals.entries.toLocaleString()}</b> rows ·{" "}
            <span className="tabular-nums">{totals.no_op.toLocaleString()}</span> no proposal ·{" "}
            <span className="tabular-nums">{(totals.propose + totals.act).toLocaleString()}</span> proposed or acted ·{" "}
            <span className="tabular-nums">{totals.error.toLocaleString()}</span> failed · <span className="tabular-nums">{usd(totals.cost_usd)}</span>
          </p>
          {entries.length === 0 ? (
            <p className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
              {filtered ? "No rows match these filters in this range." : "No rows in this range."}
            </p>
          ) : (
            <Card className="overflow-hidden">
              <LedgerTable entries={entries} onOpen={onOpenEntry} />
              <LedgerList entries={entries} onOpen={onOpenEntry} />
            </Card>
          )}
          {last?.next_cursor && (
            <div className="flex items-center justify-center gap-2">
              <Button variant="outline" onClick={loadMore} disabled={more}>
                {more ? "Loading…" : `Show ${PAGE} more`}
              </Button>
              <span className="text-sm text-muted-foreground tabular-nums">
                {entries.length} of {totals.entries.toLocaleString()}
              </span>
            </div>
          )}
        </>
      )}
      <TraceSheet entryId={openEntry} known={entries.find((e) => e.entry_id === openEntry) ?? null} onClose={() => onOpenEntry(null)} onOpenDoc={onOpenDoc} />
    </div>
  );
}

function Outcome({ e }: { e: LedgerEntry }) {
  const st = e.proposal?.state;
  if (st && STATE_BADGE[st]) {
    const [tone, text] = STATE_BADGE[st];
    const who = e.review?.by && st !== "pending" && st !== "expired" ? `${e.review.by}${e.review.reason ? `: ${e.review.reason}` : ""}` : null;
    return (
      <div className="min-w-0">
        <ToneBadge tone={tone}>{text}</ToneBadge>
        {who && (
          <div className="mt-0.5 max-w-[14rem] truncate text-sm text-muted-foreground" title={who}>
            {who}
          </div>
        )}
      </div>
    );
  }
  if (e.verdict.code === "act") return <ToneBadge tone="outline">Acted outside the nest</ToneBadge>;
  return <span className="text-muted-foreground">–</span>;
}

function Source({ e }: { e: LedgerEntry }) {
  const s = sourceCell(e);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1", s.muted && "text-muted-foreground", s.mono && "font-mono text-[13px]")}>
      {s.channel && <Hash className="h-3.5 w-3.5 shrink-0" aria-hidden />}
      <span className="[overflow-wrap:anywhere]">{s.text}</span>
    </span>
  );
}

function rowKeys(onOpen: (id: string) => void, id: string) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: () => onOpen(id),
    onKeyDown: (ev: React.KeyboardEvent) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        onOpen(id);
      }
    },
  };
}

function LedgerTable({ entries, onOpen }: { entries: LedgerEntry[]; onOpen: (id: string) => void }) {
  return (
    <table className="hidden w-full text-sm min-[801px]:table" data-testid="cr-ledger-table">
      <thead>
        <tr className="border-b text-left text-muted-foreground">
          <th className="px-3 py-2.5 font-normal">When</th>
          <th className="px-3 py-2.5 font-normal">Agent</th>
          <th className="px-3 py-2.5 font-normal">Verdict</th>
          <th className="px-3 py-2.5 font-normal">What</th>
          <th className="px-3 py-2.5 font-normal">Outcome</th>
          <th className="px-3 py-2.5 font-normal">Source</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => {
          const w = whatCell(e);
          const [tone, label] = verdictBadge(e.verdict.code);
          return (
            <tr
              key={e.entry_id}
              {...rowKeys(onOpen, e.entry_id)}
              aria-label={`Open the trace for ${w.title}`}
              data-testid="cr-ledger-row"
              data-entry={e.entry_id}
              className="cursor-pointer border-b align-top last:border-b-0 hover:bg-muted/60 focus:bg-muted/60 focus:outline-none"
            >
              <td className="whitespace-nowrap px-3 py-3 tabular-nums text-muted-foreground">{fmtWhen(e.at)}</td>
              <td className="px-3 py-3">
                <span className="inline-flex items-center gap-1.5">
                  <AgentIcon source={e.agent.source} className="h-3.5 w-3.5" />
                  <span className="[overflow-wrap:anywhere]">{e.agent.name ?? "Agent"}</span>
                </span>
              </td>
              <td className="px-3 py-3">
                <ToneBadge tone={tone}>{label}</ToneBadge>
              </td>
              <td className="min-w-0 px-3 py-3">
                <div className={cn("[overflow-wrap:anywhere]", w.redacted && "text-muted-foreground")} data-testid="cr-ledger-what">
                  {w.title}
                </div>
                {w.sub && <div className="text-sm text-muted-foreground">{w.sub}</div>}
              </td>
              <td className="px-3 py-3">
                <Outcome e={e} />
              </td>
              <td className="px-3 py-3">
                <Source e={e} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function LedgerList({ entries, onOpen }: { entries: LedgerEntry[]; onOpen: (id: string) => void }) {
  return (
    <ul className="divide-y min-[801px]:hidden" data-testid="cr-ledger-list">
      {entries.map((e) => {
        const w = whatCell(e);
        const [tone, label] = verdictBadge(e.verdict.code);
        const st = e.proposal?.state && STATE_BADGE[e.proposal.state] ? STATE_BADGE[e.proposal.state][1] : null;
        return (
          <li
            key={e.entry_id}
            {...rowKeys(onOpen, e.entry_id)}
            data-testid="cr-ledger-row"
            data-entry={e.entry_id}
            className="cursor-pointer px-4 py-3 hover:bg-muted/60 focus:bg-muted/60 focus:outline-none"
          >
            <div className="flex items-start gap-2">
              <span className={cn("min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]", w.redacted && "font-normal text-muted-foreground")}>{w.title}</span>
              <ToneBadge tone={tone} className="shrink-0">
                {label}
              </ToneBadge>
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
              <AgentIcon source={e.agent.source} className="h-3.5 w-3.5" />
              <span className="min-w-0 truncate">
                {fmtWhen(e.at)} · {e.agent.name ?? "Agent"}
                {st ? ` · ${st}` : ""}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * CSV export of the filtered range. The export route is per nest (each export
 * is logged in that nest's activity), so "All nests" asks which one.
 */
function ExportButton({ scope, disabled, query }: { scope: ControlRoomScope; disabled: boolean; query: { from: string; to: string; verdict?: string; agent?: string; q?: string } }) {
  const content = (
    <>
      <Download className="mr-1.5 h-4 w-4" aria-hidden />
      Export
    </>
  );
  if (scope.nestId) {
    return disabled ? (
      <Button variant="outline" disabled>
        {content}
      </Button>
    ) : (
      <Button variant="outline" asChild>
        <a href={ledgerExportUrl(scope.nestId, query)} download data-testid="cr-export">
          {content}
        </a>
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={disabled || scope.nests.length === 0} data-testid="cr-export">
          {content}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-[min(20rem,calc(100vw-2rem))]">
        <DropdownMenuLabel className="text-sm font-normal text-muted-foreground">Export one nest (logged in its activity)</DropdownMenuLabel>
        {scope.nests.map((n) => (
          <DropdownMenuItem key={n.id} asChild>
            <a href={ledgerExportUrl(n.id, query)} download>
              {n.name}
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
