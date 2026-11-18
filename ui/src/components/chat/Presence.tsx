/**
 * Presence and the people picker the C2 screens share (PO-1200, AC-C3-15,
 * AC-C3-16): a dot for "around now" (the app's own live-status green, a
 * hollow ring otherwise), a member's avatar with that dot on its corner, and
 * a searchable list of the nest's people and agents to pick from.
 */
import { useMemo, useState } from "react";
import { Bot, Check, Search, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentHandle, ConversationView } from "../../lib/api";
import { dmPeer } from "../../lib/chat-harness";
import { initialsOf } from "../../lib/doc-stream";
import type { MentionMember } from "../MarkdownEditor/picker-match";

export function PresenceDot({ online, className }: { online: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full", online ? "bg-emerald-500" : "border border-muted-foreground/50 bg-background", className)}
    />
  );
}

/** A member's square avatar (initials, or the bot mark), with presence on its corner. */
export function MemberAvatar({ kind, label, online, size = "md" }: { kind: "person" | "agent"; label: string; online?: boolean; size?: "sm" | "md" }) {
  return (
    <span className="relative shrink-0" aria-hidden>
      <span
        className={cn(
          "flex select-none items-center justify-center rounded-md bg-muted font-medium text-muted-foreground",
          size === "sm" ? "h-5 w-5 text-[9px]" : "h-8 w-8 text-xs",
        )}
      >
        {kind === "agent" ? <Bot className={size === "sm" ? "h-3 w-3" : "h-4 w-4"} /> : initialsOf(label)}
      </span>
      {online !== undefined && kind === "person" && (
        <PresenceDot online={online} className={cn("absolute ring-2 ring-background", size === "sm" ? "-bottom-0.5 -right-0.5 h-1.5 w-1.5" : "-bottom-0.5 -right-0.5")} />
      )}
    </span>
  );
}

/** A conversation's mark: the other person (with presence) or agent for a
 *  dm, a people mark for a group. One size everywhere it is listed. */
export function ConversationIcon({ conversation, me, online }: { conversation: Pick<ConversationView, "kind" | "members">; me: string | null; online: ReadonlySet<string> }) {
  const peer = dmPeer(conversation, me);
  if (!peer)
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground" aria-hidden>
        <Users className="h-3 w-3" />
      </span>
    );
  return (
    <MemberAvatar
      kind={peer.kind}
      label={peer.kind === "agent" ? peer.handle : peer.name || peer.email}
      online={peer.kind === "person" ? online.has(peer.email.toLowerCase()) : undefined}
      size="sm"
    />
  );
}

export type Candidate =
  | { kind: "person"; email: string; name: string }
  | { kind: "agent"; handle: string };

export const pickKey = (p: Candidate) => (p.kind === "agent" ? `agent:${p.handle}` : `person:${p.email.toLowerCase()}`);
const pickLabel = (p: Candidate) => (p.kind === "agent" ? `@${p.handle}` : p.name || p.email);

/**
 * People, then agents, filtered by what is typed; the caller and anyone in
 * `exclude` are left out. Clicking a row toggles it in `picked`.
 */
export function PeoplePicker({
  people,
  agents,
  me,
  exclude,
  picked,
  onToggle,
  autoFocus,
  testId,
}: {
  people: MentionMember[];
  agents: AgentHandle[];
  me: string | null;
  exclude?: ReadonlySet<string>;
  picked: readonly Candidate[];
  onToggle: (p: Candidate) => void;
  autoFocus?: boolean;
  testId?: string;
}) {
  const [q, setQ] = useState("");
  const options = useMemo(() => {
    const mine = (me ?? "").toLowerCase();
    const all: Candidate[] = [
      ...people.filter((p) => p.email.toLowerCase() !== mine).map((p) => ({ kind: "person" as const, email: p.email, name: p.name || p.email })),
      ...agents.map((a) => ({ kind: "agent" as const, handle: a.handle })),
    ];
    const words = q.toLowerCase().replace(/^@/, "").split(/\s+/).filter(Boolean);
    return all.filter((o) => {
      if (exclude?.has(pickKey(o))) return false;
      const hay = (o.kind === "agent" ? o.handle : `${o.name} ${o.email}`).toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [people, agents, me, exclude, q]);
  const chosen = new Set(picked.map(pickKey));

  return (
    <div className="flex min-h-0 flex-col" data-testid={testId}>
      <label className="relative block">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Find a person or an agent"
          aria-label="Find a person or an agent"
          autoFocus={autoFocus}
          className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </label>
      <div className="mt-2 max-h-64 min-h-0 overflow-y-auto" role="listbox" aria-multiselectable="true" aria-label="People and agents">
        {options.length === 0 ? (
          <p className="px-2 py-3 text-sm text-muted-foreground">{q ? "Nobody on this nest matches." : "Everyone here is already in it."}</p>
        ) : (
          options.map((o) => {
            const on = chosen.has(pickKey(o));
            return (
              <button
                key={pickKey(o)}
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => onToggle(o)}
                className={cn("flex h-10 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring", on && "bg-muted")}
                data-testid="people-option"
              >
                <MemberAvatar kind={o.kind} label={pickLabel(o)} size="sm" />
                <span className="min-w-0 flex-1 truncate">
                  {pickLabel(o)}
                  {o.kind === "person" && o.name !== o.email && <span className="ml-2 text-xs text-muted-foreground">{o.email}</span>}
                  {o.kind === "agent" && <span className="ml-2 text-xs text-muted-foreground">Agent</span>}
                </span>
                {on && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

export { pickLabel };
