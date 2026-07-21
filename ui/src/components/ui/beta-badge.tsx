import { cn } from "@/lib/utils";

/**
 * BetaBadge — the single small "Beta" chip used on every Workflows-facing
 * surface (the Settings toggle, the Workflows nav button, the Guide's
 * workflow sections). One component so the label reads identically
 * everywhere and can be removed in one place when the plane graduates.
 * A <span> (not the Badge div) so it can legally sit inside buttons/labels.
 */
export function BetaBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border border-blue-200 bg-blue-100 px-1.5 py-0 text-[10px] font-semibold uppercase tracking-wide leading-4 text-blue-700 dark:border-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
        className,
      )}
    >
      Beta
    </span>
  );
}
