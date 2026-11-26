/**
 * The header ribbon (see lib/header-ribbon). My Work and My Drafts count what
 * is waiting across every nest, so they are visible from inside any one of
 * them. Instructions follows the nest you have open.
 *
 * The header row is shared with the breadcrumb, Docs and the account
 * menu. My Work and My Drafts are the two people look for, so they are spelled
 * out once the bar (not the window) is wide enough: bar-md in ui/tailwind.config.js. Below that an item is its icon plus its
 * count, with the name in its tooltip.
 */
import { useQuery } from "@tanstack/react-query";
import { Inbox, Pencil, type LucideIcon } from "lucide-react";
import { reads } from "@/lib/queries";
import { urgentOnMeCount, waitingOnMeCount } from "@/lib/my-work-groups";
import {
  ribbonItems,
  type RibbonItem,
  type RibbonKey,
  type RibbonView,
} from "@/lib/header-ribbon";

const ICONS: Record<RibbonKey, LucideIcon> = {
  "my-work": Inbox,
  "my-drafts": Pencil,
};


export function HeaderRibbon({
  view,
  nestName,
  onGo,
}: {
  view: RibbonView;
  /** The open nest's name, for the tooltip of its items. */
  nestName?: string;
  onGo: (key: RibbonKey) => void;
}) {
  // The same reads as the sidebar's badges, so these are one cached fetch each.
  const { data: work } = useQuery(reads.myWork({ limit: 1 }));
  const { data: drafts } = useQuery(reads.myDrafts({ limit: 1 }));
  const nestId = view.nestId;
  const { data: nestMeta } = useQuery({ ...reads.nest(nestId ?? ""), enabled: !!nestId });

  const items = ribbonItems({
    view,
    counts: {
      work: waitingOnMeCount(work),
      drafts: drafts?.pagination?.total ?? 0,
      urgent: urgentOnMeCount(work),
    },
    grantOnly: !!(nestMeta as { grant_only?: boolean } | undefined)?.grant_only,
  });
  if (items.length === 0) return null;

  const tip = (item: RibbonItem) =>
    item.urgent ? `${item.label} — ${item.count} waiting, ${item.urgent} urgent` : item.label;

  return (
    <nav
      aria-label="Workspace"
      className="hidden shrink-0 items-center gap-0.5 md:flex"
      data-testid="header-ribbon"
    >
      {items.map((item) => {
        const Icon = ICONS[item.key];
        return (
          <div key={item.key} className="flex items-center">
            {(
            <button
              type="button"
              onClick={() => onGo(item.key)}
              title={tip(item)}
              aria-label={tip(item)}
              aria-current={item.active ? "page" : undefined}
              data-testid={`header-ribbon-${item.key}`}
              className={`flex h-9 items-center gap-1.5 rounded-md px-2 text-sm transition-colors lg:px-2.5 ${
                item.active
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              <span
                className="hidden whitespace-nowrap bar-md:inline"
              >
                {item.label}
              </span>
              {!!item.count && (
                <span
                  className={`min-w-[1.25rem] rounded-full px-1.5 text-center text-[11px] font-semibold leading-5 ${
                    item.urgent
                      ? "bg-red-600 text-white"
                      : item.key === "my-work"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground"
                  }`}
                  data-urgent={item.urgent ? "true" : undefined}
                >
                  {item.count > 99 ? "99+" : item.count}
                  {!!item.urgent && <span className="sr-only"> ({item.urgent} urgent)</span>}
                </span>
              )}
            </button>
            )}
          </div>
        );
      })}
    </nav>
  );
}
