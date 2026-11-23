/**
 * Finding chat (PO-1200, AC-C3-21): one read of `GET /me/chat/unread` serves
 * every entry into chat — the Chat row under each nest in the rail, the
 * rail's own Chat row, the top bar's Chat button and the nest cards — as both
 * the gate (a nest is listed exactly when chat is on there and I am a member)
 * and the badge. Polled once a minute while the tab is visible, shared by
 * every caller through the query cache; nothing moves on a timer.
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useAuth } from "../../auth/AuthContext";
import { chatBadge } from "../../lib/chat-harness";
import { reads } from "../../lib/queries";

export function useChatSummary() {
  const { agentStreamEnabled, authenticated, authMode } = useAuth();
  return useQuery({
    ...reads.chatUnread(),
    enabled: agentStreamEnabled && (authenticated || authMode === "open"),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/** Mentions in the primary pill (they wait on me); plain unread quieter. */
export function ChatCount({ counts, className }: { counts: { unread: number; mentions: number } | null | undefined; className?: string }) {
  const b = chatBadge(counts);
  if (!b) return null;
  const label = b.count > 99 ? "99+" : String(b.count);
  return (
    <span
      className={cn(
        "min-w-5 shrink-0 rounded-full px-1.5 text-center text-[11px] font-semibold leading-5 tabular-nums",
        b.tone === "mention" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
        className,
      )}
      aria-label={b.tone === "mention" ? `${b.count} ${b.count === 1 ? "mention" : "mentions"}` : `${b.count} unread`}
      data-testid="chat-count"
    >
      {label}
    </span>
  );
}
