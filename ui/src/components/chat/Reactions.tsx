/**
 * Reactions under a message (PO-1200 AC-C3-12, C1 PO-1196): one chip per
 * emoji with its count, pressed when mine, and a picker with the quick six
 * and a box for any other emoji or shortcode. A tap toggles mine.
 */
import { useState } from "react";
import { SmilePlus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { MessageReaction } from "../../lib/api";
import { QUICK_EMOJI, reactionTitle } from "../../lib/chat-messages";

export function ReactionPicker({ onPick, className, open, onOpenChange }: { onPick: (emoji: string) => void; className?: string; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [text, setText] = useState("");
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Add a reaction" title="Add a reaction" className={className} data-testid="reaction-add">
          <SmilePlus className="h-3.5 w-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2" data-testid="reaction-picker">
        <div className="flex gap-0.5" role="group" aria-label="Quick reactions">
          {QUICK_EMOJI.map((e) => (
            <button key={e} type="button" onClick={() => onPick(e)} className="flex h-8 w-8 items-center justify-center rounded-md text-base hover:bg-muted" aria-label={`React with ${e}`}>
              {e}
            </button>
          ))}
        </div>
        <form
          className="mt-2 flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const v = text.trim();
            if (!v) return;
            onPick(v);
            setText("");
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Any emoji or :name:"
            aria-label="Any emoji or shortcode"
            className="h-8 w-36 rounded-md border border-input bg-background px-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <button type="submit" className="h-8 rounded-md border px-2 text-xs font-medium hover:bg-muted">
            Add
          </button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function ReactionBar({ reactions, onToggle, canReact }: { reactions: MessageReaction[] | undefined; onToggle: (emoji: string) => void; canReact: boolean }) {
  if (!reactions?.length) return null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="reactions">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() => canReact && onToggle(r.emoji)}
          disabled={!canReact}
          aria-pressed={r.me}
          title={reactionTitle(r)}
          className={cn(
            "inline-flex h-6 items-center gap-1 rounded-full border px-1.5 text-xs leading-none transition-colors",
            r.me ? "border-primary/40 bg-primary/10 text-primary" : "bg-background text-foreground hover:bg-muted",
            !canReact && "cursor-default",
          )}
          data-testid="reaction"
        >
          <span aria-hidden>{r.emoji}</span>
          <span className="font-medium tabular-nums">{r.count}</span>
        </button>
      ))}
      {canReact && <ReactionPicker onPick={onToggle} className="flex h-6 w-6 items-center justify-center rounded-full border text-muted-foreground hover:bg-muted hover:text-foreground" />}
    </div>
  );
}
