import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** The one page heading: icon + title on the left, actions on the right,
 *  description underneath. Every app page uses it so they read the same. */
export function PageTitle({
  icon: Icon,
  title,
  description,
  actions,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned buttons (Invite, New Team, Save…). */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-4", className)} data-testid="page-title">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          {Icon && <Icon className="h-6 w-6 shrink-0 text-muted-foreground" />}
          {title}
        </h1>
        {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {description && (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
