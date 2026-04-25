/**
 * ConnectModal — shows copy-paste snippets for connecting clients to a nest.
 * Hootie, Claude Desktop (MCP), and the ctx CLI.
 */
import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Copy, Check, ExternalLink, Terminal, Monitor, Bot } from "lucide-react";

interface ConnectModalProps {
  isOpen: boolean;
  onClose: () => void;
  nestId: string;
  nestName: string;
}

export function ConnectModal({ isOpen, onClose, nestId, nestName }: ConnectModalProps) {
  const serverUrl =
    typeof window !== "undefined" ? window.location.origin : "http://localhost:3838";
  const mcpUrl = `${serverUrl}/nests/${nestId}/mcp`;

  const claudeConfig = JSON.stringify(
    {
      mcpServers: {
        [slugify(nestName)]: {
          url: mcpUrl,
        },
      },
    },
    null,
    2,
  );

  const ctxCommand = `ctx --server ${serverUrl} --nest ${nestId} query "type:document"`;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[640px] max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Connect to {nestName}</DialogTitle>
          <DialogDescription>
            Point your tools at this nest to read, write, and query context.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          <Tabs defaultValue="hootie" className="w-full">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="hootie">
                <Bot className="h-3.5 w-3.5 mr-1" />
                Hootie
              </TabsTrigger>
              <TabsTrigger value="claude">
                <Monitor className="h-3.5 w-3.5 mr-1" />
                Claude
              </TabsTrigger>
              <TabsTrigger value="mcp">MCP</TabsTrigger>
              <TabsTrigger value="cli">
                <Terminal className="h-3.5 w-3.5 mr-1" />
                CLI
              </TabsTrigger>
            </TabsList>

            {/* Hootie */}
            <TabsContent value="hootie" className="space-y-4 pt-4">
              <div>
                <p className="text-sm mb-3">
                  In Hootie, open <strong>Settings → ContextNest Vault → Remote Server</strong> and paste:
                </p>
                <Snippet label="Server URL" value={serverUrl} />
                <Snippet label="API Key" value="(leave blank — open mode)" dim />
              </div>
              <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                <li>Open Hootie</li>
                <li>Click the gear icon (Settings)</li>
                <li>Scroll to ContextNest Vault</li>
                <li>Switch tab to "Remote Server"</li>
                <li>Paste the URL above, click Test Vault</li>
              </ol>
            </TabsContent>

            {/* Claude Desktop */}
            <TabsContent value="claude" className="space-y-4 pt-4">
              <div>
                <p className="text-sm mb-3">
                  Add this to your <code className="text-xs bg-muted px-1 py-0.5 rounded">claude_desktop_config.json</code>:
                </p>
                <Snippet label="Config" value={claudeConfig} multiline />
                <p className="text-xs text-muted-foreground mt-2">
                  Location: <code className="text-[10px]">%APPDATA%\Claude\claude_desktop_config.json</code> (Windows) or <code className="text-[10px]">~/Library/Application Support/Claude/claude_desktop_config.json</code> (Mac)
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Restart Claude Desktop after editing. The nest's 16 context tools will appear in the tools panel.
              </p>
            </TabsContent>

            {/* Raw MCP */}
            <TabsContent value="mcp" className="space-y-4 pt-4">
              <div>
                <p className="text-sm mb-3">
                  This nest exposes a Streamable HTTP MCP endpoint with 16 tools (9 content + 7 governance):
                </p>
                <Snippet label="MCP Endpoint" value={mcpUrl} />
              </div>
              <div className="text-xs text-muted-foreground space-y-2">
                <p className="font-medium">Available tools:</p>
                <div className="grid grid-cols-2 gap-x-4 font-mono text-[11px]">
                  <span>context_init</span>
                  <span>context_stewards</span>
                  <span>context_overview</span>
                  <span>context_review_queue</span>
                  <span>context_search</span>
                  <span>context_submit_review</span>
                  <span>context_query</span>
                  <span>context_approve</span>
                  <span>context_get</span>
                  <span>context_reject</span>
                  <span>context_list</span>
                  <span>context_versions</span>
                  <span>context_resolve</span>
                  <span>context_assign_steward</span>
                  <span>context_create</span>
                  <span>context_update</span>
                </div>
              </div>
            </TabsContent>

            {/* CLI */}
            <TabsContent value="cli" className="space-y-4 pt-4">
              <div>
                <p className="text-sm mb-3">
                  Use <code className="text-xs bg-muted px-1 py-0.5 rounded">ctx</code> pointed at this server:
                </p>
                <Snippet label="Example query" value={ctxCommand} />
              </div>
              <div className="text-xs text-muted-foreground space-y-2">
                <p className="font-medium">Common commands:</p>
                <div className="space-y-1 font-mono text-[11px]">
                  <div>ctx --server {serverUrl} --nest {nestId} query "#architecture"</div>
                  <div>ctx --server {serverUrl} --nest {nestId} add "My Doc" content.md</div>
                  <div>ctx --server {serverUrl} --nest {nestId} publish</div>
                </div>
                <p className="pt-2">
                  Install:{" "}
                  <code className="text-[11px] bg-muted px-1 py-0.5 rounded">
                    npm i -g @promptowl/contextnest-cli
                  </code>
                </p>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <div className="border-t pt-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Nest ID:</span>
            <code className="flex-1 bg-muted px-2 py-1 rounded text-[11px] font-mono truncate">
              {nestId}
            </code>
            <CopyButton value={nestId} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Snippet({
  label,
  value,
  multiline,
  dim,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  dim?: boolean;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <CopyButton value={value} />
      </div>
      <pre
        className={`${
          multiline ? "p-3" : "px-3 py-2"
        } bg-muted rounded text-xs font-mono ${
          multiline ? "whitespace-pre overflow-x-auto" : "truncate"
        } ${dim ? "text-muted-foreground italic" : ""}`}
      >
        {value}
      </pre>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <Button variant="ghost" size="sm" className="h-6 px-2" onClick={copy}>
      {copied ? (
        <Check className="h-3 w-3 text-green-600" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </Button>
  );
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "nest";
}
