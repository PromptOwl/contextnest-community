import { useState } from "react";
import { Globe2, Copy, MessageSquareText, Lock, KeyRound } from "lucide-react";
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
import { useAuth } from "../auth/AuthContext";

const serverUrl =
  typeof window !== "undefined"
    ? window.location.origin
    : "http://localhost:3838";

/**
 * The "whole brain" strip that sits above the individual nests: it frames the
 * user's many nests as one thing an AI can read through a single connection.
 *
 * Deliberately does not touch keys. A key is one credential per place you
 * connect from, which is a thing to manage in one place — so this dialog
 * points at the API keys page instead of minting, revealing, or rotating
 * anything here.
 */
export function AllNestsBar({
  nests,
  onManageKeys,
}: {
  nests: NestCountRow[];
  onManageKeys?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { authenticated, authMode } = useAuth();
  // AUTH_MODE=open servers need no credential at all — mirror ConnectModal
  // and drop key talk from both the panel and the prompt.
  const openMode = authMode === "open";
  const showKeySection = authenticated && !openMode;

  const { nestCount, documentCount } = nestSummary(nests);
  const mcp = serverMcpUrl(serverUrl);
  const prompt = allNestsChatPrompt(serverUrl, openMode);

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
                <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <p className="flex items-start gap-2 text-xs text-muted-foreground">
                    <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Paste in the key you already use — any of your keys works
                      here and on every nest. Need a new one?
                    </span>
                  </p>
                  {onManageKeys && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => {
                        setOpen(false);
                        onManageKeys();
                      }}
                    >
                      Manage API keys
                    </Button>
                  )}
                </div>
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
                Search and list across all nests at once, or target a specific
                nest. Create, update, delete, move, and submit for review — just
                name the nest. Approval and sharing stay in each nest's Connect
                panel.
              </span>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
