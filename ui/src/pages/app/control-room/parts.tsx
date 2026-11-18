/**
 * Control room (po-1186 CR2): the small shared pieces the Overview, Decision
 * ledger and Agents tabs draw with. Design-system tokens only (AC-CR-11): no
 * hex, status colour only inside badges and alerts, lucide icons at the app's
 * stroke weight, no emoji.
 */
import type { ReactNode } from "react";
import { Bot, BrainCircuit, Ear, Terminal, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { BadgeTone } from "../../../lib/control-room-overview";

/** A status badge. "primary" is the one accent (a proposal); the rest are the app's badge variants. */
export function ToneBadge({ tone, children, className }: { tone: BadgeTone; children: ReactNode; className?: string }) {
  if (tone === "primary") {
    return (
      <Badge variant="outline" className={cn("whitespace-nowrap border-primary/40 bg-background font-semibold text-primary", className)}>
        {children}
      </Badge>
    );
  }
  return (
    <Badge variant={tone} className={cn("whitespace-nowrap", className)}>
      {children}
    </Badge>
  );
}

const SOURCE_ICON: Record<string, LucideIcon> = {
  surfaces: Ear,
  metacognition: BrainCircuit,
  external: Terminal,
  runner: Bot,
};

export function AgentIcon({ source, className }: { source: string; className?: string }) {
  const Icon = SOURCE_ICON[source] ?? Bot;
  return <Icon className={cn("h-4 w-4 shrink-0 text-muted-foreground", className)} aria-hidden />;
}

export function Card({ children, className, ...rest }: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={cn("min-w-0 rounded-lg border bg-card", className)} {...rest}>
      {children}
    </section>
  );
}

/** Card heading: title, a muted one-line description, optional controls on the right. */
export function CardHead({ title, sub, right, id }: { title: string; sub?: ReactNode; right?: ReactNode; id?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2 px-4 pt-4 sm:px-5">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {sub && <p className="min-w-0 text-sm text-muted-foreground">{sub}</p>}
      {right && <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

/** A two-option (or more) segmented control: muted track, white selected pill — the tab list's look. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-md bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded px-2.5 py-1 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === o.value ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The dashed empty state the app already uses (MetacognitionPanel, CR3's tabs). */
export function EmptyState({ icon: Icon, title, children, testId }: { icon: LucideIcon; title: string; children?: ReactNode; testId?: string }) {
  return (
    <div className="rounded-lg border border-dashed px-5 py-8 text-center" data-testid={testId}>
      <Icon className="mx-auto mb-2 h-6 w-6 text-muted-foreground" aria-hidden />
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

/** A key/value list for the trace drawer. */
export function KV({ rows }: { rows: Array<[string, ReactNode] | null | false> }) {
  const shown = rows.filter((r): r is [string, ReactNode] => !!r);
  return (
    <dl className="mt-2 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 sm:grid-cols-[minmax(5.5rem,8rem)_minmax(0,1fr)] sm:gap-x-4 gap-y-1.5 text-sm">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-sm text-muted-foreground", className)}>{children}</span>;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[13px]", className)}>{children}</span>;
}

/** Loading line: quiet, no spinner animation. */
export function Loading({ what }: { what: string }) {
  return (
    <p className="py-6 text-center text-sm text-muted-foreground" role="status">
      Loading {what}…
    </p>
  );
}

export function ErrorLine({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
      {text}
    </p>
  );
}
