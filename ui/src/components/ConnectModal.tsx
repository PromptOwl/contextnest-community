/**
 * ConnectModal — copy-paste snippets for connecting external clients
 * (Hootie, Claude Desktop, ctx CLI, raw MCP) to a nest.
 *
 * Key-secrecy model: this dialog NEVER renders the plaintext api_key in
 * its snippets — every snippet shows a placeholder that the user must
 * substitute manually after copying. The plaintext is shown exactly
 * once, in the separate KeyRevealModal that pops up after Generate /
 * Rotate. Once that modal closes the plaintext is dropped from React
 * state forever (server stores only sha256, so neither side can recover
 * it later — only Rotate to mint a fresh one).
 *
 * Snippets are therefore reusable copy templates — copy them as often
 * as you like; they leak no secret.
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Copy,
  Check,
  Terminal,
  Monitor,
  Bot,
  AlertCircle,
  CheckCircle2,
  Key,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Download,
  Sparkles,
} from "lucide-react";
import * as api from "../lib/api";
import { copyTextWithToast } from "../lib/clipboard";
import { useAuth } from "../auth/AuthContext";

interface ConnectModalProps {
  isOpen: boolean;
  onClose: () => void;
  nestId: string;
  nestName: string;
  /** Opens the Add-with-AI (generate) flow — Connect is the front door for
   *  every way content gets in or out, including the AI one. */
  onGenerate?: () => void;
}

const KEY_PLACEHOLDER = "<paste-your-api-key-here>";

