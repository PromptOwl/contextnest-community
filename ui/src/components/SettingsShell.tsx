/**
 * The left nav that frames every "Workspace settings" page (Teams, API keys,
 * Connected apps, Teammates, Server settings, Activity trace, Message log).
 * These pages used to be scattered across the sidebar in two groups; they are
 * one place now, opened from the account menu. The nav lists only the pages
 * this person may open (the registry already gates them), and stacks above
 * the page on a phone.
 */
import type { ReactNode } from "react";
import type { AppPage } from "../lib/pages";
import { cn } from "@/lib/utils";

export function SettingsShell({
  pages,
  active,
  onOpen,
  children,
}: {
  pages: AppPage[];
  active: string;
  onOpen: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-x-8 gap-y-4" data-testid="settings-shell">
      <nav
        aria-label="Workspace settings"
        className="w-full shrink-0 space-y-0.5 md:w-52"
        data-testid="settings-nav"
      >
        <div className="px-2.5 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Workspace settings
        </div>
        {pages.map((page) => {
          const Icon = page.icon;
          const isActive = page.id === active;
          return (
            <button
              key={page.id}
              type="button"
              onClick={() => onOpen(page.id)}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted",
                isActive
                  ? "bg-muted font-medium text-foreground"
                  : "text-foreground/80 hover:text-foreground",
              )}
              data-testid={`settings-nav-${page.id}`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{page.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="min-w-0 flex-1 basis-[28rem]">{children}</div>
    </div>
  );
}
