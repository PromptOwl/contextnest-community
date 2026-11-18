/** "New channel": a small form in a dialog, on every width. */
import { useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** What the server accepts: 1-63 lowercase letters, digits and dashes. */
const asChannelName = (typed: string) =>
  typed.toLowerCase().replace(/^#+/, "").replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 63);

export function NewChannelDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rejects with the server's message (name taken, reserved name). */
  onCreate: (name: string, purpose: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (next: boolean) => {
    if (busy) return;
    if (!next) {
      setName("");
      setPurpose("");
      setError(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(name, purpose.trim());
      setName("");
      setPurpose("");
      onOpenChange(false);
    } catch (e: any) {
      setError(e?.message || "Could not create the channel");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-[440px]">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New channel</DialogTitle>
            <DialogDescription>A place for one topic. Everyone added to this nest can read and post in it.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-channel-name">Name</Label>
              <Input
                id="new-channel-name"
                autoFocus
                value={name}
                onChange={(e) => setName(asChannelName(e.target.value))}
                placeholder="launch"
                autoComplete="off"
                data-testid="new-channel-name"
              />
              <p className="text-xs text-muted-foreground">Lowercase letters, digits and dashes.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-channel-purpose">What it's for (optional)</Label>
              <Input
                id="new-channel-purpose"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="Everything about the December launch"
                autoComplete="off"
                data-testid="new-channel-purpose"
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
            <Button type="button" variant="outline" onClick={() => close(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name} data-testid="new-channel-create">
              {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Create channel
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
