/**
 * ConnectModal — copy-paste snippets for connecting external clients
 * (Hootie, Claude Desktop, raw MCP) to a nest.
 *
 * Key-secrecy model: this dialog shows no key at all — not the plaintext,
 * not the prefix. Every snippet carries a placeholder the user substitutes
 * after copying, so snippets are reusable templates that leak no secret.
 *
 * Creating and rotating keys lives on the API keys page (`onManageKeys`),
 * not here. Per-nest rotation was a trap: an account holds several keys,
 * one per place it connects from, and a rotate fired from whichever nest
 * happened to be open would kill clients wired to the others. Plaintext is
 * still revealed exactly once, by KeyRevealModal (exported below, rendered
 * by that page); the server stores only sha256, so a lost key can only be
 * replaced, never recovered.
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Copy,
  Check,
  Monitor,
  Bot,
  AlertCircle,
  Key,
  Loader2,
  ShieldAlert,
  Download,
  Sparkles,
  Package,
  MessageSquareText,
  ChevronDown,
  Terminal,
} from "lucide-react";
import * as api from "../lib/api";
import { copyTextWithToast } from "../lib/clipboard";
import {
  nestChatPrompt,
  nestSetupPrompt,
  envFileContents,
  ctxCliConnectSnippet,
} from "../lib/connect";
import { useAuth } from "../auth/AuthContext";

interface ConnectModalProps {
  isOpen: boolean;
  onClose: () => void;
  nestId: string;
  nestName: string;
  /** Opens the API keys page. Keys are created and rotated there, never from
   *  inside a nest — a rotate started here used to kill every other client. */
  onManageKeys?: () => void;
}

const KEY_PLACEHOLDER = "<paste-your-api-key-here>";

