/**
 * The first-run explainer (PO-1200, AC-C3-18): what this chat is, in three
 * lines, the first time a person opens it, until they dismiss it. Shown
 * above the conversation on the full page; remembered in this browser only
 * (a per-viewer convenience; a blocked store shows nothing rather than
 * nagging).
 */
import { useState } from "react";
import { AtSign, GitPullRequestArrow, MessagesSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { browserStore, introSeen, markIntroSeen } from "../../lib/chat-harness";

const POINTS = [
  { icon: MessagesSquare, title: "Next to the knowledge", text: "Channels, direct messages and threads live in this nest, beside its documents." },
  { icon: AtSign, title: "Agents are members", text: "Type @ to bring in a teammate or an agent; an agent answers in the thread." },
  { icon: GitPullRequestArrow, title: "Keep what matters", text: "Promote a thread to a decision or a task, and it becomes part of the nest." },
];

export function ChatIntro({ me }: { me: string | null }) {
  // Read on render, not frozen at mount: `me` may still be loading then.
  const [dismissed, setDismissed] = useState(false);
  if (!me || dismissed || introSeen(browserStore(), me)) return null;
  const dismiss = () => {
    markIntroSeen(browserStore(), me);
    setDismissed(true);
  };
  return (
    <section className="mx-4 mt-3 shrink-0 rounded-lg border bg-muted/30 px-4 py-3" aria-label="About team chat" data-testid="chat-intro">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Team chat, inside the nest</h2>
          <ul className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-3">
            {POINTS.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-2">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="text-xs leading-4 text-muted-foreground">
                  <span className="block font-medium text-foreground">{title}</span>
                  {text}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <Button size="sm" variant="ghost" className="-mr-2 -mt-1 h-7 shrink-0 text-xs" onClick={dismiss} data-testid="chat-intro-dismiss">
          Got it
        </Button>
      </div>
    </section>
  );
}
