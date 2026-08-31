/**
 * OverflowMenu — reusable "⋮" actions dropdown.
 * Pass a list of actions (with optional separators / destructive styling);
 * use anywhere a header or row needs to collapse secondary actions.
 */
import * as React from "react";
import { MoreVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface OverflowAction {
  label: string;
  onSelect: () => void;
  icon?: React.ComponentType<{ className?: string }>;
  /** Extra classes on the icon — e.g. "animate-spin" for an in-flight action. */
  iconClassName?: string;
  /** Render a separator above this item. */
  separatorBefore?: boolean;
  /** Red destructive styling (e.g. Delete). */
  destructive?: boolean;
  disabled?: boolean;
  testId?: string;
}

interface OverflowMenuProps {
  actions: OverflowAction[];
  align?: "start" | "center" | "end";
  /** Trigger button variant; defaults to "ghost". */
  variant?: React.ComponentProps<typeof Button>["variant"];
  className?: string;
  triggerTitle?: string;
  testId?: string;
}

export function OverflowMenu({
  actions,
  align = "end",
  variant = "ghost",
  className,
  triggerTitle = "More actions",
  testId,
}: OverflowMenuProps) {
  if (actions.length === 0) return null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant={variant}
          size="icon"
          className={className}
          title={triggerTitle}
          data-testid={testId}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-44">
        {actions.map((a, i) => {
          const Icon = a.icon;
          return (
            <React.Fragment key={a.testId ?? a.label ?? i}>
              {a.separatorBefore && i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem
                onSelect={a.onSelect}
                disabled={a.disabled}
                data-testid={a.testId}
                className={a.destructive ? "text-destructive focus:text-destructive" : undefined}
              >
                {Icon && (
                  <Icon className={`h-4 w-4 mr-2 ${a.iconClassName ?? ""}`} />
                )}
                {a.label}
              </DropdownMenuItem>
            </React.Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
