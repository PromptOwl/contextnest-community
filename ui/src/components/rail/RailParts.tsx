/**
 * The navigation rail's building blocks — one definition for the real rail
 * (DocumentSidebar, App's Docs row and account trigger) and the Server
 * settings preview (NavColorField, PO-1430), so the preview can't drift from
 * what everyone sees.
 */
import { forwardRef, type ButtonHTMLAttributes, type ComponentType, type ReactNode } from "react";
import { ChevronDown, ChevronRight, PanelLeftClose } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { RAIL_IDLE_TEXT } from "../../lib/nav-color";

/* One row style for both rails (app pages and a nest's views / tree) so the
   sidebar reads the same wherever you are: same text size, icon, height. */
export const ROW = "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted";
export const ROW_IDLE = `${RAIL_IDLE_TEXT} hover:text-foreground`;
export const ROW_ACTIVE = "bg-muted font-medium text-foreground";
export const ROW_ICON = "h-4 w-4 shrink-0";

type Icon = ComponentType<{ className?: string }>;

/** Brand row at the top of the rail: logo, name, edition badge, hide button. */
export function RailBrand({
  logoUrl,
  onOpen,
  onCollapse,
  preview = false,
}: {
  logoUrl: string;
  onOpen?: () => void;
  onCollapse?: () => void;
  /** In the settings preview: no test ids, so the real rail's stay unique. */
  preview?: boolean;
}) {
  return (
    <div className="flex h-16 shrink-0 items-center justify-between gap-1 border-b border-border px-4">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 items-center gap-2 hover:opacity-80"
        title="Dashboard"
        data-testid={preview ? undefined : "document-sidebar-brand"}
      >
        {/* The owl is navy, so it sits on a white tile against the colored rail. */}
        <img src={logoUrl} alt="ContextNest" className="h-8 w-8 rounded-md bg-white object-contain p-1" />
        <span className="font-semibold">ContextNest</span>
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
          Community
        </Badge>
      </button>
      <button
        type="button"
        onClick={onCollapse}
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        title="Hide sidebar"
        aria-label="Hide sidebar"
        data-testid={preview ? undefined : "document-sidebar-collapse"}
      >
        <PanelLeftClose className="h-4 w-4" />
      </button>
    </div>
  );
}

/** A rail row: icon, label, optional count pill. */
export const RailRow = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    icon: Icon;
    label: ReactNode;
    active?: boolean;
    count?: number;
    /** "primary": the filled pill (pending work); otherwise a quiet one. */
    tone?: "primary" | "muted";
  }
>(function RailRow({ icon: Icon, label, active = false, count = 0, tone = "muted", className, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(ROW, active ? ROW_ACTIVE : ROW_IDLE, className)}
      {...rest}
    >
      <Icon className={ROW_ICON} />
      <span className="truncate">{label}</span>
      {count > 0 && (
        <span
          className={cn(
            "ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums",
            tone === "primary" ? "bg-primary text-primary-foreground" : "bg-muted-foreground/15 text-muted-foreground",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
});

/** A nest's heading in the rail's nest list: fold chevron, name, glyphs. */
export function RailNestHeading({
  name,
  open,
  current,
  glyphs,
  nameClassName,
  title,
  onToggle,
  onOpen,
  extra,
  nameProps,
}: {
  name: string;
  open: boolean;
  current: boolean;
  /** Shared / visibility markers after the name. */
  glyphs?: ReactNode;
  nameClassName?: string;
  title?: string;
  onToggle?: () => void;
  onOpen?: () => void;
  /** Trailing controls (the + for a new document). */
  extra?: ReactNode;
  nameProps?: Record<string, unknown>;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded px-1.5 py-1",
        current ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="rounded p-0.5 hover:bg-muted"
        aria-label={open ? `Collapse ${name}` : `Expand ${name}`}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 truncate text-left text-xs font-semibold uppercase tracking-wide hover:text-foreground",
          nameClassName,
        )}
        title={title}
        {...nameProps}
      >
        <span className="truncate">{name}</span>
        {glyphs}
      </button>
      {extra}
    </div>
  );
}

/** The rail's foot (Docs, the account menu). */
export function RailFooter({ children, preview = false }: { children: ReactNode; preview?: boolean }) {
  return (
    <div className="shrink-0 space-y-0.5 border-t border-border p-2" data-testid={preview ? undefined : "document-sidebar-footer"}>
      {children}
    </div>
  );
}

/** What the account trigger shows: avatar initial, name, chevron. */
export function AccountTriggerBody({ displayName, inSidebar }: { displayName: string; inSidebar: boolean }) {
  return (
    <>
      <Avatar className="h-[1.8rem] w-[1.8rem] rounded-sm shrink-0">
        <AvatarFallback className="rounded-sm">{displayName.charAt(0)}</AvatarFallback>
      </Avatar>
      <span
        className={
          inSidebar
            ? "min-w-0 flex-1 truncate text-left text-sm font-medium"
            : "hidden sm:inline max-w-[140px] truncate text-sm font-medium"
        }
      >
        {displayName}
      </span>
      <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground ${inSidebar ? "rotate-180" : ""}`} />
    </>
  );
}

/** The account trigger's button classes (App's UserMenu uses the same). */
export const ACCOUNT_TRIGGER_SIDEBAR = "group h-10 w-full justify-start gap-2 px-2";
