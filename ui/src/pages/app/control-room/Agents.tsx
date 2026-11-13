/**
 * Control room → Agents (po-1186 CR2): every agent that wrote decision-ledger
 * rows in the range — the Slack listeners, metacognition agents and agents
 * that report from outside through the agent event API — with its kind, runs,
 * how often people approved what it proposed, cost and its last report. Below,
 * how to connect your own agent (register → a nest-scoped write key → report).
 *
 * The one animation: when a refresh shows an agent reported since the last
 * read, its row comes to the top with a single background fade. Nothing moves
 * on a timer.
 */
import { useEffect, useRef, useState } from "react";
import { Bot, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getRollups, registerAgent } from "../../../lib/api";
import { SOURCE_LABEL, SOURCE_TEXT, agentRows, fmtWhen, usd, type AgentRow } from "../../../lib/control-room-overview";
import { AgentIcon, Card, CardHead, EmptyState, ErrorLine, Loading, Mono, ToneBadge } from "./parts";
import { useRead, type ControlRoomScope } from "./scope";
import { cn } from "@/lib/utils";

const FRESH_MS = 90 * 60_000;

export function Agents({ scope, onManageKeys }: { scope: ControlRoomScope; onManageKeys: () => void }) {
  const { nestId, range, tick } = scope;
  const roll = useRead(() => getRollups(nestId, { from: range.from, to: range.to, by: "agent", grain: "week" }), [nestId, range.from, tick]);
  const rows = roll.data ? agentRows(roll.data.rows) : null;
  // Arrival: an agent whose last report is newer than at the previous read.
  const seen = useRef<Map<string, string> | null>(null);
  const [arrived, setArrived] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!rows) return;
    const prev = seen.current;
    const next = new Map(rows.map((r) => [r.id, r.lastAt]));
    seen.current = next;
    if (!prev) return;
    const fresh = new Set(rows.filter((r) => (prev.get(r.id) ?? "") < r.lastAt).map((r) => r.id));
    if (!fresh.size) return;
    setArrived(fresh);
    const t = setTimeout(() => setArrived(new Set()), 1600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roll.data]);

  return (
    <div className="space-y-4" data-testid="cr-agents">
      {roll.error && !roll.data && <ErrorLine text={roll.error} />}
      {!roll.data && !roll.error && <Loading what="the agents" />}
      {rows && rows.length === 0 && (
        <EmptyState icon={Bot} title="No agents have reported yet" testId="cr-empty-agents">
          Listeners appear here once Slack is set up. Agents you run yourself, like Claude Code or a scheduled script, appear as soon as they post their first run.
        </EmptyState>
      )}
      {rows && rows.length > 0 && <AgentList rows={rows} days={range.days.length} arrived={arrived} nestName={scope.nestName} knownNest={(id) => scope.nests.some((n) => n.id === id)} showNest={!nestId && scope.nests.length > 1} />}
      <ConnectCard scope={scope} onManageKeys={onManageKeys} />
    </div>
  );
}

