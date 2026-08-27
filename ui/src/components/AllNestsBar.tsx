import { useState } from "react";
import {
  Globe2,
  Copy,
  MessageSquareText,
  Lock,
  KeyRound,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { copyTextWithToast } from "../lib/clipboard";
import {
  nestSummary,
  serverMcpUrl,
  allNestsChatPrompt,
  type NestCountRow,
} from "../lib/connect";
import * as api from "../lib/api";
import { useApiKeys } from "../lib/queries";
import { KeyRevealModal } from "./ConnectModal";
import { useAuth } from "../auth/AuthContext";

const serverUrl =
  typeof window !== "undefined"
    ? window.location.origin
    : "http://localhost:3838";

/**
 * The "whole brain" strip that sits above the individual nests: it frames the
 * user's many nests as one thing an AI can read through a single connection.
 * The key is user-level (one key works for every nest and here), so the dialog
 * mints it inline via the existing /auth/keys endpoint — no auth-model change,
 * and no more diving into a nest just to get a key.
 */
export function AllNestsBar({ nests }: { nests: NestCountRow[] }) {
  const [open, setOpen] = useState(false);
  const [minting, setMinting] = useState(false);
  const [reveal, setReveal] = useState<{
    apiKey: string;
    kind: "generated" | "rotated";
  } | null>(null);

  const { authenticated, authMode } = useAuth();
  // AUTH_MODE=open servers need no credential — mirror ConnectModal and hide
  // the whole key section (and drop key talk from the prompt) there.
  const openMode = authMode === "open";
  const showKeySection = authenticated && !openMode;

  // Deferred to dialog-open: this component mounts with the dashboard, and an
  // unconditional fetch would hit /auth/keys on every visit.
  const {
    data: keyData,
    isLoading: keysLoading,
    refetch: refetchKeys,
  } = useApiKeys({ enabled: open && showKeySection });
  const existingKey = keyData?.keys?.[0];

  const { nestCount, documentCount } = nestSummary(nests);
  const mcp = serverMcpUrl(serverUrl);
  const prompt = allNestsChatPrompt(serverUrl, openMode);

  async function generate() {
    setMinting(true);
    try {
      const { api_key } = await api.createApiKey({ label: "connect" });
      setReveal({ apiKey: api_key, kind: "generated" });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't generate a key.",
      );
    } finally {
      // Either way the server is the truth: a 409 means a key already exists,
      // so refetching flips this panel to the "Active key" state instead of
      // leaving a dead Generate button.
      void refetchKeys();
      setMinting(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-3 rounded-lg border bg-gradient-to-br from-blue-50 to-indigo-50 p-4 dark:from-slate-900 dark:to-slate-900/40 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Globe2 className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">Your whole brain</h3>
            <p className="text-sm text-muted-foreground">
              {nestCount} {nestCount === 1 ? "nest" : "nests"} ·{" "}
              {documentCount.toLocaleString()}{" "}
              {documentCount === 1 ? "document" : "documents"} — connect an AI to
              all of it at once.
            </p>
          </div>
        </div>
        <Button className="shrink-0" onClick={() => setOpen(true)}>
          <Globe2 className="mr-2 h-4 w-4" />
          Connect all my nests
        </Button>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Connect all my nests</DialogTitle>
            <DialogDescription>
              One connection your AI reads every nest through — it picks the
              right one for each question.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                Server (MCP) endpoint
              </p>
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
                <code className="min-w-0 flex-1 truncate text-xs">{mcp}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Copy endpoint"
                  onClick={() => copyTextWithToast(mcp, "Endpoint copied")}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {showKeySection && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                Your API key
              </p>
              {keysLoading ? (
                <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Checking your key…
                </div>
              ) : existingKey ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border bg-muted/40 p-2.5 text-xs">
                  <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span>
                    Active key{" "}
                    <code className="font-mono">{existingKey.key_prefix}</code>
                  </span>
                  <span className="text-muted-foreground">
                    — works here and in every nest.
                  </span>
                </div>
              ) : (
                <Button size="sm" onClick={generate} disabled={minting}>
                  {minting ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Generate API key
                </Button>
              )}
              <p className="mt-1.5 text-xs text-muted-foreground">
                One key for your whole account — the same key authenticates
                every nest and this connection. You'll see it once; open a
                nest's Connect panel to rotate it.
              </p>
            </div>
            )}

            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                Or paste this into your AI
              </p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-[11px] leading-relaxed">
                {prompt}
              </pre>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => copyTextWithToast(prompt, "Prompt copied")}
              >
                <MessageSquareText className="mr-1.5 h-3.5 w-3.5" />
                Copy "chat with all my nests"
              </Button>
            </div>

            <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-2.5 text-xs text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200">
              <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Reads across every nest you can see. It can also start a new
                nest or add a document when you ask — everything else (editing,
                approving, publishing) stays inside a nest's own Connect panel.
              </span>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {reveal && (
        <KeyRevealModal
          apiKey={reveal.apiKey}
          kind={reveal.kind}
          onClose={() => setReveal(null)}
        />
      )}
    </>
  );
}
