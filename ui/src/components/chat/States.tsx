/**
 * The harness's non-content states (PO-1200, AC-C3-09): skeletons in the
 * shape of the final layout, an empty state that says what to do next, and a
 * failure named as one with Retry. A failed read is never "nothing here".
 */
import type { ReactNode } from "react";
import { AlertCircle, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const Bone = ({ className, width }: { className?: string; width?: number }) => <div className={cn("rounded bg-muted", className)} style={width ? { width } : undefined} aria-hidden />;

/** The sidebar while the channel list loads: a search box and six rows. */
export function SidebarSkeleton() {
  return (
    <div className="space-y-4 px-3 pt-3" role="status" aria-label="Loading channels">
      <Bone className="h-8 w-full" />
      <div className="space-y-1">
        <Bone className="mb-2 h-3 w-16" />
        {[88, 64, 72, 56, 80, 60].map((w, i) => (
          <div key={i} className="flex h-8 items-center gap-2 px-2">
            <Bone className="h-3.5 w-3.5" />
            <Bone className="h-3.5" width={w} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The conversation while it loads: three message groups and a composer. */
export function ConversationSkeleton({ compact }: { compact?: boolean }) {
  return (
    <div className="flex h-full flex-col" role="status" aria-label="Loading messages">
      {!compact && (
        <div className="flex h-12 items-center border-b px-4">
          <Bone className="h-4 w-28" />
        </div>
      )}
      <div className="flex-1 space-y-6 px-4 py-4">
        {[["w-32", "w-3/4", "w-1/2"], ["w-24", "w-2/3"], ["w-28", "w-5/6", "w-2/5", "w-1/3"]].map((lines, i) => (
          <div key={i} className="flex gap-3">
            <Bone className="h-8 w-8 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2 pt-1">
              {lines.map((w, j) => (
                <Bone key={j} className={cn("h-3.5", w, j === 0 && "h-3")} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="px-4 pb-4">
        <Bone className="h-20 w-full rounded-lg" />
      </div>
    </div>
  );
}

/** The thread pane while its replies load. */
export function ThreadSkeleton() {
  return (
    <div className="space-y-5 px-4 py-4" role="status" aria-label="Loading replies">
      {[["w-24", "w-5/6"], ["w-20", "w-2/3", "w-1/2"]].map((lines, i) => (
        <div key={i} className="flex gap-3">
          <Bone className="h-7 w-7 shrink-0" />
          <div className="min-w-0 flex-1 space-y-2 pt-1">
            {lines.map((w, j) => (
              <Bone key={j} className={cn("h-3.5", w, j === 0 && "h-3")} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function ErrorState({
  title,
  detail,
  onRetry,
  children,
  className,
}: {
  title: string;
  /** The server's message, shown as is. */
  detail?: string | null;
  onRetry: () => void;
  /** Another way out, beside Retry. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div role="alert" className={cn("flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3", className)} data-testid="chat-error">
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
  className,
}: {
  icon: LucideIcon;
  title: string;
  /** What to do next. */
  hint: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)} data-testid="chat-empty">
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">{hint}</p>
      {children && <div className="mt-4 flex justify-center">{children}</div>}
    </div>
  );
}