function AgentList({
  rows,
  days,
  arrived,
  nestName,
  knownNest,
  showNest,
}: {
  rows: AgentRow[];
  days: number;
  arrived: Set<string>;
  nestName: (id: string) => string;
  /** Nests the reader can name; a private nest stays unnamed (N1). */
  knownNest: (id: string) => boolean;
  showNest: boolean;
}) {
  const now = Date.now();
  return (
    <Card className="overflow-hidden" data-testid="cr-agent-list">
      <div className="hidden grid-cols-[minmax(0,2.4fr)_minmax(0,1.1fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,1fr)] gap-3 border-b px-4 py-2.5 text-sm text-muted-foreground min-[801px]:grid">
        <div>Agent</div>
        <div>Kind</div>
        <div>Last {days} days</div>
        <div>Reviewed</div>
        <div>Cost</div>
        <div>Last report</div>
      </div>
      <ul className="divide-y">
        {rows.map((a) => {
          const fresh = now - Date.parse(a.lastAt) < FRESH_MS;
          return (
            <li
              key={a.id}
              data-testid="cr-agent-row"
              data-agent={a.nodeId}
              className={cn(
                "grid grid-cols-1 motion-safe:transition-colors motion-safe:duration-1000 gap-x-3 gap-y-1 px-4 py-3 min-[801px]:grid-cols-[minmax(0,2.4fr)_minmax(0,1.1fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,1fr)] min-[801px]:items-center",
                arrived.has(a.id) && "bg-muted",
              )}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full border bg-muted/40" aria-hidden>
                  <AgentIcon source={a.source} />
                </span>
                <div className="min-w-0">
                  <div className="font-medium [overflow-wrap:anywhere]">{a.name}</div>
                  <div className="text-sm text-muted-foreground">
                    <span className="min-[801px]:hidden">{SOURCE_LABEL[a.source] ?? "Agent"}</span>
                    <span className="hidden min-[801px]:inline">{SOURCE_TEXT[a.source] ?? "Reports to the ledger."}</span>
                    {showNest && a.nestId && knownNest(a.nestId) && <span> · {nestName(a.nestId)}</span>}
                  </div>
                </div>
              </div>
              <div className="hidden min-[801px]:block">
                <ToneBadge tone={a.source === "external" ? "info" : "outline"}>{SOURCE_LABEL[a.source] ?? "Agent"}</ToneBadge>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 pl-11 text-sm min-[801px]:contents">
                <div className="tabular-nums">
                  {a.totals.entries.toLocaleString()} <span className="text-muted-foreground">runs</span>
                </div>
                <div className="tabular-nums">
                  {a.approvedPct === null ? "–" : `${a.approvedPct}%`} <span className="text-muted-foreground">approved</span>
                </div>
                <div className="tabular-nums">{usd(a.totals.cost_usd)}</div>
                <div className="inline-flex items-center gap-1.5 tabular-nums">
                  <i className={cn("h-2 w-2 rounded-full", fresh ? "bg-green-600" : "bg-zinc-400")} aria-hidden />
                  <span>{fmtWhen(a.lastAt)}</span>
                  <span className="sr-only">{fresh ? "(reported in the last 90 minutes)" : ""}</span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function ConnectCard({ scope, onManageKeys }: { scope: ControlRoomScope; onManageKeys: () => void }) {
  const [open, setOpen] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "https://nest.example.com";
  const nest = scope.nestId ?? "$NEST";
  const code = `# A Claude Code Stop hook: one run per session
API=${origin}; NEST=${nest}; AGENT=nodes/agents/claude-code
RUN=$(curl -s -H "Authorization: Bearer $NEST_KEY" -H "Idempotency-Key: cc-$SID" \\
  -d '{"report_only":true,"external_ref":"'$SID'"}' \\
  $API/nests/$NEST/run/$AGENT | jq -r .run_id)
curl -s -H "Authorization: Bearer $NEST_KEY" -H "Idempotency-Key: cc-$SID-d1" \\
  -d '{"action":"decision","detail":{"verdict":"no_op","reason_code":"duplicate"}}' \\
  $API/runs/$RUN/steps
curl -s -X PATCH -H "Authorization: Bearer $NEST_KEY" \\
  -d '{"status":"succeeded"}' $API/runs/$RUN`;
  return (
    <Card id="connect" data-testid="cr-connect">
      <CardHead title="Connect an agent" sub="Any agent can write its runs and decisions here. They show up in the ledger and the rollups next to the listeners." />
      <div className="px-4 pb-4 pt-3 text-sm sm:px-5">
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>
            Register it. That creates an agent document in <Mono>agents/</Mono>, so it is governed like anything else in the nest.
          </li>
          <li>Create a key for that nest only, with write access, labelled with the agent's name. A key for one nest is the only kind that can report.</li>
          <li>
            Report each run: start it, add a <Mono>decision</Mono> step (including "nothing to do"), and close it. A repeat with the same idempotency key is ignored.
          </li>
        </ol>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-zinc-900 p-3.5 text-[13px] leading-relaxed text-zinc-100" data-testid="cr-connect-code">
          <code>{code}</code>
        </pre>
        <p className="mt-2.5 text-muted-foreground">
          MCP: <Mono>context_agent_register</Mono>, <Mono>context_agent_run_start</Mono>, <Mono>context_agent_run_step</Mono>, <Mono>context_agent_run_close</Mono>. Full contract in API.md, under the agent event API.
        </p>
        <div className="mt-3.5 flex flex-wrap gap-2">
          <Button onClick={() => setOpen(true)} disabled={scope.nests.length === 0}>
            Register an agent
          </Button>
          <Button variant="outline" onClick={onManageKeys}>
            <KeyRound className="mr-1.5 h-4 w-4" aria-hidden />
            Create a nest key
          </Button>
        </div>
      </div>
      <RegisterDialog open={open} onOpenChange={setOpen} scope={scope} onManageKeys={onManageKeys} />
    </Card>
  );
}

function RegisterDialog({ open, onOpenChange, scope, onManageKeys }: { open: boolean; onOpenChange: (o: boolean) => void; scope: ControlRoomScope; onManageKeys: () => void }) {
  const [nest, setNest] = useState<string>(scope.nestId ?? scope.nests[0]?.id ?? "");
  const [name, setName] = useState("");
  const [runtime, setRuntime] = useState("claude-code");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ node_id: string; created: boolean } | null>(null);
  useEffect(() => {
    if (open) {
      setNest(scope.nestId ?? scope.nests[0]?.id ?? "");
      setError(null);
      setDone(null);
    }
  }, [open, scope.nestId, scope.nests]);
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await registerAgent(nest, { name: name.trim(), runtime: runtime.trim() || undefined, description: description.trim() || undefined });
      setDone(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't register the agent.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register an agent</DialogTitle>
          <DialogDescription>Creates an agent document in the nest's agents/ folder. Owner or admin of the nest.</DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="space-y-3 text-sm" data-testid="cr-register-done">
            <p>
              {done.created ? "Registered" : "Already registered"} as <Mono>{done.node_id}</Mono>. Next, create a key for {scope.nestName(nest)} with write access and use it in the agent's hook.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Done
              </Button>
              <Button onClick={onManageKeys}>Create a nest key</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cr-reg-nest">Nest</Label>
              <select id="cr-reg-nest" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={nest} onChange={(e) => setNest(e.target.value)}>
                {scope.nests.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-reg-name">Name</Label>
              <Input id="cr-reg-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Code (Priya's laptop)" maxLength={120} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-reg-runtime">Runs on</Label>
              <Input id="cr-reg-runtime" value={runtime} onChange={(e) => setRuntime(e.target.value)} placeholder="claude-code" maxLength={40} pattern="[a-z0-9_-]{1,40}" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cr-reg-desc">What it does</Label>
              <Input id="cr-reg-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Coding agent. Reports each session as a run." maxLength={1000} />
            </div>
            {error && <ErrorLine text={error} />}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !name.trim() || !nest}>
                {busy ? "Registering…" : "Register"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
