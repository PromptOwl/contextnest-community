/**
 * One channel message: who wrote it (an agent names the person it acts for),
 * when, and the body rendered as markdown with the same renderer as document
 * comments (`CommentBody`). Mentions take the message's own `mentions` list,
 * so a person reads by display name, an agent handle as an agent, and a name
 * that matched nobody as unresolved.
 */
import { memo, type ReactNode } from "react";
import { Bot } from "lucide-react";
import type { ChannelMessage } from "../../lib/api";
import { authorOf } from "../../lib/channels";
import { formatServerDate, relTime } from "../../lib/dates";
import { ArtifactCards } from "../ArtifactCards";
import { initialsOf } from "../AuthorshipChips";
import { CommentBody } from "../MentionTextarea";

const NO_MEMBERS: never[] = [];
/** A heading inside a message is emphasis in a conversation, not a page
 *  title: it never outranks the channel's own name. */
const BODY =
  "text-sm [&_h1]:mb-1 [&_h1]:mt-3 [&_h1]:text-base [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-base [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-sm [&_h4]:text-sm";

/** The rendered markdown, memoized on the message's own fields: the page
 *  re-renders on every refresh to keep "2m ago" moving, and re-parsing every
 *  body each time would be the cost of that. */
const MessageBody = memo(function MessageBody({ body, mentions }: Pick<ChannelMessage, "body" | "mentions">) {
  return <CommentBody body={body} members={NO_MEMBERS} mentions={mentions ?? NO_MEMBERS} className={BODY} />;
});

export function MessageView({
  message,
  compact,
  children,
}: {
  message: ChannelMessage;
  /** A reply inside a thread: a smaller avatar. */
  compact?: boolean;
  /** Markers and actions under the body. */
  children?: ReactNode;
}) {
  const who = authorOf(message);
  return (
    <div className="flex gap-3">
      <span
        aria-hidden
        className={`flex shrink-0 select-none items-center justify-center rounded-md bg-muted font-medium text-muted-foreground ${
          compact ? "h-6 w-6 text-[10px]" : "h-8 w-8 text-xs"
        }`}
      >
        {who.agent ? <Bot className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} /> : initialsOf(who.name)}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm leading-6">
          <span className="font-medium text-foreground" title={who.agent ? undefined : message.author}>
            {who.name}
          </span>
          {who.onBehalfOf && (
            <span className="text-xs text-muted-foreground" title={message.author}>
              agent, on behalf of {who.onBehalfOf}
            </span>
          )}
          <time
            className="text-xs text-muted-foreground"
            dateTime={message.created_at}
            title={formatServerDate(message.created_at) || message.created_at}
          >
            {relTime(message.created_at) || message.created_at}
          </time>
        </div>
        <MessageBody body={message.body} mentions={message.mentions} />
        <ArtifactCards cards={message.cards} />
        {children}
      </div>
    </div>
  );
}
