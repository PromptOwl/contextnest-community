/**
 * The page's non-content states. A failed read is shown as a failure with
 * Retry, never as "nothing here"; an empty state says what to do next.
 */
import type { ReactNode } from "react";
import { AlertCircle, Loader2, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {label}
    </div>
  );
}

export function ErrorState({
  title,
  detail,
  onRetry,
  children,
}: {
  title: string;
  /** The server's message, shown as is. */
  detail?: string | null;
  onRetry: () => void;
  /** Another way out, beside Retry. */
  children?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3"
      data-testid="channels-error"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        {detail && <p className="mt-0.5 text-sm text-muted-foreground [overflow-wrap:anywhere]">{detail}</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={onRetry}>
            Retry
          </Button>
          {children}
        </div>
      </div>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  children,
}: {
  icon: LucideIcon;
  title: string;
  /** What to do next. */
  hint: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed px-6 py-10 text-center" data-testid="channels-empty">
      <Icon className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden />
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{hint}</p>
      {children && <div className="mt-4 flex justify-center">{children}</div>}
    </div>
  );
}
