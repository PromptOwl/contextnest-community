import type React from "react";
import {
  ArrowLeft,
  BookOpen,
  Boxes,
  Repeat,
  DoorOpen,
  Code2,
  CalendarClock,
  Wrench,
  MessageSquare,
  ShieldCheck,
} from "lucide-react";
import { Button } from "./ui/button";
import { BetaBadge } from "./ui/beta-badge";

interface Props {
  onBack: () => void;
}

/**
 * How it works — the in-app manual: concepts, the governed loop, every API
 * surface (REST / MCP / hooks / connectors), step-by-step builds for the
 * common agent shapes, and the governance patterns. Reached from the user
 * menu. Kept text-only on purpose: it must load instantly and read offline.
 */

function Section({
  title,
  icon: Icon,
  beta,
  children,
}: {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Marks a Workflows-facing (workflow plane) section with the Beta chip. */
  beta?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        {Icon && (
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Icon className="h-4 w-4" />
          </span>
        )}
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {beta && <BetaBadge />}
      </div>
      {children}
    </section>
  );
}

/** Numbered steps with a connecting rail — reads as a sequence, not a list. */
function Steps({ steps }: { steps: React.ReactNode[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3">
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            {i + 1}
          </span>
          <span className="text-muted-foreground pt-0.5">{s}</span>
        </li>
      ))}
    </ol>
  );
}

/** A term/definition rendered as a card — the "lego set" and patterns grids. */
function DefCard({ term, def }: { term: string; def: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-3 transition-colors hover:border-primary/40">
      <div className="mb-1 text-sm font-semibold">{term}</div>
      <div className="text-xs leading-relaxed text-muted-foreground">{def}</div>
    </div>
  );
}

const LEGO: [string, string][] = [
  ["Nest", "A vault of nodes — the unit of sharing, permissions, and governance."],
  ["Node", "A versioned Markdown document. Types: document, artifact (hosted HTML), table (CSV fact store, deterministically queryable), and with the workflow plane (Beta) on: agent, skill (runnable) and tool (the body is code an agent can call)."],
  ["Edge", "A typed link. Flow edges (▶) are control: they decide what happens next, gated by conditions (always / if… judged / metric). The LLM never chooses control flow — it only fills content inside a step."],
  ["Run", "The one artifact every way of starting work converges on: a row saying “walk this agent's subgraph”. It is the queue (unclaimed = waiting), the audit log (steps append), and the receipt (closed with a verdict)."],
  ["Trigger", "Anything that writes a run row: the Run button (a person), a schedule (the clock), an inbound hook (the outside world — Slack, CI, anything that can POST)."],
  ["Runner", "The only executor. External, stateless, disposable: polls unclaimed runs, fetches the bundle, walks the edges, calls the LLM inside steps, writes back through the API, traces everything."],
  ["Tool env", "Per-nest key/value secrets (write-only, masked). Tools and the runner's own LLM key ride to the runner inside the run bundle. A server-wide Anthropic key in Settings is the default floor."],
  ["Connector", "Outbound brick: governance/run events → Slack, Teams, or a raw webhook. Rows of data, not code."],
  ["Watcher", "A person tagged to an agent or document — they get inbox notifications when its output lands for review and when verdicts come back."],
  ["Review", "The membrane. Agent output becomes canonical only when a human approves it (in a stewarded nest)."],
];

const PATTERNS: [string, string][] = [
  ["Solo / ungoverned", "Stewardship off. Writes publish immediately. Right for a personal vault; agent output still traces, it just doesn't wait."],
  ["Owner, self-approve", "Stewardship on + allow self-approve. Everything pauses for review, and you are your own reviewer — the audit trail without ceremony."],
  ["Stewarded team", "Assign stewards (viewer / editor / reviewer) by document, tag, or nest. Separation of duties: submitters can't approve their own change. Agent write-backs queue like everyone else's."],
  ["Delegated admins", "Nest owners/admins manage stewards and settings without being the server admin — governance scales past one person."],
  ["Shared slices", "Share a single document or folder (grants) instead of the whole nest — humans and agents get exactly the slice they need."],
  ["Observability layer", "Watchers (people tagged to agents/docs) + connectors (channels) — how the humans find out the membrane needs them."],
];