export function ConnectModal({
  isOpen,
  onClose,
  nestId,
  nestName,
  onGenerate,
}: ConnectModalProps) {
  const { authenticated, authMode } = useAuth();
  const serverUrl =
    typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:3838";
  const mcpUrl = `${serverUrl}/nests/${nestId}/mcp`;
  const exportUrl = `${serverUrl}/nests/${nestId}/export?format=markdown`;

  const [downloading, setDownloading] = useState(false);

  const [hasExistingKey, setHasExistingKey] = useState<boolean | null>(null);
  const [existingPrefix, setExistingPrefix] = useState<string | null>(null);

  // Plaintext lives ONLY inside the reveal popup. Closing the popup
  // wipes it. Snippets in this dialog never see the real value.
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [revealKind, setRevealKind] = useState<"generated" | "rotated" | null>(
    null,
  );

  const [busy, setBusy] = useState<"loading" | "mint" | "rotate" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Transient confirmation surfaced after a successful Generate/Rotate.
  // Auto-clears so the panel reverts to its neutral resting state instead
  // of leaving a stale "click Rotate" prompt visible after the user has
  // already rotated.
  const [justActed, setJustActed] = useState<"generated" | "rotated" | null>(
    null,
  );

  // Probe key state when dialog opens / reopens.
  useEffect(() => {
    if (!isOpen) {
      setError(null);
      setJustActed(null);
      return;
    }
    if (!authenticated || authMode === "open") {
      setHasExistingKey(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setBusy("loading");
      try {
        const { keys } = await api.listApiKeys();
        if (cancelled) return;
        const head = keys[0];
        setHasExistingKey(!!head);
        setExistingPrefix(head?.key_prefix ?? null);
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message);
          setHasExistingKey(false);
        }
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, authenticated, authMode]);

  const generateKey = async () => {
    setError(null);
    setBusy("mint");
    try {
      const { api_key, key_prefix } = await api.createApiKey({
        nest_id: nestId,
        label: `connect:${slugify(nestName)}`,
      });
      setExistingPrefix(key_prefix);
      setHasExistingKey(true);
      setRevealKind("generated");
      setRevealedKey(api_key);
      setJustActed("generated");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const rotateKey = async () => {
    setError(null);
    setBusy("rotate");
    try {
      const { api_key, key_prefix } = await api.rotateApiKey({
        nest_id: nestId,
        label: `connect:${slugify(nestName)}`,
      });
      setExistingPrefix(key_prefix);
      setHasExistingKey(true);
      setRevealKind("rotated");
      setRevealedKey(api_key);
      setJustActed("rotated");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  // Auto-clear the transient confirmation. Keeps the panel honest: once
  // enough time has passed for the user to absorb the success state, we
  // fall back to neutral copy so a later glance doesn't misread it as a
  // fresh, unacknowledged action.
  useEffect(() => {
    if (!justActed) return;
    const t = setTimeout(() => setJustActed(null), 6000);
    return () => clearTimeout(t);
  }, [justActed]);

  // Download the whole nest as a single markdown file (approved content only,
  // server-side). Same URL agents fetch — surfaced here as a one-click action.
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

  const closeReveal = () => {
    // Drop plaintext from memory. Once gone, only Rotate can mint a new
    // one — the old one stays valid server-side until then.
    setRevealedKey(null);
    setRevealKind(null);
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

  // Only `ctx push` talks to a remote server; the other ctx commands operate on
  // a local vault. Push uploads the local vault into this nest.
  // Open mode needs no credential — drop --key so the copied command runs as-is.
  const ctxCommand =
    authMode === "open"
      ? `ctx push --server ${serverUrl} --nest ${nestId}`
      : `ctx push --server ${serverUrl} --nest ${nestId} --key ${KEY_PLACEHOLDER}`;

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

  return (
    <>
      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent className="sm:max-w-[640px] max-h-[85vh] flex flex-col overflow-hidden [&>*]:min-w-0">
          <DialogHeader>
            <DialogTitle>Connect to {nestName}</DialogTitle>
            <DialogDescription>
              Point your tools at this nest to read, write, and query context.
            </DialogDescription>
          </DialogHeader>

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

          {authenticated && !showOpenModeBanner && (
            <div className="rounded-md border bg-card p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm min-w-0">
                  <Key className="h-3.5 w-3.5 shrink-0" />
                  <span className="font-medium truncate">External-client API key</span>
                </div>
                {hasExistingKey ? (
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={rotateKey}
                          disabled={busy !== null}
                          aria-label="Rotate API key — invalidates the current key and mints a fresh one"
                        >
                          {busy === "rotate" ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <>
                              <RefreshCw className="h-3.5 w-3.5 mr-1" />
                              Rotate
                            </>
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="max-w-[260px]">
                        <p className="text-xs">
                          Mints a fresh API key and immediately invalidates the
                          current one. Use only if the existing key is lost or
                          compromised — external clients will need the new
                          value to keep working.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <Button
                    size="sm"
                    onClick={generateKey}
                    disabled={busy !== null}
                  >
                    {busy === "mint" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      "Generate Key"
                    )}
                  </Button>
                )}
              </div>

              {hasExistingKey && justActed && (
                <p className="flex items-start gap-1.5 text-xs text-green-700">
                  <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>
                    {justActed === "rotated" ? "Key rotated" : "Key generated"} ·
                    new prefix{" "}
                    <code className="font-mono">{existingPrefix}</code>
                    {justActed === "rotated" && " · previous key revoked"}.
                  </span>
                </p>
              )}
              {hasExistingKey && !justActed && (
                <p className="text-xs text-muted-foreground">
                  Active key prefix:{" "}
                  <code className="font-mono">{existingPrefix}</code>.
                </p>
              )}
              {!hasExistingKey && (
                <p className="text-xs text-muted-foreground">
                  No key yet. Generate one to use the snippets below. You'll
                  see the plaintext exactly once.
                </p>
              )}
            </div>
          )}

          <div className="flex-1 overflow-y-auto overflow-x-hidden min-w-0">
            {onGenerate && (
              <button
                type="button"
                onClick={onGenerate}
                className="w-full mb-3 flex items-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm hover:border-primary hover:bg-muted/40 text-left"
                data-testid="connect-add-with-ai"
              >
                <Sparkles className="h-4 w-4 text-violet-500 shrink-0" />
                <span>
                  <span className="font-medium">Add with AI</span>
                  <span className="text-muted-foreground">
                    {" "}— point an agent at a repo/topic and push generated
                    context into this nest
                  </span>
                </span>
              </button>
            )}
            <Tabs defaultValue="hootie" className="w-full min-w-0">
              <TabsList className="grid w-full grid-cols-5">
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
                        Pass your API key in an{" "}
                        <code className="text-[11px] bg-muted px-1 rounded">
                          Authorization
                        </code>{" "}
                        header.
                      </>
                    )}
                  </p>
                  <Snippet label="MCP Endpoint" value={mcpUrl} />
                  {!showOpenModeBanner && (
                    <Snippet
                      label="Authorization header"
                      value={`Bearer ${KEY_PLACEHOLDER}`}
                    />
                  )}
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
                    {/* governance (7) */}
                    <span>context_stewards</span>
                    <span>context_review_queue</span>
                    <span>context_submit_review</span>
                    <span>context_approve</span>
                    <span>context_reject</span>
                    <span>context_versions</span>
                    <span>context_assign_steward</span>
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

              {/* CLI */}
              <TabsContent value="cli" className="space-y-4 pt-4">
                <div>
                  <p className="text-sm mb-3">
                    Push a local{" "}
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">
                      ctx
                    </code>{" "}
                    vault into this nest:
                  </p>
                  <Snippet label="Push to this nest" value={ctxCommand} />
                </div>
                <div className="text-xs text-muted-foreground space-y-2">
                  <p>
                    Add{" "}
                    <code className="text-[11px] bg-muted px-1 rounded">
                      --include-drafts
                    </code>{" "}
                    to also push unpublished nodes.
                  </p>
                  <p>
                    <span className="font-medium">Note:</span> only{" "}
                    <code className="text-[11px] bg-muted px-1 rounded">
                      ctx push
                    </code>{" "}
                    talks to a remote server. Other ctx commands (
                    <code className="text-[11px]">query</code>,{" "}
                    <code className="text-[11px]">add</code>,{" "}
                    <code className="text-[11px]">search</code>) operate on your
                    local vault — to read this nest remotely use the MCP endpoint
                    or the REST API (see the API tab for deterministic{" "}
                    <code className="text-[11px]">curl</code> retrieval).
                  </p>
                  <p className="pt-1">
                    Install:{" "}
                    <code className="text-[11px] bg-muted px-1 py-0.5 rounded">
                      npm i -g @promptowl/contextnest-cli
                    </code>
                  </p>
                </div>
              </TabsContent>
            </Tabs>
          </div>

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

      {revealedKey && revealKind && (
        <KeyRevealModal
          apiKey={revealedKey}
          kind={revealKind}
          onClose={closeReveal}
        />
      )}
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
function KeyRevealModal({
  apiKey,
  kind,
  onClose,
}: {
  apiKey: string;
  kind: "generated" | "rotated";
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyTextWithToast(apiKey))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
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
          <p className="text-xs text-muted-foreground">
            Paste it into Hootie / Claude Desktop / CLI wherever the snippets
            in the Connect dialog show{" "}
            <code className="text-[11px]">{KEY_PLACEHOLDER}</code>.
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
