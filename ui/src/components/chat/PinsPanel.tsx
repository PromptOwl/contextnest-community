/**
 * A channel's pinned messages (PO-1200 AC-C3-12, C1 PO-1196): a popover from
 * the channel header, newest pin first, each opening its thread.
 */
import { useQuery } from "@tanstack/react-query";
import { Pin } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { PinnedMessage } from "../../lib/api";
import { authorOf } from "../../lib/channels";
import { relTime } from "../../lib/dates";
import { plainExcerpt } from "../../lib/plain-excerpt";
import { reads } from "../../lib/queries";
import { ErrorState } from "./States";

export function PinsButton({ nestId, channel, onOpen }: { nestId: string; channel: string; onOpen: (pin: PinnedMessage) => void }) {
  const pins = useQuery({ ...reads.channelPins(nestId, channel) });
  const count = pins.data?.pins.length ?? 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={count ? `${count} pinned` : "Pinned messages"}
          title="Pinned messages"
          data-testid="pins-button"
          className="flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Pin className="h-3.5 w-3.5" aria-hidden />
          {count > 0 && <span className="tabular-nums">{count}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" data-testid="pins-panel">
        <div className="flex h-9 items-center border-b px-3 text-xs font-semibold text-muted-foreground">Pinned in #{channel}</div>
        {pins.isError ? (
          <ErrorState title="Couldn't load pins" detail={(pins.error as Error)?.message} onRetry={() => void pins.refetch()} className="m-2" />
        ) : count === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-muted-foreground">{pins.isLoading ? "Loading…" : "Nothing pinned yet. Pin a message from its actions."}</p>
        ) : (
          <ul className="max-h-80 divide-y overflow-y-auto">
            {pins.data!.pins.map((p) => {
              const who = authorOf(p.message);
              return (
                <li key={p.message.id}>
                  <button type="button" onClick={() => onOpen(p)} className="block w-full px-3 py-2 text-left hover:bg-muted" data-testid="pin-row">
                    <span className="flex items-baseline gap-2 text-xs">
                      <span className="font-medium text-foreground">{who.name}</span>
                      <span className="text-muted-foreground">{relTime(p.message.created_at)}</span>
                      <span className="ml-auto text-muted-foreground">pinned by {p.pinned_by_name}</span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-sm">{plainExcerpt(p.message.body, [{ email: p.message.author, name: p.message.author_name }])}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
