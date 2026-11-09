/**
 * Control room → Overview (po-1186 CR2): four tiles, distillation by day with
 * the no-op reasons, cold start, the channel table with the paused-channel
 * alert, and the rollups. Every figure is a count of decision-ledger rows
 * (CR1 rollups), so it matches the ledger for the same range (AC-CR-03/10).
 */
import { useMemo, useState } from "react";
import { CircleAlert, Check, Gauge, Hash, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getColdStart, getLedger, getRollups, getSurfacesBudget, listSurfacesBindings, type CrColdStart } from "../../../lib/api";
import {
  LOW_PRECISION,
  channelRows,
  distillationSeries,
  fmtDay,
  fmtWhen,
  formatDuration,
  monthName,
  overviewIsEmpty,
  overviewTiles,
  pausedAlerts,
  reasonBreakdown,
  rollupTable,
  sumRows,
  usd,
  type BindingLite,
  type BudgetLite,
} from "../../../lib/control-room-overview";
import { SETUP_STEPS } from "../../../lib/control-room-setup";
import { AgentIcon, Card, CardHead, EmptyState, ErrorLine, Loading, Segmented, ToneBadge } from "./parts";
import { CumulativeLine, StackedBars } from "./charts";
import { useRead, type ControlRoomScope } from "./scope";
import { cn } from "@/lib/utils";

