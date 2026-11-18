/**
 * The message box (PO-1200, AC-C3-06), Slack's shape: one bordered box with
 * the markdown toolbar on its top edge, the text, and a send button at the
 * bottom right. The same `MentionTextarea` as document comments in its chat
 * mode: Enter sends, Shift+Enter adds a line, `@` opens the picker (people,
 * then agents), arrow keys move inside the picker only. On a touch device
 * Enter adds a line and the button sends. No attachment button: the API has
 * none. When the reader may not post, the server's one-line reason stands in
 * the box's place.
 */
import { useRef, useState } from "react";
import { ArrowUp, Loader2, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentHandle, ChannelSummary } from "../../lib/api";
import { COARSE_POINTER } from "../../lib/composer-keys";
import { useMediaQuery } from "../../lib/use-media-query";
import type { MentionMember } from "../MarkdownEditor/picker-match";
import { MentionTextarea } from "../MentionTextarea";

/** The picker's last rows in a channel: everyone at once (C1, PO-1196).
 *  `@here` reaches the same people as `@channel` until presence lands (C2). */
export const MENTION_EXTRAS = [
  { name: "channel", detail: "Everyone on this nest" },
  { name: "here", detail: "Everyone, for now" },
];

/** Why the reader can't post here (archived channel, archived nest, not a member). */
export function PostRefusal({ channel, className }: { channel: Pick<ChannelSummary, "post_refusal">; className?: string }) {
  return (
    <p className={cn("flex items-start gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground", className)} data-testid="chat-post-refusal">
      <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{channel.post_refusal || "You can read this channel but not post in it."}</span>
    </p>
  );
}

export function ChatComposer({
  value,
  onChange,
  onSend,
  people,
  agents,
  extras,
  placeholder,
  ariaLabel,
  autoFocus,
  compact,
  status,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Resolves when the message is posted; a rejection puts the text back. */
  onSend: (body: string) => Promise<void>;
  people: MentionMember[];
  agents: AgentHandle[];
  /** `@channel` and `@here` (C1), offered last in the picker. */
  extras?: Array<{ name: string; detail: string }>;
  placeholder: string;
  ariaLabel: string;
  autoFocus?: boolean;
  /** The thread's reply box and the slide-over: one line to start with. */
  compact?: boolean;
  /** A live line ("Walt is typing…") in the hint's place while there is one. */
  status?: string | null;
  className?: string;
}) {
  const [sending, setSending] = useState(false);
  const touch = useMediaQuery(COARSE_POINTER);
  const latest = useRef(value);
  latest.current = value;
  const send = async () => {
    const body = value.trim();
    if (!body || sending) return;
    setSending(true);
    // The box empties at once and stays usable, as in any chat.
    onChange("");
    try {
      await onSend(body);
    } catch {
      // The caller reports the failure; the text goes back in the box, ahead
      // of anything typed meanwhile.
      onChange(latest.current ? `${body}\n${latest.current}` : body);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className={cn("group/composer", className)} data-testid="chat-composer">
      <div className="relative rounded-lg border border-input bg-background shadow-sm transition-colors focus-within:border-ring [&_[role=toolbar]]:mb-0 [&_[role=toolbar]]:border-b [&_[role=toolbar]]:border-border/70 [&_[role=toolbar]]:px-1.5 [&_[role=toolbar]]:py-0.5">
        <MentionTextarea
          formatting
          members={people}
          agents={agents}
          extras={extras}
          value={value}
          onValueChange={onChange}
          placeholder={placeholder}
          aria-label={ariaLabel}
          rows={compact ? 1 : 2}
          autoFocus={autoFocus}
          onEnterSend={() => void send()}
          className="block w-full resize-none border-0 bg-transparent px-3 py-2 pr-12 text-sm leading-5 outline-none placeholder:text-muted-foreground focus:ring-0"
          style={{ minHeight: compact ? 36 : 56, maxHeight: 240, fieldSizing: "content" } as React.CSSProperties}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || !value.trim()}
          aria-label="Send"
          title={touch ? "Send" : "Send (Enter)"}
          data-testid="chat-send"
          className="absolute bottom-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground"
        >
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <ArrowUp className="h-3.5 w-3.5" aria-hidden />}
        </button>
      </div>
      {status ? (
        <p className="mt-1.5 truncate px-1 text-xs text-muted-foreground" role="status" aria-live="polite" data-testid="chat-typing">
          {status}
        </p>
      ) : !compact && (
        <p className="mt-1.5 px-1 text-xs text-muted-foreground" data-testid="composer-hint">
          {touch ? (
            <>Enter adds a line. Tap the arrow to send.</>
          ) : (
            <>
              <kbd className="font-sans font-medium">Enter</kbd> to send, <kbd className="font-sans font-medium">Shift+Enter</kbd> for a new line. Type @ to
              mention a person or an agent.
            </>
          )}
        </p>
      )}
    </div>
  );
}
