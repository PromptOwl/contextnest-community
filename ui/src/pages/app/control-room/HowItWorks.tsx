/**
 * Control room → How it works (po-1186 CR3): how the listener decides what to
 * keep, what is never kept, how to audit it, and the exact page channel
 * members get from the bot's one notice (GET /about/surfaces). Numbers come
 * from this server's Surfaces settings.
 */
import { ExternalLink, FileText, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { SurfacesSettingsView } from "../../../lib/api";
import { DEFAULT_SETTINGS_COPY } from "../../../lib/control-room-setup";

function Card({ title, sub, children, testId }: { title: string; sub?: string; children: ReactNode; testId?: string }) {
  return (
    <section className="min-w-0 rounded-lg border bg-card" data-testid={testId}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 pb-1 pt-4">
        <h2 className="text-base font-semibold">{title}</h2>
        {sub && <span className="text-sm text-muted-foreground">{sub}</span>}
      </div>
      <div className="px-4 pb-4 pt-3">{children}</div>
    </section>
  );
}

export function HowItWorks({ settings, orgName, onAgents }: { settings: SurfacesSettingsView | null; orgName: string | null; onAgents: () => void }) {
  const s = { ...DEFAULT_SETTINGS_COPY, ...(settings ?? {}) };
  const steps: Array<[string, string]> = [
    [
      "Listen",
      `Only in channels an admin turned on${s.dm_capture ? ", and in DMs people start with it" : ""}. Messages that are too short or match a never-capture word are dropped on arrival.`,
    ],
    ["Wait", `Nothing happens while people are still talking. A thread is judged once it has been quiet for ${s.quiet_minutes} minutes.`],
    ["Judge", "A model reads that one thread and decides if it holds a decision, a fact, an owner or a deadline. Usually the answer is no, and the thread is forgotten."],
    [
      "Ask",
      `If yes, one card goes to one named reviewer, in the thread it came from. At most ${s.reviewer_daily_cards} ${s.reviewer_daily_cards === 1 ? "card" : "cards"} per reviewer and ${s.conversation_daily_cards} per channel a day.`,
    ],
    ["Save", "Only the reviewer can save it, under their own name. It lands as a new version in the nest, linked back to the thread."],
  ];
  const host = typeof window !== "undefined" ? window.location.host : "";

  return (
    <div className="space-y-4" data-testid="control-room-how">
      <Card title="How it decides what to keep" sub="For admins and reviewers" testId="how-flow">
        <ol className="grid grid-cols-[minmax(0,1fr)] gap-0 min-[801px]:grid-cols-5">
          {steps.map(([t, p], i) => (
            <li key={t} className="py-3 pr-4 min-[801px]:py-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                Step {i + 1}
                {i < steps.length - 1 && <span className="hidden h-px flex-1 bg-border min-[801px]:block" aria-hidden />}
              </div>
              <h3 className="mb-1 mt-1.5 text-[15px] font-semibold">{t}</h3>
              <p className="text-sm leading-relaxed text-foreground/80">{p}</p>
            </li>
          ))}
        </ol>
        <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 min-[801px]:grid-cols-2">
          <div className="flex gap-3 rounded-lg border bg-muted/40 px-4 py-3 text-sm">
            <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>
              <b>What is never kept.</b> Message text is held encrypted only until its thread is judged, and never more than {s.buffer_ttl_hours} hours. The ledger stores counts, verdicts and reasons, never what anyone said.
            </p>
          </div>
          <div className="flex gap-3 rounded-lg border bg-muted/40 px-4 py-3 text-sm">
            <FileText className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>
              <b>How to audit it.</b> Every judged thread is a row in the decision ledger, including the ones where it decided to do nothing. Open any saved note to see the run, the verdict, the card, who approved it and the thread it came from.
            </p>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 min-[1101px]:grid-cols-2">
        <Card title="What channel members see" sub="The bot links this page in its first message" testId="how-member">
          <div className="max-w-[420px] rounded-lg border bg-background p-5 text-sm">
            <div className="mb-1.5 break-all text-muted-foreground">{host}/about/surfaces</div>
            <h3 className="mb-2 text-[17px] font-semibold">How Nest handles your messages</h3>
            <p className="mb-2.5 leading-relaxed text-foreground/80">
              Your admin turned on Nest in {orgName ? `some ${orgName} channels` : "some of your team's channels"}. It helps the team remember decisions without anyone writing them up.
            </p>
            <p className="mb-2.5 leading-relaxed text-foreground/80">
              <b className="text-foreground">It reads</b> messages in those channels only, never DMs between people, and never old history.
            </p>
            <p className="mb-2.5 leading-relaxed text-foreground/80">
              <b className="text-foreground">It keeps</b> nothing unless a named teammate approves a short summary. Raw messages are deleted within {s.buffer_ttl_hours} hours.
            </p>
            <p className="mb-2.5 leading-relaxed text-foreground/80">
              <b className="text-foreground">It never saves</b> anything about pay, health, performance or personal life.
            </p>
            <p className="leading-relaxed text-foreground/80">
              <b className="text-foreground">You can</b> say <code className="font-mono">@Nest skip me</code> to keep your messages out, or ask an admin to remove it from a channel.
            </p>
          </div>
          <a href="/about/surfaces" target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm text-primary underline underline-offset-2">
            Open the page
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        </Card>
        <Card title="Agents you run yourself" testId="how-agents">
          <p className="mb-2.5 text-sm leading-relaxed text-foreground/80">
            The listeners are one kind of agent. Anything else that works on your behalf, such as Claude Code, a scheduled script or a support bot, can report its runs and decisions to the same ledger through the API or MCP.
          </p>
          <p className="mb-2.5 text-sm leading-relaxed text-foreground/80">
            Those agents follow the same rule: anything they want saved in the nest goes through a person's review first, and the ledger records who approved it.
          </p>
          <Button variant="outline" onClick={onAgents}>
            Connect an agent
          </Button>
        </Card>
      </div>
    </div>
  );
}