export function Overview({
  scope,
  onSetup,
  onLedger,
  onAgents,
  onOpenNest,
}: {
  scope: ControlRoomScope;
  onSetup: (() => void) | null;
  onLedger: () => void;
  onAgents: () => void;
  onOpenNest: (nestId: string) => void;
}) {
  const { nestId, range, tick } = scope;
  const key = [nestId, range.from, tick];
  const base = { from: range.from, to: range.to };
  const day = useRead(() => getRollups(nestId, { ...base, source: "surfaces", by: "none", grain: "day" }), key);
  const reasons = useRead(() => getRollups(nestId, { ...base, source: "surfaces", verdict: "no_op", by: "reason", grain: "week" }), key);
  const perBinding = useRead(() => getRollups(nestId, { ...base, source: "surfaces", by: "binding", grain: "week" }), key);
  const bindings = useRead(
    () => listSurfacesBindings().then((bs) => (bs as unknown as BindingLite[]).filter((b) => !nestId || b.nest_id === nestId)),
    [nestId, tick],
  );
  const budgets = useRead(async () => {
    const bs = bindings.data ?? [];
    // Team channels' nests only: a personal (DM) nest's budget is its owner's business.
    const ids = nestId ? [nestId] : [...new Set(bs.filter((b) => b.status !== "removed" && b.conversation_kind !== "dm").map((b) => b.nest_id))];
    const out = await Promise.all(ids.map((id) => getSurfacesBudget(id).catch(() => null)));
    return out.filter((b): b is BudgetLite => !!b);
  }, [nestId, tick, bindings.data]);

  const loading = !day.data || !bindings.data;
  const err = day.error || bindings.error;
  if (err && !day.data) return <ErrorLine text={err} />;
  if (loading) return <Loading what="the overview" />;

  const bs = bindings.data!;
  const empty = overviewIsEmpty({ totals: day.data!.totals, bindings: bs });
  if (empty) {
    return (
      <div className="space-y-4" data-testid="cr-overview-empty">
        <EmptyState icon={Gauge} title="Nothing is listening yet" testId="cr-empty-overview">
          <p>
            {onSetup
              ? "Surfaces is switched on for this server, but no channel is listening yet. Once one is, this page shows what the listeners reviewed, what people saved, and what it cost."
              : "No channel in your nests is listening yet. A server administrator connects Slack and turns listening on; then this page shows what the listeners reviewed, what people saved, and what it cost."}
          </p>
          {onSetup && (
            <>
              <ol className="mx-auto mt-5 max-w-sm text-left text-foreground">
                {SETUP_STEPS.map((s, i) => (
                  <li key={s.title} className="flex items-center gap-2.5 border-b py-1.5 text-sm last:border-b-0">
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border text-sm text-muted-foreground" aria-hidden>
                      {i + 1}
                    </span>
                    {s.title}
                  </li>
                ))}
              </ol>
              <Button className="mt-5" onClick={onSetup}>
                Start setup
              </Button>
            </>
          )}
          <p className="mt-4">
            Have an agent of your own?{" "}
            <button type="button" className="font-medium text-primary underline underline-offset-2" onClick={onAgents}>
              Report its runs here
            </button>{" "}
            without Slack.
          </p>
        </EmptyState>
        <Tiles tiles={null} />
        <RollupsCard scope={scope} onLedger={onLedger} hideWhenEmpty />
      </div>
    );
  }

  const activeChannels = bs.filter((b) => b.status === "active" && b.conversation_kind !== "dm").length;
  const tiles = overviewTiles({ surfaces: day.data!.totals, activeChannels, days: range.days.length, budgets: budgets.data ?? [] });
  const series = distillationSeries(day.data!.rows, range.days);
  const why = reasonBreakdown(reasons.data?.rows ?? []);
  const channels = channelRows(bs, perBinding.data?.rows ?? [], range.days.length);
  const alerts = pausedAlerts(bs, scope.nestName);

  return (
    <div className="space-y-4" data-testid="cr-overview">
      {alerts.map((a) => (
        <PausedAlert key={a.bindingId} alert={a} nestName={scope.nestName(a.nestId)} onOpenNest={() => onOpenNest(a.nestId)} onSetup={onSetup} />
      ))}
      <Tiles tiles={tiles} />
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <Card aria-labelledby="cr-distill">
          <CardHead
            id="cr-distill"
            title="Distillation"
            sub="Conversation windows the listeners reviewed, by day"
            right={
              <div className="flex items-center gap-3 text-sm text-muted-foreground" aria-hidden>
                <span className="inline-flex items-center gap-1.5">
                  <i className="h-2.5 w-2.5 rounded-sm bg-zinc-300" />
                  No proposal
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <i className="h-2.5 w-2.5 rounded-sm bg-primary" />
                  Proposed
                </span>
              </div>
            }
          />
          <div className="px-4 pb-4 pt-3 sm:px-5">
            <StackedBars
              days={series.days}
              label="Conversation windows reviewed per day: no proposal and proposed"
              series={[
                { label: "No proposal", tone: "grey", values: series.noProposal },
                { label: "Proposed", tone: "accent", values: series.proposed },
              ]}
            />
            {why.length > 0 && (
              <div className="mt-4" data-testid="cr-reasons">
                <h3 className="mb-1 text-sm font-semibold">Why most windows end with no proposal</h3>
                {why.map((r) => (
                  <Bar key={r.code} name={r.label} value={r.count} max={why[0].count} tone="grey" />
                ))}
                <p className="mt-1.5 text-sm text-muted-foreground">Doing nothing is the normal result. These windows posted nothing and kept no text.</p>
              </div>
            )}
          </div>
        </Card>
        <ColdStartCard scope={scope} onSetup={onSetup} />
      </div>
      <ChannelsCard rows={channels} nestName={scope.nestName} />
      <RollupsCard scope={scope} onLedger={onLedger} />
    </div>
  );
}

// ─── Tiles ─────────────────────────────────────────────────────────────────

