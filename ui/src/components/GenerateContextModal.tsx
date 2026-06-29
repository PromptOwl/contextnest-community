/**
 * GenerateContextModal — a copy-paste recipe for generating context with an
 * agent (Claude, Codex, the app) and pushing it into THIS nest over the HTTP
 * API. Discoverability: most people don't realize the nest is writable by an
 * agent, so this spells out the endpoint + a ready-to-paste prompt.
 */
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Sparkles, Copy, Check, Key } from "lucide-react";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  nestId: string;
  nestName: string;
  /** Show the "open mode — no key needed" note instead of the auth header. */
  openMode?: boolean;
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border bg-muted/40">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => {
            navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 mr-1" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3 mr-1" /> Copy
            </>
          )}
        </Button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words">
        {text}
      </pre>
    </div>
  );
}

export function GenerateContextModal({ isOpen, onClose, nestId, nestName, openMode }: Props) {
  const serverUrl =
    typeof window !== "undefined" ? window.location.origin : "https://your-server";

  const authLine = openMode
    ? ""
    : '  -H "Authorization: Bearer $CNST_KEY" \\\n';

  const prompt = `You can write to my ContextNest knowledge base ("nest") over HTTP.
Generate well-structured context on the topic below, then create ONE node per
document by POSTing to the nest API. Keep each node tight (100–300 words).

Base URL: ${serverUrl}
Nest ID:  ${nestId}

Create a node:
  POST ${serverUrl}/nests/${nestId}/nodes
  Content-Type: application/json${openMode ? "" : "\n  Authorization: Bearer <MY_API_KEY>   # mint one via Connect; omit if the server is in open mode"}
  Body: {
    "title":   "<short title>",
    "content": "<markdown body>",   // or raw HTML for an artifact
    "type":    "document",          // use "artifact" for self-contained HTML (decks, dashboards)
    "tags":    ["<tag>", "<tag>"]
  }

After creating each node, report its id from the response.

Topic to generate / add: <DESCRIBE WHAT YOU WANT HERE>`;

  const curl = `curl -X POST ${serverUrl}/nests/${nestId}/nodes \\
${authLine}  -H "Content-Type: application/json" \\
  -d '{"title":"My note","content":"# Hello\\n\\nSome context…","type":"document","tags":["demo"]}'`;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[640px] max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            Generate &amp; add context to {nestName}
          </DialogTitle>
          <DialogDescription>
            Have Claude, Codex, or any agent generate context and push it
            straight into this nest via the API — no copy-pasting documents by
            hand.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto pr-1">
          <div>
            <div className="text-sm font-medium mb-1">
              1. Paste this into Claude / Codex
            </div>
            <p className="text-xs text-muted-foreground mb-2">
              Replace the last line with what you want, then let the agent
              generate and POST each node.
            </p>
            <CopyBlock label="Prompt for your agent" text={prompt} />
          </div>

          <div>
            <div className="text-sm font-medium mb-1">2. Or call the API directly</div>
            <CopyBlock label="curl" text={curl} />
          </div>

          {!openMode && (
            <div className="flex items-start gap-2 rounded-md border bg-card p-3 text-xs text-muted-foreground">
              <Key className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                Writes need an API key (<code>Bearer cnst_*</code>). Mint one in{" "}
                <strong>Connect</strong> — it's shown once; set it as{" "}
                <code>$CNST_KEY</code> for the snippets above.
              </span>
            </div>
          )}
          {openMode && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-3 text-xs text-amber-900 dark:text-amber-200">
              <Key className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                Server is in <strong>open</strong> mode — no API key needed;
                anyone on the network can write. Lock it down before exposing it.
              </span>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
