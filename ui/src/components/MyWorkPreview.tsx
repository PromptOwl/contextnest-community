/**
 * The My Work dropdown: what waits on you, from any page (CU-wdqcq067ub).
 * It hangs off the My Work item in the header ribbon. Clicking the item opens
 * a preview; a row opens its item, the footer opens My Work (CU-wdqcq067uc).
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { reads } from "@/lib/queries";
import { markNotificationsRead } from "@/lib/api";
import { waitingOnMeCount } from "@/lib/my-work-groups";

/** Rows per section — the preview is a glance; My Work has the rest. */
const PREVIEW = 5;

export function MyWorkPreview({
  trigger,
  onOpen,
  onOpenDoc,
  onOpenNest,
}: {
  /** The ribbon's My Work button; clicking it toggles the preview. */
  trigger: ReactNode;
  onOpen: () => void;
  onOpenDoc: (nestId: string, nestName: string, nodeId: string) => void;
  onOpenNest: (nestId: string, nestName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Same read as the rail's My Work badge (meta.badge), so one cached fetch.
  const { data } = useQuery(reads.myWork({ limit: 1 }));
  const count = waitingOnMeCount(data);
  const notes = data?.notifications ?? [];
  const assigned = data?.assigned ?? [];
  const queued = data?.waiting_on_me_total ?? data?.pagination?.total ?? 0;
  const go = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  const row = "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-muted/60";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0" data-testid="inbox-preview">
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