const SURFACES: [string, string, string][] = [
  ["This UI", "Humans: edit, review, wire flows, watch runs.", "you're in it"],
  ["REST API", "Everything the UI does — same endpoints, Bearer cnst_… key.", "Connect → API"],
  ["MCP", "Claude Desktop / any MCP client: 23 context_* tools per nest (read, search, create, comment, share…).", "Connect → MCP"],
  ["Add with AI", "Point an agent at a repo or topic; it pushes generated context in.", "Connect (top)"],
  ["Inbound hooks", "Secret URLs that trigger agents from Slack (@mention / slash), Teams, or any POST.", "Canvas → agent → Triggers"],
  ["Connectors", "Events out to Slack / Teams / webhooks.", "Workflows → Activity"],
];

const API_ROWS: [string, string][] = [
  ["POST /nests/:id/context", "Deterministic retrieval — selector ([[Title]], #tag) + hops. The governed read."],
  ["POST /nests/:id/table-query", "Deterministic fact lookup on a table node: where col op value [and …] [select cols] [limit N]. Also an MCP tool (context_table_query)."],
  ["POST /nests/:id/nodes · PATCH …/nodes/:n", "Create / write a node (new version; draft + review when stewarded). folder files it into a tree."],
  ["POST …/nodes/:n/move · /revert · /watchers", "Relocate (history follows) · restore a version · tag people for notifications."],
  ["GET/POST /nests/:id/edges · /edge-types", "The typed-edge graph (Canvas / Table)."],
  ["POST /nests/:id/run/:agent", "Trigger now; returns the run bundle (instructions, subgraph, tools, env, definitions)."],
  ["GET /nests/:id/runs?unclaimed=true · GET /runs/:id/bundle", "The runner's work queue + bundle re-hand for claiming."],
  ["POST /runs/:id/steps · PATCH /runs/:id", "Trace each step; close with a verdict."],
  ["/nests/:id/schedules", "Interval triggers: every N minutes, optional stop-after-K bound."],
  ["/nests/:id/hooks → POST /hooks/:token", "Create inbound trigger URLs; firing them queues runs (Slack/Teams presets verify signatures)."],
  ["/nests/:id/connectors · /env", "Outbound channels · the write-only secret store."],
  ["POST …/nodes/:n/approve · /reject", "The human-in-the-loop hop."],
  ["GET /me/work · /me/notifications", "Your cross-nest inbox: reviews waiting on you, handoffs, watcher notifications."],
];

