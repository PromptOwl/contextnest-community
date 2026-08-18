import { cn } from "@/lib/utils";

/** Placeholder for a stat that hasn't loaded. Stands in for the digits so a
 *  cold load doesn't read as a real 0, and sized so the card doesn't jump
 *  when the count lands. */
export function CountSkeleton({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-6 w-10 rounded bg-muted-foreground/20 animate-pulse align-middle",
        className,
      )}
      aria-hidden
    />
  );
}
