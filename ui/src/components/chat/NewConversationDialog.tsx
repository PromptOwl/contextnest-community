/**
 * "New message" (PO-1200, AC-C3-15): pick one person or agent for a direct
 * message, or several for a group. The server finds the conversation with
 * exactly these members if there is one, so starting the same set twice
 * opens the one that exists.
 */
import { useState } from "react";
import { AlertCircle, Loader2, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AgentHandle } from "../../lib/api";
import { memberSpec } from "../../lib/chat-harness";
import type { MentionMember } from "../MarkdownEditor/picker-match";
import { PeoplePicker, pickKey, pickLabel, type Candidate } from "./Presence";

export function NewConversationDialog({
  open,
  onOpenChange,
  people,
  agents,
  me,
  onStart,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  people: MentionMember[];
  agents: AgentHandle[];
  me: string | null;
  /** Rejects with the server's message. */
  onStart: (members: string[]) => Promise<void>;
}) {
  const [picked, setPicked] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (next: boolean) => {
    if (busy) return;
    if (!next) {
      setPicked([]);
      setError(null);
    }
    onOpenChange(next);
  };
  const toggle = (c: Candidate) =>
    setPicked((cur) => (cur.some((x) => pickKey(x) === pickKey(c)) ? cur.filter((x) => pickKey(x) !== pickKey(c)) : [...cur, c]));

  const start = async () => {
    if (!picked.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onStart(picked.map(memberSpec));
      setPicked([]);
      onOpenChange(false);
    } catch (e) {
      setError((e as Error | undefined)?.message || "Could not start the conversation");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-[460px]" data-testid="new-conversation">
        <DialogHeader>
          <DialogTitle>New message</DialogTitle>
          <DialogDescription>Pick one person or agent for a direct message, or several for a group. Only the people in it can read it.</DialogDescription>
        </DialogHeader>
        {picked.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="To">
            {picked.map((c) => (
              <li key={pickKey(c)} className="flex h-7 items-center gap-1 rounded-md border bg-muted/40 pl-2 pr-1 text-sm">
                <span className="max-w-[12rem] truncate">{pickLabel(c)}</span>
                <button type="button" onClick={() => toggle(c)} aria-label={`Remove ${pickLabel(c)}`} className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <PeoplePicker people={people} agents={agents} me={me} picked={picked} onToggle={toggle} autoFocus testId="new-conversation-picker" />
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void start()} disabled={busy || picked.length === 0} data-testid="new-conversation-start">
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            {picked.length > 1 ? "Start group" : "Start conversation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