function Tiles({ tiles }: { tiles: ReturnType<typeof overviewTiles> | null }) {
  const t = tiles;
  const spendMonth = monthName(t?.month ?? new Date().toISOString().slice(0, 7));
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4" data-testid="cr-tiles">
      <Tile label="Conversations reviewed" testId="tile-reviewed" value={t ? t.reviewed.toLocaleString() : null}>
        {t && t.noProposalPct !== null ? `${t.noProposalPct}% ended with no proposal` : "No data yet"}
      </Tile>
      <Tile label="Cards per channel per day" testId="tile-cards" value={t?.cardsPerChannelDay != null ? t.cardsPerChannelDay.toFixed(1) : null}>
        {t?.cardsPerChannelDay != null ? (
          t.cardsPerChannelDay <= 1 ? (
            <span className="inline-flex items-center gap-1 text-green-700">
              <Check className="h-3.5 w-3.5" aria-hidden />
              Target is 1 or fewer
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-amber-700">
              <CircleAlert className="h-3.5 w-3.5" aria-hidden />
              Above the target of 1
            </span>
          )
        ) : (
          "No data yet"
        )}
      </Tile>
      <Tile label="Saved by a named person" testId="tile-saved" value={t ? t.saved.toLocaleString() : null}>
        {t ? `${t.edited} edited first · ${t.rejected} rejected · ${t.expired} expired` : "No data yet"}
      </Tile>
      <Tile
        label={`Model spend, ${spendMonth}`}
        testId="tile-spend"
        value={
          t ? (
            <>
              {usd(t.spendUsd)}
              {t.capUsd > 0 && <small className="ml-1.5 text-sm font-normal text-muted-foreground">of {usd(t.capUsd).replace(/\.00$/, "")}</small>}
            </>
          ) : null
        }
      >
        {t && t.capUsd > 0 ? (
          <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <i className="block h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (t.spendUsd / t.capUsd) * 100)}%` }} />
          </span>
        ) : t ? (
          "No cap set"
        ) : (
          "No data yet"
        )}
      </Tile>
    </div>
  );
}

function Tile({ label, value, children, testId }: { label: string; value: React.ReactNode | null; children: React.ReactNode; testId: string }) {
  return (
    <Card className="px-4 py-3.5" data-testid={testId}>
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums" data-testid={`${testId}-value`}>
        {value ?? <span className="text-muted-foreground">–</span>}
      </div>
      <div className="mt-1 text-sm text-muted-foreground">{children}</div>
    </Card>
  );
}

// ─── Bars (reasons, folders) ───────────────────────────────────────────────

function Bar({ name, value, max, tone, mono, dim }: { name: string; value: number; max: number; tone: "grey" | "accent"; mono?: boolean; dim?: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(6.5rem,9rem)_minmax(0,1fr)_2.5rem] items-center gap-3 py-1 text-sm">
      <span className={cn("min-w-0 [overflow-wrap:anywhere]", mono && "font-mono text-[13px]", dim && "text-muted-foreground")}>{name}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <i className={cn("block h-full rounded-full", tone === "accent" ? "bg-primary" : "bg-zinc-400")} style={{ width: `${max ? (value / max) * 100 : 0}%` }} />
      </span>
      <span className="text-right tabular-nums">{value}</span>
    </div>
  );
}

// ─── Paused channel alert (AC-CR-03b) ──────────────────────────────────────

