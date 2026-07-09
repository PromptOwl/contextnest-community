import type React from "react";
import { ArrowLeft, BookOpen } from "lucide-react";
import { Button } from "./ui/button";

interface Props {
  onBack: () => void;
}

/**
 * How it works — the in-app manual: concepts, the governed loop, every API
 * surface (REST / MCP / hooks / connectors), step-by-step builds for the
 * common agent shapes, and the governance patterns. Reached from the user
 * menu. Kept text-only on purpose: it must load instantly and read offline.
 */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-semibold mb-2">{title}</h2>
      {children}
    </section>
  );
}

function Steps({ steps }: { steps: React.ReactNode[] }) {
  return (
    <ol className="list-decimal pl-5 space-y-1.5 text-muted-foreground">
      {steps.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ol>
  );
}

export function GuidePage({ onBack }: Props) {
  return (
    <div className="max-w-3xl">
      <div className="flex items-center gap-3 mb-6">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" /> Back
        </Button>
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">How it works</h1>
        </div>
      </div>

      <div className="space-y-8 text-sm leading-relaxed">
        <Section title="What this is">
          <p className="text-muted-foreground">
            A <b>governed brain</b> your team and your AI agents share.
            Everything is a versioned Markdown node in a <b>nest</b> (a vault).
            Every change is hash-chained and reversible, and reads are
            deterministic — the same query returns the same answer every time.
            Humans edit here; agents read and write over the same API. One
            invariant holds everywhere: <b>the server is a ledger, never an
            executor</b> — it records intentions and facts; external runners do
            the work; every write passes through governance.
          </p>
        </Section>

        <Section title="The lego set">
          <dl className="space-y-2">
            {[
              ["Nest", "A vault of nodes — the unit of sharing, permissions, and governance."],
              ["Node", "A versioned Markdown document. Types: document, artifact (hosted HTML), table (CSV fact store, deterministically queryable), and with the workflow plane on: agent, skill (runnable) and tool (the body is code an agent can call)."],
              ["Edge", "A typed link. Flow edges (▶) are control: they decide what happens next, gated by conditions (always / if… judged / metric). The LLM never chooses control flow — it only fills content inside a step."],
              ["Run", "The one artifact every way of starting work converges on: a row saying “walk this agent's subgraph”. It is the queue (unclaimed = waiting), the audit log (steps append), and the receipt (closed with a verdict)."],
              ["Trigger", "Anything that writes a run row: the Run button (a person), a schedule (the clock), an inbound hook (the outside world — Slack, CI, anything that can POST)."],
              ["Runner", "The only executor. External, stateless, disposable: polls unclaimed runs, fetches the bundle, walks the edges, calls the LLM inside steps, writes back through the API, traces everything."],
              ["Tool env", "Per-nest key/value secrets (write-only, masked). Tools and the runner's own LLM key ride to the runner inside the run bundle. A server-wide Anthropic key in Settings is the default floor."],
              ["Connector", "Outbound brick: governance/run events → Slack, Teams, or a raw webhook. Rows of data, not code."],
              ["Watcher", "A person tagged to an agent or document — they get inbox notifications when its output lands for review and when verdicts come back."],
              ["Review", "The membrane. Agent output becomes canonical only when a human approves it (in a stewarded nest)."],
            ].map(([term, def]) => (
              <div key={term} className="grid grid-cols-[110px_1fr] gap-3">
                <dt className="font-medium">{term}</dt>
                <dd className="text-muted-foreground">{def}</dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section title="The governed loop">
          <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
            <li>Write an <b>agent</b> node (its body is the instructions) and wire a flow <b>edge</b> to a target document on the <b>Canvas</b>.</li>
            <li>A <b>trigger</b> creates a run — button, schedule, or hook.</li>
            <li>A <b>runner</b> claims it: deterministic reads, LLM inside the step, output written into the target <i>through the API</i>.</li>
            <li>In a stewarded nest the write lands as a <b>pending review</b> — watchers get notified, connectors post to your channel.</li>
            <li>A human <b>approves or rejects</b>. Approval publishes a version; the entire run stays as a replayable trace.</li>
          </ol>
        </Section>

        <Section title="Every way in and out">
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/50 text-left text-muted-foreground">
                  <th className="px-3 py-2 font-semibold">Surface</th>
                  <th className="px-3 py-2 font-semibold">What it's for</th>
                  <th className="px-3 py-2 font-semibold">Where</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["This UI", "Humans: edit, review, wire flows, watch runs.", "you're in it"],
                  ["REST API", "Everything the UI does — same endpoints, Bearer cnst_… key.", "Connect → API"],
                  ["MCP", "Claude Desktop / any MCP client: 21 context_* tools per nest (read, search, create, comment, share…).", "Connect → MCP"],
                  ["CLI (ctx)", "Terminal reads/writes against a nest.", "Connect → CLI"],
                  ["Add with AI", "Point an agent at a repo or topic; it pushes generated context in.", "Connect (top)"],
                  ["Inbound hooks", "Secret URLs that trigger agents from Slack (@mention / slash), Teams, or any POST.", "Canvas → agent → Triggers"],
                  ["Connectors", "Events out to Slack / Teams / webhooks.", "Workflows → Activity"],
                ].map(([a, b, c]) => (
                  <tr key={a as string} className="border-t align-top">
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{a}</td>
                    <td className="px-3 py-2 text-muted-foreground">{b}</td>
                    <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{c}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="The API in one table">
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/50 text-left text-muted-foreground">
                  <th className="px-3 py-2 font-semibold">Call</th>
                  <th className="px-3 py-2 font-semibold">What it does</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {[
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
                ].map(([call, desc]) => (
                  <tr key={call} className="border-t align-top">
                    <td className="px-3 py-2 whitespace-nowrap">{call}</td>
                    <td className="px-3 py-2 font-sans text-muted-foreground">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground mt-2">
            Full reference with request/response bodies: <code>API.md</code> in
            the repo. Agents authenticate with a nest key (Bearer{" "}
            <code>cnst_…</code>); browsers use the session cookie. Same governed
            surface either way.
          </p>
        </Section>

        <Section title="Build one: a scheduled digest agent (5 minutes)">
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

        <Section title="Build one: a tool-using agent">
          <Steps
            steps={[
              <><b>New Document</b> → type <b>Tool</b> → the body is code (the runner executes it; conventions are yours + the runner's).</>,
              <>Add the credentials it needs in <b>Activity → Tool environment</b> (e.g. <code>SLACK_TOKEN</code>). Write-only, masked, delivered only inside run bundles.</>,
              <>On the Canvas, wire <i>agent → tool</i> and <i>agent → output doc</i>. The run bundle now carries the tool's code and the env values.</>,
              <>Click the agent → <b>Test: preview what it reads</b> to see the exact context a run will get, then Run now.</>,
            ]}
          />
        </Section>

        <Section title="Build one: chat in, governed out (Slack)">
          <Steps
            steps={[
              <>Canvas → click the agent → <b>Triggers</b> → add a <b>Slack</b> trigger → copy the secret URL.</>,
              <>In Slack: create a slash command (or an app with Events API for <b>@mentions</b>) pointing at that URL. Add your app's signing secret to Tool environment as <code>SLACK_SIGNING_SECRET</code> and requests are verified.</>,
              <>Now <code>/digest foley Q3</code> (or "@agent summarize the week") queues a run — the message text becomes the run's inputs.</>,
              <>Close the loop outward: <b>Activity → Connectors</b> → Slack + your webhook (or <code>env:SLACK_WEBHOOK</code>) → the channel hears when output lands for review and when it's approved.</>,
            ]}
          />
          <p className="text-muted-foreground mt-2">
            Teams works the same way (outgoing webhook preset +{" "}
            <code>TEAMS_WEBHOOK_SECRET</code>); the raw <b>webhook</b> preset
            lets Zapier, CI, or cron trigger agents with zero product code.
          </p>
        </Section>

        <Section title="Governance patterns — pick your membrane">
          <dl className="space-y-2">
            {[
              ["Solo / ungoverned", "Stewardship off. Writes publish immediately. Right for a personal vault; agent output still traces, it just doesn't wait."],
              ["Owner, self-approve", "Stewardship on + allow self-approve. Everything pauses for review, and you are your own reviewer — the audit trail without ceremony."],
              ["Stewarded team", "Assign stewards (viewer / editor / reviewer) by document, tag, or nest. Separation of duties: submitters can't approve their own change. Agent write-backs queue like everyone else's."],
              ["Delegated admins", "Nest owners/admins manage stewards and settings without being the server admin — governance scales past one person."],
              ["Shared slices", "Share a single document or folder (grants) instead of the whole nest — humans and agents get exactly the slice they need."],
              ["Observability layer", "Watchers (people tagged to agents/docs) + connectors (channels) — how the humans find out the membrane needs them."],
            ].map(([term, def]) => (
              <div key={term} className="grid grid-cols-[130px_1fr] gap-3">
                <dt className="font-medium">{term}</dt>
                <dd className="text-muted-foreground">{def}</dd>
              </div>
            ))}
          </dl>
        </Section>
      </div>
    </div>
  );
}
