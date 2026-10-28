/**
 * Header bell for My Work: what waits on you, from any page. The rail's My
 * Work entry shows the same count, so the header hides this while the rail is
 * open on a desktop.
 */
import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { meta } from "@/pages/app/my-work/meta";

export function InboxBell({ className = "", onOpen }: { className?: string; onOpen: () => void }) {
  const badge = meta.badge!;
  const { data } = useQuery(badge.options());
  const count = badge.count(data);
  const label = count ? `My Work — ${count} waiting on you` : "My Work";
  return (
    <Button variant="ghost" size="icon" className={`relative h-8 w-8 shrink-0 ${className}`} title={label} aria-label={label} onClick={onOpen}>
      <Bell className="h-4 w-4" />
      {count > 0 && (
        <span className="absolute -right-0.5 -top-0.5 min-w-[1rem] rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Button>
  );
}
