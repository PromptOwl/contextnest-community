/**
 * Promote a thread to a decision or task node: pick the kind, check the
 * title (prefilled from the post's first line), add an optional summary that
 * goes above the quoted thread. Nothing is created until Promote is pressed.
 */
import { useEffect, useState } from "react";
import { AlertCircle, Lightbulb, ListChecks, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ChannelPost } from "../../lib/api";
import { promoteTitle } from "../../lib/channels";

type Kind = "decision" | "task";

const KINDS: Array<{ kind: Kind; label: string; hint: string; Icon: typeof Lightbulb }> = [
  { kind: "decision", label: "Decision", hint: "Something the team agreed on", Icon: Lightbulb },
  { kind: "task", label: "Task", hint: "Something to be done", Icon: ListChecks },
];

export function PromoteDialog({
  post,
  onClose,
  onPromote,
}: {
  /** The post to promote; null closes the dialog. */
  post: ChannelPost | null;
  onClose: () => void;
  /** Rejects with the server's message (title taken, not a writer). */
  onPromote: (post: ChannelPost, input: { kind: Kind; title: string; summary: string }) => Promise<void>;
}) {
  const [kind, setKind] = useState<Kind>("decision");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const postId = post?.id;
  useEffect(() => {
    if (!post) return;
    setKind("decision");
    setTitle(promoteTitle(post.body));
    setSummary("");
    setError(null);
    // Only when another post is opened, not on every refresh of the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId]);

  const submit = async () => {
    if (!post || busy || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onPromote(post, { kind, title: title.trim(), summary: summary.trim() });
      onClose();
    } catch (e: any) {
      setError(e?.message || "Could not promote the thread");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!post} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="sm:max-w-[480px]" data-testid="promote-dialog">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Promote thread</DialogTitle>
            <DialogDescription>
              Creates a document in this nest that quotes the thread and links back to it. The thread stays where it is.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Kind">
              {KINDS.map(({ kind: k, label, hint, Icon }) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kind === k}
                  onClick={() => setKind(k)}
                  className={cn(
                    "rounded-md border px-3 py-2 text-left transition-colors",
                    kind === k ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/60",
                  )}
                  data-testid={`promote-kind-${k}`}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <Icon className="h-4 w-4 text-muted-foreground" aria-hidden /> {label}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
                </button>
              ))}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="promote-title">Title</Label>
              <Input
                id="promote-title"
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                autoComplete="off"
                data-testid="promote-title"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="promote-summary">Summary (optional)</Label>
              <Input
                id="promote-summary"
                value={summary}
                maxLength={1000}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="One line, placed above the quoted thread"
                autoComplete="off"
                data-testid="promote-summary"
              />
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !title.trim()} data-testid="promote-confirm">
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Promote to {kind}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
