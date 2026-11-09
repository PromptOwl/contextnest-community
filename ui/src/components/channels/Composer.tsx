/**
 * The message box, used for a new post and for a thread reply alike, so the
 * two cannot drift: the same `MentionTextarea` as document comments (markdown
 * toolbar, `@` for people and agents), Enter adds a line as it does there, and
 * the button sends. When the reader may not post, the server's one-line
 * reason stands in its place instead of nothing.
 */
import { useRef, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentHandle, ChannelSummary } from "../../lib/api";
import type { MentionMember } from "../MarkdownEditor/picker-match";
import { MentionTextarea } from "../MentionTextarea";

/** Why the reader can't post here (archived channel, archived nest, not a member). */
export function PostRefusal({ channel }: { channel: Pick<ChannelSummary, "post_refusal"> }) {
  return (
    <p
      className="flex items-start gap-2 rounded-md border border-dashed bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
      data-testid="channel-post-refusal"
    >
      <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{channel.post_refusal || "You can read this channel but not post in it."}</span>
    </p>
  );
}

export function Composer({
  value,
  onChange,
  onSend,
  people,
  agents,
  placeholder,
  sendLabel,
  ariaLabel,
  autoFocus,
  onCancel,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Resolves when the message is posted; a rejection puts the text back. */
  onSend: (body: string) => Promise<void>;
  people: MentionMember[];
  agents: AgentHandle[];
  placeholder: string;
  sendLabel: string;
  ariaLabel: string;
  autoFocus?: boolean;
  onCancel?: () => void;
}) {
  const [sending, setSending] = useState(false);
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
    <div>
      <MentionTextarea
        formatting
        members={people}
        agents={agents}
        value={value}
        onValueChange={onChange}
        placeholder={placeholder}
        aria-label={ariaLabel}
        rows={2}
        autoFocus={autoFocus}
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm"
      />
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
        <p className="hidden text-xs text-muted-foreground sm:block">Markdown works. Type @ to mention a person or an agent.</p>
        <div className="ml-auto flex gap-2">
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={sending}>
              Cancel
            </Button>
          )}
          <Button size="sm" onClick={() => void send()} disabled={sending || !value.trim()}>
            {sending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {sendLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
