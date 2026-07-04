import { ArrowLeft, BookOpen } from "lucide-react";
import { Button } from "./ui/button";

interface Props {
  onBack: () => void;
}

/**
 * How it works — a concise, in-app orientation for operators. Plain language,
 * the core concepts, the APIs, and the governed loop. Reached from the admin
 * (user) menu.
 */
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
        <section>
          <h2 className="text-base font-semibold mb-1">What this is</h2>
          <p className="text-muted-foreground">
            A <b>governed brain</b> your team and your AI agents share. Everything
            is a versioned Markdown node in a <b>nest</b> (a vault). Every change
            is hash-chained and reversible, and reads are deterministic — the same
            query returns the same answer every time. Humans edit it in this UI;
            agents read and write it over an API. Nothing is a black box.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold mb-2">The pieces</h2>
          <dl className="space-y-2">
            {[
              ["Nest", "A vault of nodes. Your unit of sharing, permissions, and governance."],
              ["Node", "A versioned Markdown document. Types: document, artifact (hosted HTML), and — with the workflow plane on — agent and skill (runnable)."],
              ["Agent / Skill", "A node whose body is instructions. A runner executes it against the vault and writes results back as governed changes."],
              ["Edge", "A typed link between nodes. Flow edges (e.g. next, on-success) form the graph a runner walks; conditions gate them."],
              ["Run", "One execution of an agent — a replayable trace of every read, branch, and write. Nothing is hidden."],
              ["Review / Approval", "A proposed change waiting for a human. Agent write-backs land here (human-in-the-loop) unless the nest is open."],
            ].map(([term, def]) => (
              <div key={term} className="grid grid-cols-[110px_1fr] gap-3">
                <dt className="font-medium">{term}</dt>
                <dd className="text-muted-foreground">{def}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section>
          <h2 className="text-base font-semibold mb-2">The governed loop</h2>
          <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
            <li>You write an <b>agent</b> node (instructions) and draw a flow <b>edge</b> to a target document.</li>
            <li>The <b>runner</b> triggers the agent, reads deterministic context, calls the LLM, and writes the output into the target — as a governed change.</li>
            <li>In a stewarded nest that change becomes a <b>pending review</b> in <b>My Work</b>.</li>
            <li>You <b>approve</b> (or reject) it. Approve publishes a new version; the whole run stays as an auditable trace.</li>
          </ol>
          <p className="text-muted-foreground mt-2">
            The point: an agent can do real work in your brain, but a person signs
            off — and you can always see exactly what it read and wrote.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold mb-2">The APIs (same ones the UI and runner use)</h2>
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
                  ["POST /nests/:id/context", "Deterministic retrieval — selector + hops. The governed read primitive."],
                  ["POST /nests/:id/run/:agent", "Trigger an agent; returns the run bundle (instructions + flow subgraph)."],
                  ["POST /runs/:id/steps · PATCH /runs/:id", "Record each step; close the run. The replayable trace."],
                  ["GET/POST /nests/:id/edges · /edge-types", "The typed-edge graph (the Workflows tab)."],
                  ["PATCH /nests/:id/nodes/:node", "Write a node (new version). Governed: draft + review when stewarded."],
                  ["POST /nests/:id/nodes/:node/approve · /reject", "Resolve a review — the human-in-the-loop hop."],
                  ["GET /me/work", "Your cross-nest inbox: reviews waiting on you + what you handed off."],
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
            Agents authenticate with a nest key (Bearer <code>cnst_…</code>);
            browsers use a session cookie. Same governed surface either way.
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold mb-2">How you'd use it</h2>
          <ul className="list-disc pl-5 space-y-1 text-muted-foreground">
            <li><b>Nightly digest</b> — an agent reads a folder or tag and writes a "what changed" summary node each morning.</li>
            <li><b>Draft-from-facts</b> — a skill turns a raw transcript into a structured recap, grounded only in the vault (no hallucinated facts).</li>
            <li><b>Escalation</b> — a conditional flow edge fires only when a metric crosses a threshold, and the agent flags it.</li>
            <li><b>Consistency sweeps</b> — an agent reads a set of nodes and surfaces contradictions or stale decisions for review.</li>
          </ul>
          <p className="text-muted-foreground mt-2">
            Turn the workflow plane on in <b>Server settings</b>, add an{" "}
            <b>Agent</b> node from New Document, wire an edge in the{" "}
            <b>Workflows</b> tab, and run it with the{" "}
            <code>contextnest-runner</code> (the command is in the Runs tab).
          </p>
        </section>
      </div>
    </div>
  );
}
