/**
 * HarnessStep — "Connect a harness" (PO-1411), after a nest is created: where
 * this nest's agents run. Local is today's Connect flow (the caller renders
 * it: the welcome screen's tiles, or a button that opens the Connect dialog).
 * Central lite and Central durable describe themselves and link the docs
 * until their deploy bundle is published.
 */
import type { ReactNode } from "react";
import { ExternalLink, Laptop, Server, ServerCog, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { CENTRAL_HARNESS_DOCS, CENTRAL_PLACEHOLDER, HARNESS_CHOICES, type HarnessKind } from "../../lib/recipes";

const ICONS: Record<HarnessKind, LucideIcon> = { local: Laptop, "central-lite": Server, "central-durable": ServerCog };

interface Props {
  value: HarnessKind;
  onChange: (id: HarnessKind) => void;
  /** What Local shows: the connect tiles, or the button that opens Connect. */
  local: ReactNode;
}

export function HarnessStep({ value, onChange, local }: Props) {
  const chosen = HARNESS_CHOICES.find((h) => h.id === value) ?? HARNESS_CHOICES[0];
  return (
    <div className="space-y-3" data-testid="harness-step">
      <div role="radiogroup" aria-label="Harness" className="grid gap-2 sm:grid-cols-3">
        {HARNESS_CHOICES.map((h) => {
          const Icon = ICONS[h.id];
          const on = h.id === value;
          return (
            <button
              key={h.id}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`harness-${h.id}`}
              onClick={() => onChange(h.id)}
              className={cn(
                "flex min-w-0 flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on && "border-primary bg-muted/40",
              )}
            >
              <span className="flex w-full items-center gap-2">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate text-sm font-medium">{h.name}</span>
                {!h.available && (
                  <Badge variant="secondary" className="ml-auto shrink-0 px-1.5 py-0 text-[10px] font-medium">
                    Soon
                  </Badge>
                )}
              </span>
              <span className="text-xs leading-snug text-muted-foreground">{h.summary}</span>
            </button>
          );
        })}
      </div>

      <div className="space-y-3 rounded-lg border px-4 py-3" data-testid={`harness-panel-${chosen.id}`}>
        <p className="text-sm text-muted-foreground">{chosen.detail}</p>
        <div className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">You need: </span>
          {chosen.needs.join(" · ")}
        </div>
        {chosen.available ? (
          local
        ) : (
          <div className="space-y-2 rounded-md bg-muted/40 px-3 py-2.5 text-sm">
            <p className="text-muted-foreground">{CENTRAL_PLACEHOLDER}</p>
            <a
              className="inline-flex items-center gap-1 text-sm font-medium underline-offset-2 hover:underline"
              href={CENTRAL_HARNESS_DOCS}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="harness-docs"
            >
              How the central harness works <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
