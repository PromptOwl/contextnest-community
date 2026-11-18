/**
 * Header bell for My Work: what waits on you, from any page — whether the
 * rail is open or not (CU-wdqcq067ub). Clicking it previews the inbox in a
 * dropdown; a row opens its item, the footer opens My Work (CU-wdqcq067uc).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { reads } from "@/lib/queries";
import { markNotificationsRead } from "@/lib/api";
import { waitingOnMeCount } from "@/lib/my-work-groups";

/** Rows per section — the preview is a glance; My Work has the rest. */
const PREVIEW = 5;

export function InboxBell({
  onOpen,
  onOpenDoc,
  onOpenNest,
}: {
  onOpen: () => void;
  onOpenDoc: (nestId: string, nestName: string, nodeId: string) => void;
  onOpenNest: (nestId: string, nestName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Same read as the rail's My Work badge (meta.badge), so one cached fetch.
  const { data } = useQuery(reads.myWork({ limit: 1 }));
  const count = waitingOnMeCount(data);
  const label = count ? `My Work — ${count} waiting on you` : "My Work";
  const notes = data?.notifications ?? [];
  const assigned = data?.assigned ?? [];
  // The one-row read carries one mention; the count is all of them (PO-1180).
  const mentions = data?.mentions ?? [];
  const mentionTotal = data?.mentions_pagination?.total ?? mentions.length;
  // waiting_on_me_total includes the open mentions; the summary row below is
  // the reviews and requests alone.
  const queued = Math.max(0, (data?.waiting_on_me_total ?? data?.pagination?.total ?? 0) - mentionTotal);
  const go = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  const row = "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-muted/60";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative h-8 w-8 shrink-0" title={label} aria-label={label}>
          <Bell className="h-4 w-4" />
          {count > 0 && (
            <span className="absolute -right-0.5 -top-0.5 min-w-[1rem] rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
              {count > 99 ? "99+" : count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0" data-testid="inbox-preview">
        <div className="max-h-96 overflow-y-auto divide-y">
          {count === 0 && <p className="px-3 py-4 text-sm text-muted-foreground">Nothing waiting on you.</p>}
          {notes.slice(0, PREVIEW).map((n) => (
            <button
              key={n.id}
              type="button"
              className={row}
              onClick={() =>
                go(() => {
                  // Opening marks it read, as on My Work.
                  markNotificationsRead([n.id]).catch(() => {});
                  if (n.node_id) onOpenDoc(n.nest_id, n.nest_name, n.node_id);
                  else onOpenNest(n.nest_id, n.nest_name);
                })
              }
            >
              <span className="line-clamp-2">{n.message}</span>
              <span className="text-xs text-muted-foreground">{n.nest_name}</span>
            </button>
          ))}
          {assigned.slice(0, PREVIEW).map((a) => (
            <button
              key={`${a.nest_id}:${a.node_id}`}
              type="button"
              className={row}
              onClick={() => go(() => onOpenDoc(a.nest_id, a.nest_name, a.node_id))}
            >
              <span className="truncate w-full">{a.title}</span>
              <span className="text-xs text-muted-foreground">Assigned to you · {a.nest_name}</span>
            </button>
          ))}
          {mentionTotal > 0 && (
            <button type="button" className={row} onClick={() => go(onOpen)}>
              <span className="line-clamp-2">
                {mentions[0] ? `${mentions[0].author_label}: ${mentions[0].excerpt}` : "You were mentioned"}
              </span>
              <span className="text-xs text-muted-foreground">
                {mentionTotal === 1 ? "1 mention waiting on your reply" : `${mentionTotal} mentions waiting on your reply`}
              </span>
            </button>
          )}
          {queued > 0 && (
            <button type="button" className={row} onClick={() => go(onOpen)}>
              {queued} {queued === 1 ? "review or request" : "reviews and requests"} waiting
            </button>
          )}
        </div>
        <button
          type="button"
          className="w-full border-t px-3 py-2 text-sm font-medium text-primary hover:bg-muted/60"
          onClick={() => go(onOpen)}
        >
          Open My Work
        </button>
      </PopoverContent>
    </Popover>
  );
}