function PausedAlert({
  alert,
  nestName,
  onOpenNest,
  onSetup,
}: {
  alert: ReturnType<typeof pausedAlerts>[number];
  nestName: string;
  onOpenNest: () => void;
  onSetup: (() => void) | null;
}) {
  const [kept, setKept] = useState(false);
  if (kept) return null;
  return (
    <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="alert" data-testid="cr-paused-alert">
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden />
      <div className="min-w-0">
        <p>
          <b>#{alert.channel} is paused.</b> {alert.reason} Its buffer was cleared; nothing is captured while it is paused.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="bg-background" onClick={onOpenNest}>
            Adjust who can read {nestName}
          </Button>
          {onSetup && (
            <Button size="sm" variant="outline" className="bg-background" onClick={onSetup}>
              Bind to another nest
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setKept(true)}>
            Keep paused
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Cold start (AC-CR-04) ─────────────────────────────────────────────────

function ColdStartCard({ scope, onSetup }: { scope: ControlRoomScope; onSetup: (() => void) | null }) {
  const cs = useRead(() => getColdStart(scope.nestId), [scope.nestId, scope.tick]);
  const seeded = (cs.data ?? []).filter((c) => !c.no_seed);
  const [pick, setPick] = useState<string | null>(null);
  const cur: CrColdStart | undefined = seeded.find((c) => c.nest_id === pick) ?? seeded[0];
  if (cs.error && !cs.data)
    return (
      <Card>
        <CardHead title="Cold start" />
        <div className="p-4 sm:px-5">
          <ErrorLine text={cs.error} />
        </div>
      </Card>
    );
  if (!cs.data) return <Card className="p-4"><Loading what="the cold start" /></Card>;
  if (!cur) {
    return (
      <Card data-testid="cr-coldstart-none">
        <CardHead title="Cold start" />
        <div className="px-4 pb-5 pt-2 text-sm text-muted-foreground sm:px-5">
          <p>
            {scope.nestId ? `${scope.nestName(scope.nestId)} has no starter folders yet` : "No nest has starter folders yet"}, so there is nothing to fill up. A starter gives the listeners somewhere to save what people agree on.
          </p>
          {onSetup ? (
            <Button variant="outline" size="sm" className="mt-3" onClick={onSetup}>
              Add starter folders in Setup
            </Button>
          ) : (
            <p className="mt-2">A server administrator adds them in Control room → Setup.</p>
          )}
        </div>
      </Card>
    );
  }
  const max = Math.max(1, ...cur.folders.map((f) => f.approved));
  const zero = cur.folders.filter((f) => f.approved === 0);
  const mirrorProposed = cur.mirror.people.proposed + cur.mirror.areas.proposed;
  const mirrorAccepted = cur.mirror.people.accepted + cur.mirror.areas.accepted;
  return (
    <Card data-testid="cr-coldstart">
      <CardHead
        title="Cold start"
        sub={`${cur.nest_label} · seed ${cur.seed!.id} v${cur.seed!.version}, applied ${fmtDay(cur.seed!.applied_at)}`}
        right={
          seeded.length > 1 ? (
            <select
              aria-label="Nest for cold start"
              className="h-8 rounded-md border bg-background px-2 text-sm"
              value={cur.nest_id}
              onChange={(e) => setPick(e.target.value)}
            >
              {seeded.map((c) => (
                <option key={c.nest_id} value={c.nest_id}>
                  {c.nest_label}
                </option>
              ))}
            </select>
          ) : undefined
        }
      />
      <div className="px-4 pb-4 pt-3 sm:px-5">
        <div className="mb-3 flex flex-wrap gap-x-6 gap-y-3">
          <Figure label="Folder coverage" value={`${cur.coverage.covered} of ${cur.coverage.total}`} testId="cs-coverage" />
          <Figure
            label="First approved node"
            value={cur.first_approved ? formatDuration(cur.first_approved.after_seed_ms) : "None yet"}
            foot={cur.first_approved ? "after the seed" : undefined}
            testId="cs-first"
          />
          {mirrorProposed > 0 && <Figure label="People and areas" value={`${mirrorAccepted} of ${mirrorProposed}`} foot="accepted" testId="cs-mirror" />}
        </div>
        {[...cur.folders].sort((a, b) => b.approved - a.approved || a.path.localeCompare(b.path)).map((f) => (
          <Bar key={f.path} name={f.path} value={f.approved} max={max} tone="accent" mono dim={f.approved === 0} />
        ))}
        {zero.length > 0 && (
          <p className="mt-2 text-sm text-muted-foreground">
            {zero.map((f) => f.path).join(", ")} {zero.length === 1 ? "has" : "have"} nothing approved yet.
          </p>
        )}
        {cur.cumulative.length > 1 && (
          <>
            <div className="mt-3 text-sm text-muted-foreground">Approved documents in these folders, cumulative</div>
            <CumulativeLine points={cur.cumulative.map((p) => ({ day: p.day, value: p.approved }))} label="Approved documents in the starter folders over time" />
          </>
        )}
      </div>
    </Card>
  );
}

function Figure({ label, value, foot, testId }: { label: string; value: string; foot?: string; testId: string }) {
  return (
    <div data-testid={testId}>
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {foot && <div className="text-sm text-muted-foreground">{foot}</div>}
    </div>
  );
}

// ─── Channels ──────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, ["success" | "warning" | "neutral", string]> = {
  active: ["success", "Listening"],
  paused_guard: ["warning", "Paused"],
  paused_by_member: ["neutral", "Removed by a member"],
};

function ChannelsCard({ rows, nestName }: { rows: ReturnType<typeof channelRows>; nestName: (id: string) => string }) {
  return (
    <Card data-testid="cr-channels">
      <CardHead title="Channels" sub="Listening is per channel. Each one saves into a single nest." />
      <div className="px-2 pb-3 pt-2 sm:px-3">
        {rows.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">No channel is bound in this scope.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-2 py-2 font-normal">Channel</th>
                <th className="px-2 py-2 font-normal">Status</th>
                <th className="hidden px-2 py-2 text-right font-normal md:table-cell">Reviewed</th>
                <th className="hidden px-2 py-2 text-right font-normal md:table-cell">No proposal</th>
                <th className="hidden px-2 py-2 text-right font-normal sm:table-cell">Cards/day</th>
                <th className="px-2 py-2 text-right font-normal">Approved</th>
                <th className="hidden px-2 py-2 font-normal lg:table-cell">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = STATUS_BADGE[r.status] ?? (["neutral", r.status] as const);
                return (
                  <tr key={r.bindingId} className="border-b last:border-b-0" data-testid="cr-channel-row">
                    <td className="min-w-[8rem] px-2 py-2.5">
                      <div className="flex items-center gap-1.5 font-medium">
                        {r.isPrivate ? <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Private channel" /> : <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Public channel" />}
                        <span className="[overflow-wrap:anywhere]">{r.name}</span>
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {nestName(r.nestId)}
                        {r.members != null && <span className="hidden sm:inline"> · {r.members} members</span>}
                      </div>
                    </td>
                    <td className="px-2 py-2.5">
                      <ToneBadge tone={st[0]}>{st[1]}</ToneBadge>
                    </td>
                    <td className="hidden px-2 py-2.5 text-right tabular-nums md:table-cell">{r.reviewed}</td>
                    <td className="hidden px-2 py-2.5 text-right tabular-nums md:table-cell">{r.noProposalPct === null ? "–" : `${r.noProposalPct}%`}</td>
                    <td className="hidden px-2 py-2.5 text-right tabular-nums sm:table-cell">{r.cardsPerDay.toFixed(1)}</td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {r.precision === null ? "–" : `${r.precision}%`}
                      {r.precision !== null && r.precision < LOW_PRECISION && (
                        <ToneBadge tone="warning" className="ml-1.5">
                          low
                        </ToneBadge>
                      )}
                    </td>
                    <td className="hidden px-2 py-2.5 text-sm text-muted-foreground lg:table-cell">{r.lastAt ? fmtWhen(r.lastAt) : "–"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}

// ─── Rollups ───────────────────────────────────────────────────────────────

function RollupsCard({ scope, onLedger, hideWhenEmpty }: { scope: ControlRoomScope; onLedger: () => void; hideWhenEmpty?: boolean }) {
  const [by, setBy] = useState<"agent" | "nest">("agent");
  const [grain, setGrain] = useState<"day" | "week">("week");
  const [all, setAll] = useState(false);
  const { nestId, range, tick } = scope;
  const roll = useRead(() => getRollups(nestId, { from: range.from, to: range.to, by, grain }), [nestId, range.from, tick, by, grain]);
  // The ledger's own total for the same range: the line under the table checks against it.
  const ledger = useRead(() => getLedger(nestId, { from: range.from, to: range.to, limit: 1 }), [nestId, range.from, tick]);
  const rows = useMemo(() => rollupTable(roll.data?.rows ?? []), [roll.data]);
  if (!roll.data) return roll.error ? <ErrorLine text={roll.error} /> : null;
  if (hideWhenEmpty && roll.data.totals.entries === 0) return null;
  const T = sumRows(rows);
  const shown = all ? rows : rows.slice(0, 25);
  const bucketLabel = (b: string) => fmtDay(b);
  return (
    <Card data-testid="cr-rollups">
      <CardHead
        title="Rollups"
        sub="Every figure is a count of decision-ledger rows"
        right={
          <>
            <Segmented label="Group by" value={by} onChange={setBy} options={[{ value: "agent", label: "By agent" }, { value: "nest", label: "By nest" }]} />
            <Segmented label="Grain" value={grain} onChange={setGrain} options={[{ value: "day", label: "Daily" }, { value: "week", label: "Weekly" }]} />
          </>
        }
      />
      <div className="px-2 pb-3 pt-2 sm:px-3">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="px-2 py-2 font-normal">{grain === "day" ? "Day" : "Week of"}</th>
              <th className="px-2 py-2 font-normal">{by === "agent" ? "Agent" : "Nest"}</th>
              <th className="px-2 py-2 text-right font-normal">Runs</th>
              <th className="hidden px-2 py-2 text-right font-normal md:table-cell">No proposal</th>
              <th className="hidden px-2 py-2 text-right font-normal md:table-cell">Proposed</th>
              <th className="hidden px-2 py-2 text-right font-normal sm:table-cell">Approved</th>
              <th className="hidden px-2 py-2 text-right font-normal md:table-cell">Rejected</th>
              <th className="hidden px-2 py-2 text-right font-normal md:table-cell">Failed</th>
              <th className="px-2 py-2 text-right font-normal">Cost</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={`${r.bucket}|${r.nest_id}|${r.key}`} className="border-b">
                <td className="whitespace-nowrap px-2 py-2.5 tabular-nums">{bucketLabel(r.bucket)}</td>
                <td className="min-w-[9rem] px-2 py-2.5">
                  <span className="inline-flex items-center gap-1.5">
                    {by === "agent" && <AgentIcon source={r.source} className="h-3.5 w-3.5" />}
                    <span className="[overflow-wrap:anywhere]">{r.label ?? r.key}</span>
                  </span>
                </td>
                <td className="px-2 py-2.5 text-right tabular-nums">{r.entries}</td>
                <td className="hidden px-2 py-2.5 text-right tabular-nums md:table-cell">{r.no_op}</td>
                <td className="hidden px-2 py-2.5 text-right tabular-nums md:table-cell">{r.propose + r.act}</td>
                <td className="hidden px-2 py-2.5 text-right tabular-nums sm:table-cell">{r.approved}</td>
                <td className="hidden px-2 py-2.5 text-right tabular-nums md:table-cell">{r.rejected}</td>
                <td className="hidden px-2 py-2.5 text-right tabular-nums md:table-cell">{r.error}</td>
                <td className="px-2 py-2.5 text-right tabular-nums">{usd(r.cost_usd)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold" data-testid="cr-rollups-total">
              <td colSpan={2} className="px-2 py-2.5">
                Total, last {range.days.length} days
              </td>
              <td className="px-2 py-2.5 text-right tabular-nums">{T.entries}</td>
              <td className="hidden px-2 py-2.5 text-right font-normal tabular-nums md:table-cell">{T.no_op}</td>
              <td className="hidden px-2 py-2.5 text-right font-normal tabular-nums md:table-cell">{T.propose + T.act}</td>
              <td className="hidden px-2 py-2.5 text-right tabular-nums sm:table-cell">{T.approved}</td>
              <td className="hidden px-2 py-2.5 text-right font-normal tabular-nums md:table-cell">{T.rejected}</td>
              <td className="hidden px-2 py-2.5 text-right font-normal tabular-nums md:table-cell">{T.error}</td>
              <td className="px-2 py-2.5 text-right tabular-nums">{usd(T.cost_usd)}</td>
            </tr>
          </tfoot>
        </table>
        {rows.length > 25 && !all && (
          <div className="mt-2 text-center">
            <Button variant="outline" size="sm" onClick={() => setAll(true)}>
              Show all {rows.length} rows
            </Button>
          </div>
        )}
        <p className="mt-2.5 flex flex-wrap items-center gap-1 px-2 text-sm text-muted-foreground" data-testid="cr-rollups-reconcile">
          <Check className="h-3.5 w-3.5" aria-hidden />
          {!ledger.data
            ? "Checking against the decision ledger…"
            : T.entries === ledger.data.totals.entries
              ? `Matches the decision ledger for the same range: ${ledger.data.totals.entries.toLocaleString()} rows.`
              : `The decision ledger has ${ledger.data.totals.entries.toLocaleString()} rows for this range; these rollups count ${T.entries.toLocaleString()}.`}
          <button type="button" className="font-medium text-primary underline underline-offset-2" onClick={onLedger}>
            Open them
          </button>
        </p>
      </div>
    </Card>
  );
}