export function ConnectModal({
  isOpen,
  onClose,
  nestId,
  nestName,
  onManageKeys,
}: ConnectModalProps) {
  const { authenticated, authMode } = useAuth();
  const serverUrl =
    typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:3838";
  const mcpUrl = `${serverUrl}/nests/${nestId}/mcp`;
  const exportUrl = `${serverUrl}/nests/${nestId}/export?format=markdown`;

  const [downloading, setDownloading] = useState(false);
  const [downloadingBundle, setDownloadingBundle] = useState(false);
  const [bundleOpen, setBundleOpen] = useState(false);
  const [includeDrafts, setIncludeDrafts] = useState(false);
  // Per-client config is collapsed by default — the quick-start prompts above
  // cover most people; power users expand to configure a specific client.
  const [showClients, setShowClients] = useState(false);
  // Export / portability / nest-id are utilities, not part of connecting —
  // collapsed by default too.
  const [showMore, setShowMore] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // Clear a stale export error when the dialog reopens.
  useEffect(() => {
    if (!isOpen) setError(null);
  }, [isOpen]);

  // Download the whole nest as a single markdown file (approved content only,
  // server-side). Same URL agents fetch — surfaced here as a one-click action.
  const downloadBundle = async () => {
    setError(null);
    setDownloadingBundle(true);
    try {
      await api.exportNestBundle(nestId, { nestName, includeDrafts });
      setBundleOpen(false);
    } catch (err: any) {
      setError(err?.message || "Bundle export failed");
    } finally {
      setDownloadingBundle(false);
    }
  };

  const downloadExport = async () => {
    setError(null);
    setDownloading(true);
    try {
      const md = await api.exportNestMarkdown(nestId);
      const url = URL.createObjectURL(
        new Blob([md], { type: "text/markdown" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `${slugify(nestName)}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err?.message || "Export failed");
    } finally {
      setDownloading(false);
    }
  };

  // Claude Desktop only speaks stdio in claude_desktop_config.json — it has no
  // native http/url/headers transport (that shape is for Claude Code / Cursor,
  // see the MCP tab). Bridge to our Streamable-HTTP endpoint with mcp-remote.
  const claudeConfig = JSON.stringify(
    {
      mcpServers: {
        [slugify(nestName)]: {
          command: "npx",
          // Open mode needs no credential — omit the auth header so the copied
          // config connects as-is.
          args: [
            "-y",
            "mcp-remote",
            mcpUrl,
            ...(authMode === "open"
              ? []
              : ["--header", `Authorization: Bearer ${KEY_PLACEHOLDER}`]),
          ],
        },
      },
    },
    null,
    2,
  );

  // Native HTTP MCP clients (Cursor, VS Code, Claude Code) configure a server
  // by its url + headers in one JSON stanza — same shape as claudeConfig
  // above, so one paste lands both the endpoint and the auth placeholder
  // instead of two separate copies the user has to splice together by hand.
  const mcpHttpConfig = JSON.stringify(
    {
      mcpServers: {
        [slugify(nestName)]: {
          url: mcpUrl,
          ...(authMode === "open"
            ? {}
            : { headers: { Authorization: `Bearer ${KEY_PLACEHOLDER}` } }),
        },
      },
    },
    null,
    2,
  );

  const showOpenModeBanner = authMode === "open";
  const showLoginBanner = !authenticated && authMode === "key";

  const authHeaderFlag = showOpenModeBanner
    ? ""
    : ` \\\n  -H "Authorization: Bearer ${KEY_PLACEHOLDER}"`;
  // Deterministic retrieval: same selector + hops → same context, every time.
  // POST /context assembles matched nodes + their N-hop graph neighborhood
  // into one markdown payload with a trace (hops_used, nodes_traversed).
  const curlContext = `curl -X POST ${serverUrl}/nests/${nestId}/context \\\n  -H "Content-Type: application/json"${authHeaderFlag} \\\n  -d '{"selector": "#gtm", "hops": 2, "max_tokens": 4000}'`;
  const curlNode = `curl "${serverUrl}/nests/${nestId}/nodes/nodes/<slug>?format=markdown"${authHeaderFlag}`;
  // The ctx CLI (2.2+) reads a hosted nest through this same MCP endpoint once
  // it is registered as a vault alias. Key-free: `--bearer-env` names the env
  // var ctx reads the key from, the same one the downloadable .env sets.
  const ctxAliasSnippet = ctxCliConnectSnippet(
    serverUrl,
    nestId,
    nestName,
    showOpenModeBanner,
  );
  // Same rule for push: the key travels in the environment, never on argv.
  const ctxPush = showOpenModeBanner
    ? `ctx push --server ${serverUrl} --nest ${nestId}`
    : `CONTEXTNEST_API_KEY=${KEY_PLACEHOLDER} ctx push --server ${serverUrl} --nest ${nestId}`;

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-[640px] max-h-[85vh] flex flex-col overflow-hidden [&>*]:min-w-0">
          <DialogHeader>
            <DialogTitle>Connect to {nestName}</DialogTitle>
            <DialogDescription>
              Use this nest in the app you already have. New to this? Start on
              the Hootie tab — it's the quickest way in.
            </DialogDescription>
          </DialogHeader>

          {/* Everything below the header scrolls as one region on short
              viewports. Previously only the Tabs content scrolled while the
              banners/key panel above it and the Export/Bundle/Nest ID
              sections below it sat outside the scroll area, so a short
              window squeezed the tab content into a sliver (or nothing). */}
          <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-0 space-y-4">
          {/* Primary path: paste one of these into your AI agent/harness — it
              self-installs, connects, and asks you for the key. Per-client
              config is the fallback (collapsed below). */}
          <div className="rounded-lg border-2 border-primary/30 bg-primary/5 p-3.5">
            <p className="text-sm font-semibold">
              Now paste into your AI agent or harness
            </p>
            <p className="mb-3 mt-0.5 text-xs text-muted-foreground">
              Drop one of these into Claude, Cursor, Hootie, or any agent. It
              self-installs, connects, and asks you for your API key — one
              paste, all-purpose.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={() =>
                  copyTextWithToast(
                    nestChatPrompt(nestName),
                    "Chat prompt copied",
                  )
                }
              >
                <MessageSquareText className="mr-1.5 h-3.5 w-3.5" />
                Chat with this nest
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  copyTextWithToast(
                    nestSetupPrompt(nestName, serverUrl, nestId, showOpenModeBanner),
                    "Setup prompt copied",
                  )
                }
              >
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                Set up an agent
              </Button>
            </div>
          </div>
          {showLoginBanner && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                You're not logged in. Login from the header to generate an API
                key for external clients.
              </span>
            </div>
          )}

          {showOpenModeBanner && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                Server is in <strong>open</strong> mode — anyone on the network
                can read/write without a key. The snippets below omit the
                Authorization header.
              </span>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-900">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Keys are managed in one place, not per nest. This panel points
              there rather than minting or rotating inline — a rotate started
              from whichever nest happened to be open is how people silently
              disconnected every other client they'd wired up. */}
          {authenticated && !showOpenModeBanner && (
            <div className="rounded-md border bg-card p-3 space-y-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2 text-sm min-w-0">
                  <Key className="h-3.5 w-3.5 shrink-0" />
                  <span className="font-medium truncate">
                    External-client API key
                  </span>
                </div>
                {onManageKeys && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={onManageKeys}
                  >
                    Manage API keys
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Use the key you already have — any of your keys works on every
                nest you can see. Need a new one, or lost the plaintext? Create
                or rotate it on the API keys page; keys are shown only once,
                when they're created.
              </p>
            </div>
          )}

            <button
              type="button"
              onClick={() => setShowClients((v) => !v)}
              aria-expanded={showClients}
              className="flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-sm hover:bg-muted/40"
            >
              <span className="font-medium">Configure a specific client</span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Hootie · Claude · Cursor · CLI
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${showClients ? "rotate-180" : ""}`}
                />
              </span>
            </button>
            {showClients && (
            <Tabs defaultValue="hootie" className="w-full min-w-0">
              <TabsList className="grid w-full grid-cols-5 sticky top-0 z-10">
                <TabsTrigger value="hootie">
                  <Bot className="h-3.5 w-3.5 mr-1" />
                  Hootie
                </TabsTrigger>
                <TabsTrigger value="claude">
                  <Monitor className="h-3.5 w-3.5 mr-1" />
                  Claude
                </TabsTrigger>
                <TabsTrigger value="mcp">MCP</TabsTrigger>
                <TabsTrigger value="api">API</TabsTrigger>
                <TabsTrigger value="cli">
                  <Terminal className="h-3.5 w-3.5 mr-1" />
                  CLI
                </TabsTrigger>
              </TabsList>

              {/* Hootie */}
              <TabsContent value="hootie" className="space-y-4 pt-4">
                <div>
                  <p className="text-sm mb-3">
                    In Hootie, open{" "}
                    <strong>
                      Settings → ContextNest Vault → Remote Server
                    </strong>{" "}
                    and paste:
                  </p>
                  <Snippet label="Server URL" value={serverUrl} />
                  {!showOpenModeBanner && (
                    <Snippet
                      label="API Key (paste your generated key)"
                      value={KEY_PLACEHOLDER}
                    />
                  )}
                </div>
                <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                  <li>Open Hootie</li>
                  <li>Click the gear icon (Settings)</li>
                  <li>Scroll to ContextNest Vault</li>
                  <li>Switch tab to "Remote Server"</li>
                  <li>
                    Paste the URL{!showOpenModeBanner && " + your API Key"}{" "}
                    above, click Test Vault
                  </li>
                </ol>
              </TabsContent>

              {/* Claude Desktop */}
              <TabsContent value="claude" className="space-y-4 pt-4">
                <div>
                  <p className="text-sm mb-3">
                    Add this to your{" "}
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">
                      claude_desktop_config.json
                    </code>
                    {!showOpenModeBanner && (
                      <>
                        {" "}
                        (replace{" "}
                        <code className="text-[11px] bg-muted px-1 rounded">
                          {KEY_PLACEHOLDER}
                        </code>{" "}
                        with your generated key):
                      </>
                    )}
                  </p>
                  <Snippet label="Config" value={claudeConfig} multiline />
                  <p className="text-xs text-muted-foreground mt-2">
                    Location:{" "}
                    <code className="text-[10px]">
                      %APPDATA%\Claude\claude_desktop_config.json
                    </code>{" "}
                    (Windows) or{" "}
                    <code className="text-[10px]">
                      ~/Library/Application
                      Support/Claude/claude_desktop_config.json
                    </code>{" "}
                    (Mac)
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  Claude Desktop config runs a local command, so this uses{" "}
                  <code className="text-[10px]">mcp-remote</code> to bridge to the
                  server's HTTP endpoint — you need{" "}
                  <a
                    href="https://nodejs.org"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    Node.js
                  </a>{" "}
                  installed (it provides <code className="text-[10px]">npx</code>).
                  Restart Claude Desktop after editing; the nest's context tools
                  then appear in the tools panel.
                </p>
              </TabsContent>

              {/* Raw MCP */}
              <TabsContent value="mcp" className="space-y-4 pt-4">
                <div>
                  <p className="text-sm mb-3">
                    Streamable HTTP MCP endpoint with 21 tools (11 content + 7
                    governance + 3 admin/sync). Works with native HTTP MCP
                    clients (Claude Code, Cursor, VS Code); for Claude Desktop
                    use the Claude Desktop tab.
                    {!showOpenModeBanner && (
                      <>
                        {" "}
                        Replace{" "}
                        <code className="text-[11px] bg-muted px-1 rounded">
                          {KEY_PLACEHOLDER}
                        </code>{" "}
                        with your generated key.
                      </>
                    )}
                  </p>
                  <Snippet label="MCP config" value={mcpHttpConfig} multiline />
                  <Snippet
                    label={`From the ctx CLI (2.2+)${showOpenModeBanner ? "" : " — export CONTEXTNEST_API_KEY first"}`}
                    value={ctxAliasSnippet}
                    multiline
                  />
                </div>
                <div className="text-xs text-muted-foreground space-y-2">
                  <p className="font-medium">Available tools:</p>
                  <div className="grid grid-cols-2 gap-x-4 font-mono text-[11px]">
                    {/* content (11) */}
                    <span>context_init</span>
                    <span>context_resolve</span>
                    <span>context_overview</span>
                    <span>context_create</span>
                    <span>context_search</span>
                    <span>context_update</span>
                    <span>context_query</span>
                    <span>context_export</span>
                    <span>context_get</span>
                    <span>context_comments</span>
                    <span>context_list</span>
                    {/* governance (11) */}
                    <span>context_stewards</span>
                    <span>context_review_queue</span>
                    <span>context_my_drafts</span>
                    <span>context_submit_review</span>
                    <span>context_approve</span>
                    <span>context_reject</span>
                    <span>context_versions</span>
                    <span>context_assign_steward</span>
                    <span>context_request_deletion</span>
                    <span>context_deletion_queue</span>
                    <span>context_resolve_deletion</span>
                    {/* admin / sync (3) */}
                    <span>context_share_nest</span>
                    <span>context_unsynced_list</span>
                    <span>context_sync_folder</span>
                  </div>
                </div>
              </TabsContent>

              {/* Direct REST API — deterministic retrieval */}
              <TabsContent value="api" className="space-y-4 pt-4">
                <div>
                  <p className="text-sm mb-3">
                    Deterministic retrieval over plain HTTP — the same selector
                    and <code className="text-[11px] bg-muted px-1 rounded">hops</code>{" "}
                    always assemble the same context. One call returns the
                    matched nodes plus their graph neighborhood as ready-to-use
                    markdown, with a trace (
                    <code className="text-[11px]">hops_used</code>,{" "}
                    <code className="text-[11px]">nodes_traversed</code>) so you
                    can audit exactly what was pulled.
                  </p>
                  <Snippet
                    label="Query + N-hop graph context (POST /context)"
                    value={curlContext}
                    multiline
                  />
                  <Snippet
                    label="Single document (GET, deterministic by id)"
                    value={curlNode}
                    multiline
                  />
                </div>
                <div className="text-xs text-muted-foreground space-y-2">
                  <p className="font-medium">Selector grammar:</p>
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
                    <span>#tag</span>
                    <span className="font-sans">nodes carrying a tag</span>
                    <span>type:document</span>
                    <span className="font-sans">nodes of a type</span>
                    <span>[[Title]]</span>
                    <span className="font-sans">a node by title</span>
                    <span>scope:team</span>
                    <span className="font-sans">nodes by visibility scope</span>
                    <span>+AND · |OR · -NOT</span>
                    <span className="font-sans">combine selectors</span>
                  </div>
                  <p className="pt-1">
                    <span className="font-medium">Hops</span> controls graph
                    traversal from the matches:{" "}
                    <code className="text-[11px]">1</code> = matches + directly
                    linked nodes (single hop),{" "}
                    <code className="text-[11px]">2</code> (default) and up
                    follow wiki-links further out for multi-hop context.{" "}
                    <code className="text-[11px]">max_tokens</code> caps the
                    payload; the response reports what was truncated.
                  </p>
                  <p>
                    Also useful:{" "}
                    <code className="text-[11px] bg-muted px-1 rounded">
                      POST /query
                    </code>{" "}
                    (matches + snippets, no bodies),{" "}
                    <code className="text-[11px] bg-muted px-1 rounded">
                      GET /overview
                    </code>{" "}
                    (types/tags map), and the export URL below for the whole
                    nest. All under{" "}
                    <code className="text-[11px] bg-muted px-1 rounded">
                      /nests/{"<nest-id>"}/…
                    </code>
                  </p>
                </div>
              </TabsContent>

              {/* CLI — intentionally minimal: the canonical ctx surface lives
                  upstream in ContextNest, so we show the one remote command +
                  a pointer, not a full (drift-prone) copy of the CLI docs. */}
              <TabsContent value="cli" className="space-y-4 pt-4">
                <div>
                  <p className="text-sm mb-3">
                    Read this nest from the shell, or push a local vault into
                    it, with the{" "}
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">
                      ctx
                    </code>{" "}
                    CLI
                    {!showOpenModeBanner && (
                      <>
                        {" "}
                        (export{" "}
                        <code className="text-[11px] bg-muted px-1 rounded">
                          CONTEXTNEST_API_KEY
                        </code>{" "}
                        first — the key never goes on the command line)
                      </>
                    )}
                    :
                  </p>
                  <Snippet
                    label="Install"
                    value="npm i -g @promptowl/contextnest-cli"
                  />
                  <Snippet
                    label="Register this nest as a vault alias, then query it"
                    value={ctxAliasSnippet}
                    multiline
                  />
                  <Snippet label="Push a local vault into this nest" value={ctxPush} multiline />
                </div>
                <p className="text-xs text-muted-foreground">
                  <code className="text-[10px]">query</code>,{" "}
                  <code className="text-[10px]">read</code>,{" "}
                  <code className="text-[10px]">list</code> and{" "}
                  <code className="text-[10px]">search</code> accept{" "}
                  <code className="text-[10px]">--vault &lt;alias&gt;</code>{" "}
                  once the alias exists (ctx 2.2+). Full CLI reference lives in
                  the ContextNest docs.
                </p>
              </TabsContent>

            </Tabs>
            )}
            {showClients && (
              <div className="border-t pt-3">
                <p className="mb-2 text-sm font-medium">Get the apps</p>
                <div className="grid gap-2 sm:grid-cols-3">
                  <a
                    href="https://promptowl.ai/download"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm hover:border-primary hover:bg-muted/40"
                  >
                    <Monitor className="h-4 w-4 shrink-0" /> Desktop app
                  </a>
                  <a
                    href="https://www.npmjs.com/package/@promptowl/contextnest-cli"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm hover:border-primary hover:bg-muted/40"
                  >
                    <Terminal className="h-4 w-4 shrink-0" /> ctx CLI
                  </a>
                  <a
                    href="https://github.com/PromptOwl/ContextNest"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm hover:border-primary hover:bg-muted/40"
                  >
                    <Package className="h-4 w-4 shrink-0" /> Self-hosted
                  </a>
                </div>
              </div>
            )}

          <button
            type="button"
            onClick={() => setShowMore((v) => !v)}
            aria-expanded={showMore}
            className="flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-sm hover:bg-muted/40"
          >
            <span className="font-medium">Export &amp; nest details</span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              Markdown · .zip · Nest ID
              <ChevronDown
                className={`h-4 w-4 transition-transform ${showMore ? "rotate-180" : ""}`}
              />
            </span>
          </button>
          {showMore && (
          <>
          {/* Export — markdown egress. The URL is what agents fetch; the
              button downloads it as a file. Approved content only (server-side). */}
          <div className="border-t pt-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm min-w-0">
                <Download className="h-3.5 w-3.5 shrink-0" />
                <span className="font-medium truncate">Export as markdown</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={downloadExport}
                disabled={downloading}
                aria-label="Download this nest as a single markdown file"
              >
                {downloading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    <Download className="h-3.5 w-3.5 mr-1" />
                    Download .md
                  </>
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Frontmatter + body, one file. Approved versions only. Agents can
              fetch this URL directly.
            </p>
            <Snippet label="Export URL (text/markdown)" value={exportUrl} />
          </div>

          {/* Portability bundle — full-fidelity .zip (content + version history
              + structural governance) to move this nest to another host. */}
          <div className="border-t pt-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm min-w-0">
                <Package className="h-3.5 w-3.5 shrink-0" />
                <span className="font-medium truncate">Portability bundle</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setBundleOpen(true)}
                aria-label="Export this nest as a portable .zip bundle"
              >
                <Package className="h-3.5 w-3.5 mr-1" />
                Export .zip
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Whole nest — nodes, full version history, tags, definitions and
              edges — as one .zip. Import it on another ContextNest host to
              recreate the nest.
            </p>
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
          </>
          )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={bundleOpen} onOpenChange={(o) => !downloadingBundle && setBundleOpen(o)}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="h-5 w-5" />
              Export portability bundle
            </DialogTitle>
            <DialogDescription>
              Downloads a <code>.zip</code> of this nest's documents. On another
              ContextNest host, unzip it and bring it in with the existing{" "}
              <strong>Import Folder</strong> button.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-start justify-between gap-3 py-2">
            <div className="space-y-0.5">
              <Label htmlFor="include-drafts" className="text-sm font-medium">
                Include draft documents
              </Label>
              <p className="text-xs text-muted-foreground">
                Off: approved / published documents only. On: also export
                unapproved drafts.
              </p>
            </div>
            <Switch
              id="include-drafts"
              checked={includeDrafts}
              onCheckedChange={setIncludeDrafts}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button variant="outline" onClick={() => setBundleOpen(false)} disabled={downloadingBundle}>
              Cancel
            </Button>
            <Button onClick={downloadBundle} disabled={downloadingBundle}>
              {downloadingBundle ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Download className="h-4 w-4 mr-2" />
              )}
              Download .zip
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Standalone modal that surfaces a freshly minted / rotated plaintext
 * key. The plaintext is a prop and lives only for this modal's lifetime
 * — closing the modal drops it from state in the parent.
 *
 * Copy is intentionally not lockout-limited: the value is already in
 * the user's clipboard after one click, and forcing them to rotate
 * just to retry copying is hostile. The real guarantee is that once
 * this modal closes the plaintext is gone (server only ever stored
 * sha256).
 */
export function KeyRevealModal({
  apiKey,
  kind,
  onClose,
  nestId,
}: {
  apiKey: string;
  kind: "generated" | "rotated";
  onClose: () => void;
  nestId?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyTextWithToast(apiKey))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const downloadEnv = () => {
    const serverUrl =
      typeof window !== "undefined"
        ? window.location.origin
        : "http://localhost:3838";
    const url = URL.createObjectURL(
      new Blob([envFileContents({ serverUrl, apiKey, nestId })], {
        type: "text/plain",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "contextnest.env";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-700" />
            {kind === "generated" ? "API key generated" : "API key rotated"}
          </DialogTitle>
          <DialogDescription>
            This key is shown <strong>only once</strong>. Copy it now and store
            it somewhere safe (password manager, secrets vault). It cannot be
            retrieved again — if you lose it, rotate to mint a new one.
            {kind === "rotated" && (
              <>
                {" "}
                Your previous key has been invalidated and will stop working
                immediately.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-muted px-3 py-2 rounded text-xs font-mono break-all">
              {apiKey}
            </code>
            <Button size="sm" variant="outline" onClick={copy}>
              {copied ? (
                <Check className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={downloadEnv}
          >
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Download .env
          </Button>
          <p className="text-xs text-muted-foreground">
            Copy it, or download a ready{" "}
            <code className="text-[11px]">.env</code> (server URL + key) to hand
            your agent. Keep it secret — don't commit it.
          </p>
        </div>

        <div className="flex justify-end pt-2">
          <Button onClick={onClose}>I've saved it — close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Snippet({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  return (
    <div className="mb-3 min-w-0">
      <div className="flex items-center justify-between gap-2 mb-1 min-w-0">
        <span className="text-xs font-medium text-muted-foreground truncate">
          {label}
        </span>
        <CopyButton value={value} />
      </div>
      <pre
        className={`${
          multiline ? "p-3" : "px-3 py-2"
        } bg-muted rounded text-xs font-mono min-w-0 ${
          multiline
            ? "whitespace-pre overflow-x-auto"
            : "whitespace-pre-wrap break-all"
        }`}
      >
        {value}
      </pre>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyTextWithToast(value))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
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
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "nest"
  );
}
