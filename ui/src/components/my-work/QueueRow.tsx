/** One row of the review workspace's queue: title, path, who and when. */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function QueueRow({
  title,
  path,
  who,
  when,
  badge,
  selected,
  checkbox,
  action,
  onOpen,
}: {
  title: string;
  path: string;
  who: string;
  when: string;
  badge?: ReactNode;
  selected: boolean;
  checkbox?: ReactNode;
  /** Shown on the open row, and on hover or focus. */
  action?: ReactNode;
  onOpen: () => void;
}) {
  return (
    <div
      className={cn(
        "group relative flex items-start gap-2.5 border-b border-l-2 px-3 py-2.5",
        selected ? "border-l-primary bg-primary/10" : "border-l-transparent hover:bg-muted/50",
      )}
      data-testid="my-work-row"
    >
      {checkbox && <span className="pt-0.5">{checkbox}</span>}
      <button type="button" onClick={onOpen} aria-current={selected || undefined} className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-2">
          <span className={cn("truncate text-sm font-medium", selected && "text-primary")}>{title}</span>
          {badge}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground" title={path}>
          {path}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">{who}</span> · {when}
        </span>
      </button>
      {action && (
        <span
          className={cn(
            "absolute right-2.5 top-2",
            !selected && "opacity-0 focus-within:opacity-100 group-hover:opacity-100",
          )}
        >
          {action}
        </span>
      )}
    </div>
  );
}
