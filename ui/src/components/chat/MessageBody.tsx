/**
 * The parts every message shares (PO-1200): who wrote it, as an avatar
 * (initials for a person, the bot mark for an agent) and the body rendered
 * with the same markdown renderer as document comments (`CommentBody`).
 * Mentions take the message's own `mentions` list, so a person reads by
 * display name, an agent handle as an agent, and a name that matched nobody
 * as unresolved. A `[[wikilink]]` into this nest opens in the app.
 */
import { memo, useCallback } from "react";
import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChannelMessage } from "../../lib/api";
import { authorOf } from "../../lib/channels";
import type { MessageWikilink } from "../../lib/message-wikilinks";
import { initialsOf } from "../AuthorshipChips";
import { CommentBody } from "../MentionTextarea";
import { useChannelNav } from "./channel-nav";

const NO_MEMBERS: never[] = [];
/** A heading inside a message is emphasis in a conversation, not a page
 *  title: it never outranks the channel's own name. */
const BODY =
  "text-sm leading-5 [overflow-wrap:anywhere] [&_h1]:mb-1 [&_h1]:mt-2 [&_h1]:text-base [&_h2]:mb-1 [&_h2]:mt-2 [&_h2]:text-base [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-sm [&_h4]:text-sm [&_p]:my-0 [&_p+p]:mt-2 [&_pre]:my-2 [&_ul]:my-1 [&_ol]:my-1";

/** The rendered markdown, memoized on the message's own fields: the page
 *  re-renders on every refresh to keep "2m ago" moving, and re-parsing every
 *  body each time would be the cost of that. */
export const MessageBody = memo(function MessageBody({ body, mentions, cards, className }: Pick<ChannelMessage, "body" | "mentions" | "cards"> & { className?: string }) {
  const nav = useChannelNav();
  const nestId = nav?.nestId;
  const openNode = nav?.openNode;
  // A wikilink into this nest opens in the app; one into another nest loads its address.
  const onOpenLink = useCallback(
    (link: MessageWikilink) => {
      if (!openNode || !link.nodeId || (link.nestId && link.nestId !== nestId)) return false;
      openNode(link.nodeId);
      return true;
    },
    [nestId, openNode],
  );
  return (
    <CommentBody
      body={body}
      members={NO_MEMBERS}
      mentions={mentions ?? NO_MEMBERS}
      cards={cards ?? NO_MEMBERS}
      nestId={nestId}
      onOpenLink={onOpenLink}
      className={cn(BODY, className)}
    />
  );
});

export function Avatar({ message, size = "md" }: { message: Pick<ChannelMessage, "actor" | "author" | "author_name">; size?: "md" | "sm" }) {
  const who = authorOf(message);
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-md bg-muted font-medium text-muted-foreground",
        size === "sm" ? "h-7 w-7 text-[10px]" : "h-8 w-8 text-xs",
      )}
    >
      {who.agent ? <Bot className={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} /> : initialsOf(who.name)}
    </span>
  );
}
