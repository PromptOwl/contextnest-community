/**
 * Chat in the header, on every page (One chat 1): the one button for talking.
 * On a page it opens beside the page — the nest's chat when there is one,
 * else Hootie — and in Chat itself it is simply where you are.
 */
import { MessagesSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "../../auth/AuthContext";
import { nestChat } from "../../lib/chat-harness";
import { currentSidePanel, setSidePanel } from "../../lib/side-panel";
import { ChatCount, useChatSummary } from "./ChatEntry";

export function HeaderChat({ nestId, onChatPage, onOpenPage }: { nestId: string | null; onChatPage: boolean; onOpenPage: () => void }) {
  const { hootieEnabled, runnerKeyConfigured, isAdmin, agentStreamEnabled, docStreamEnabled } = useAuth();
  const summary = useChatSummary();
  const hootie = hootieEnabled && (runnerKeyConfigured || isAdmin);
  const chatSomewhere = agentStreamEnabled && (summary.data?.nests.length ?? 0) > 0;
  if (!hootie && !chatSomewhere && !docStreamEnabled) return null;
  const total = (summary.data?.nests ?? []).reduce((t, n) => ({ unread: t.unread + n.unread, mentions: t.mentions + n.mentions }), { unread: 0, mentions: 0 });
  const open = () => {
    if (onChatPage) return onOpenPage();
    // Already open: the button closes it.
    const now = currentSidePanel();
    if (now) return setSidePanel(now, "close");
    // Beside the page: this nest's chat, else Hootie; off a nest, the page.
    if (nestId && nestChat(summary.data, nestId)) return setSidePanel("chat", "open");
    if (nestId && hootie) return setSidePanel("hootie", "open");
    onOpenPage();
  };
  return (
    <button
      type="button"
      onClick={open}
      aria-current={onChatPage ? "page" : undefined}
      aria-label="Chat"
      title="Chat"
      data-testid="header-chat"
      className={cn(
        "flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground lg:px-2.5",
        onChatPage && "bg-accent font-medium text-accent-foreground",
      )}
    >
      <MessagesSquare className="h-4 w-4 shrink-0" aria-hidden />
      <span className="hidden whitespace-nowrap bar-md:inline">Chat</span>
      <ChatCount counts={total} />
    </button>
  );
}
