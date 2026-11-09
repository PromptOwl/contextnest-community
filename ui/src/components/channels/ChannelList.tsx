/**
 * The channel list beside the conversation (desktop) and its compact twin, a
 * switcher above it (phone). The number beside a channel is unread messages,
 * never a total. Archived channels sit in their own section with Restore.
 */
import { useState } from "react";
import { Archive, Check, ChevronDown, ChevronRight, Hash, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ChannelSummary } from "../../lib/api";
import { unreadLabel } from "../../lib/channels";

interface ListProps {
  channels: ChannelSummary[];
  archived: ChannelSummary[];
  selected: string | null;
  /** May create, archive and restore channels. */
  canManage: boolean;
  onSelect: (name: string) => void;
  onNew: () => void;
  onRestore: (channel: ChannelSummary) => void;
}

function Unread({ count, className }: { count: number; className?: string }) {
  const label = unreadLabel(count);
  if (!label) return null;
  return (
    <span
      className={cn(
        "min-w-5 rounded-full bg-primary px-1.5 text-center text-[11px] font-semibold leading-5 text-primary-foreground",
        className,
      )}
      aria-label={`${count} unread`}
      data-testid="channel-unread"
    >
      {label}
    </span>
  );
}

export function NewChannelButton({ onNew, className }: { onNew: () => void; className?: string }) {
  return (
    <Button size="sm" variant="outline" onClick={onNew} className={className} data-testid="channel-new">
      <Plus className="mr-1 h-3.5 w-3.5" /> New channel
    </Button>
  );
}

export function ChannelList({ channels, archived, selected, canManage, onSelect, onNew, onRestore }: ListProps) {
  const [showArchived, setShowArchived] = useState(false);
  // An archived channel that is open shows its section, so the highlight is visible.
  const archivedOpen = showArchived || archived.some((c) => c.name === selected);
  return (
    <aside className="min-w-0" data-testid="channel-list">
      <div className="mb-2 flex h-8 items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channels</h2>
        {canManage && <NewChannelButton onNew={onNew} />}
      </div>
      <nav aria-label="Channels" className="space-y-0.5">
        {channels.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onSelect(c.name)}
            aria-current={c.name === selected ? "page" : undefined}
            className={cn(
              "flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-sm",
              c.name === selected ? "bg-muted font-medium" : "hover:bg-muted/60",
              c.unread > 0 && c.name !== selected && "font-semibold",
            )}
          >
            <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{c.name}</span>
            <Unread count={c.unread} className="ml-auto" />
          </button>
        ))}
      </nav>
      {archived.length > 0 && (
        <div className="mt-4 border-t pt-3" data-testid="channel-archived">
          <button
            type="button"
            onClick={() => setShowArchived(!archivedOpen)}
            aria-expanded={archivedOpen}
            className="flex h-8 w-full items-center gap-1 rounded-md px-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {archivedOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Archived ({archived.length})
          </button>
          {archivedOpen && (
            <ul className="mt-0.5 space-y-0.5">
              {archived.map((c) => (
                <li key={c.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onSelect(c.name)}
                    aria-current={c.name === selected ? "page" : undefined}
                    className={cn(
                      "flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-sm text-muted-foreground",
                      c.name === selected ? "bg-muted font-medium text-foreground" : "hover:bg-muted/60",
                    )}
                  >
                    <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{c.name}</span>
                  </button>
                  {canManage && (
                    <Button size="sm" variant="ghost" onClick={() => onRestore(c)} aria-label={`Restore ${c.title}`}>
                      Restore
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}

/** Phone: the channel list as one button that opens a menu. An archived
 *  channel is restored from its own header once opened. */
export function ChannelSwitcher({ channels, archived, selected, canManage, onSelect, onNew }: Omit<ListProps, "onRestore">) {
  const current = [...channels, ...archived].find((c) => c.name === selected);
  const elsewhere = channels.reduce((n, c) => (c.name === selected ? n : n + c.unread), 0);
  return (
    <div className="flex items-center gap-2" data-testid="channel-switcher">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="min-w-0 flex-1 justify-start gap-1.5 text-sm" aria-label="Switch channel">
            <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{current?.name ?? selected ?? "Choose a channel"}</span>
            <Unread count={elsewhere} className="ml-auto" />
            <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", elsewhere ? "" : "ml-auto")} aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[60vh] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto">
          <DropdownMenuLabel>Channels</DropdownMenuLabel>
          {channels.map((c) => (
            <DropdownMenuItem key={c.id} onSelect={() => onSelect(c.name)} className="h-9 gap-2">
              <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className={cn("truncate", c.unread > 0 && "font-semibold")}>{c.name}</span>
              {c.name === selected ? <Check className="ml-auto h-3.5 w-3.5" aria-label="Open" /> : <Unread count={c.unread} className="ml-auto" />}
            </DropdownMenuItem>
          ))}
          {archived.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Archived</DropdownMenuLabel>
              {archived.map((c) => (
                <DropdownMenuItem key={c.id} onSelect={() => onSelect(c.name)} className="h-9 gap-2 text-muted-foreground">
                  <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{c.name}</span>
                  {c.name === selected && <Check className="ml-auto h-3.5 w-3.5" aria-label="Open" />}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {canManage && <NewChannelButton onNew={onNew} className="shrink-0" />}
    </div>
  );
}