export function GuidePage({ onBack }: Props) {
  return (
    <div className="w-full">
      <Button variant="ghost" size="sm" onClick={onBack} className="mb-4 -ml-2">
        <ArrowLeft className="h-4 w-4 mr-1" /> Back
      </Button>

      {/* Hero */}
      <div className="mb-10 overflow-hidden rounded-xl border bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-6">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <BookOpen className="h-6 w-6" />
          </span>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">How it works</h1>
            <p className="text-sm text-muted-foreground">
              Concepts, the governed loop, every surface, and step-by-step builds.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-10 text-sm leading-relaxed">
        <Section title="What this is">
          <div className="rounded-lg border-l-2 border-primary bg-muted/40 p-4">
            <p className="text-muted-foreground">
              A <b className="text-foreground">governed brain</b> your team and
              your AI agents share. Everything is a versioned Markdown node in a{" "}
              <b className="text-foreground">nest</b> (a vault). Every change is
              hash-chained and reversible, and reads are deterministic — the same
              query returns the same answer every time. Humans edit here; agents
              read and write over the same API. One invariant holds everywhere:{" "}
              <b className="text-foreground">the server is a ledger, never an
              executor</b> — it records intentions and facts; external runners do
              the work; every write passes through governance.
            </p>
          </div>
        </Section>

        <Section title="The lego set" icon={Boxes}>
          <div className="grid gap-3 sm:grid-cols-2">
            {LEGO.map(([term, def]) => (
              <DefCard key={term} term={term} def={def} />
            ))}
          </div>
        </Section>

        <Section title="The governed loop" icon={Repeat} beta>
          <Steps
            steps={[
              <>Write an <b>agent</b> node (its body is the instructions) and wire a flow <b>edge</b> to a target document on the <b>Canvas</b>.</>,
              <>A <b>trigger</b> creates a run — button, schedule, or hook.</>,
              <>A <b>runner</b> claims it: deterministic reads, LLM inside the step, output written into the target <i>through the API</i>.</>,
              <>In a stewarded nest the write lands as a <b>pending review</b> — watchers get notified, connectors post to your channel.</>,
              <>A human <b>approves or rejects</b>. Approval publishes a version; the entire run stays as a replayable trace.</>,
            ]}
          />
        </Section>

        <Section title="Every way in and out" icon={DoorOpen}>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/60 text-left text-muted-foreground">
                  <th className="px-3 py-2 font-semibold">Surface</th>
                  <th className="px-3 py-2 font-semibold">What it's for</th>
                  <th className="px-3 py-2 font-semibold">Where</th>
                </tr>
              </thead>
              <tbody>
                {SURFACES.map(([a, b, c]) => (
                  <tr key={a} className="border-t align-top transition-colors hover:bg-muted/30">
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{a}</td>
                    <td className="px-3 py-2 text-muted-foreground">{b}</td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{c}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="The API in one table" icon={Code2}>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/60 text-left text-muted-foreground">
                  <th className="px-3 py-2 font-semibold">Call</th>
                  <th className="px-3 py-2 font-semibold">What it does</th>
                </tr>
              </thead>
              <tbody>
                {API_ROWS.map(([call, desc]) => (
                  <tr key={call} className="border-t align-top transition-colors hover:bg-muted/30">
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-[11px] text-primary">{call}</td>
                    <td className="px-3 py-2 text-muted-foreground">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground mt-3">
            Full reference with request/response bodies: <code className="rounded bg-muted px-1 py-0.5 text-xs">API.md</code> in
            the repo. Agents authenticate with a nest key (Bearer{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">cnst_…</code>); browsers use the session cookie. Same governed
            surface either way.
          </p>
        </Section>

        <Section title="Build one: a scheduled digest agent (5 minutes)" icon={CalendarClock} beta>
          <Steps
            steps={[
              <>Once per server: <b>Server settings → Anthropic API key</b> (or per nest in Activity → Tool environment).</>,
              <><b>New Document</b> → type <b>Agent</b> → body = the instructions (e.g. "Summarize what changed this week across #gtm docs into a crisp digest").</>,
              <>Open <b>Workflows → Canvas</b>. Your agent is on the shelf — drag its right port onto a target document (create one first if needed: "Weekly Digest"). That flow edge is where the output will land.</>,
              <>Click the agent → <b>Schedule</b> → every day, stop-after as you like. (Or just press <b>Run now</b>.)</>,
              <>Start a runner once per server: the command is in <b>Activity → Runs → How do I run one</b> — poll mode claims every queued run, key comes from the store automatically.</>,
              <>Output arrives as a <b>pending review</b> in My Work. Approve → it's published, versioned, and traceable.</>,
            ]}
          />
        </Section>

        <Section title="Build one: a tool-using agent" icon={Wrench} beta>
          <Steps
            steps={[
              <><b>New Document</b> → type <b>Tool</b> → the body is code (the runner executes it; conventions are yours + the runner's).</>,
              <>Add the credentials it needs in <b>Activity → Tool environment</b> (e.g. <code className="rounded bg-muted px-1 py-0.5 text-xs">SLACK_TOKEN</code>). Write-only, masked, delivered only inside run bundles.</>,
              <>On the Canvas, wire <i>agent → tool</i> and <i>agent → output doc</i>. The run bundle now carries the tool's code and the env values.</>,
              <>Click the agent → <b>Test: preview what it reads</b> to see the exact context a run will get, then Run now.</>,
            ]}
          />
        </Section>

        <Section title="Build one: chat in, governed out (Slack)" icon={MessageSquare} beta>
          <Steps
            steps={[
              <>Canvas → click the agent → <b>Triggers</b> → add a <b>Slack</b> trigger → copy the secret URL.</>,
              <>In Slack: create a slash command (or an app with Events API for <b>@mentions</b>) pointing at that URL. Add your app's signing secret to Tool environment as <code className="rounded bg-muted px-1 py-0.5 text-xs">SLACK_SIGNING_SECRET</code> and requests are verified.</>,
              <>Now <code className="rounded bg-muted px-1 py-0.5 text-xs">/digest foley Q3</code> (or "@agent summarize the week") queues a run — the message text becomes the run's inputs.</>,
              <>Close the loop outward: <b>Activity → Connectors</b> → Slack + your webhook (or <code className="rounded bg-muted px-1 py-0.5 text-xs">env:SLACK_WEBHOOK</code>) → the channel hears when output lands for review and when it's approved.</>,
            ]}
          />
          <p className="text-muted-foreground mt-3">
            Teams works the same way (outgoing webhook preset +{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">TEAMS_WEBHOOK_SECRET</code>); the raw <b>webhook</b> preset
            lets Zapier, CI, or cron trigger agents with zero product code.
          </p>
        </Section>

        <Section title="Governance patterns — pick your membrane" icon={ShieldCheck}>
          <div className="grid gap-3 sm:grid-cols-2">
            {PATTERNS.map(([term, def]) => (
              <DefCard key={term} term={term} def={def} />
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
