/**
 * ConnectModal — copy-paste snippets for connecting external clients
 * (Hootie, Claude Desktop, raw MCP) to a nest.
 *
 * Key-secrecy model: this dialog shows no key at all — not the plaintext,
 * not the prefix. Every snippet carries a placeholder the user substitutes
 * after copying, so snippets are reusable templates that leak no secret.
 *
 * The one key this dialog mints is a nest-only key ("Create a key for this
 * nest only"): it reaches this nest and nothing else, pairs with the per-nest
 * MCP URL, and minting it disturbs no other client. Once this nest has one,
 * the dialog shows it with Rotate (that key only) instead of minting another.
 * Revoking and all-nests keys live on the API keys page (`onManageKeys`).
 * Rotating an all-nests key here was a trap: an account holds several keys,
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
import { ReasonDialog } from "./governance";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
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
  RefreshCw,
  Eye,
  Pencil,
} from "lucide-react";
import * as api from "../lib/api";
import { CopyButton } from "@/components/ui/copy-button";
import { useQueryClient } from "@tanstack/react-query";
import { reads, useApiKeys } from "../lib/queries";
import { keyCapability, nestOnlyKeyLabel } from "../lib/api-key-scope";
import {
  nestChatPrompt,
  nestSetupPrompt,
  allNestsChatPrompt,
  envFileContents,
  ctxCliConnectSnippet,
  claudeDesktopConfig,
  claudeCodeCommand,
  mcpHttpConfig,
  slugify,
  KEY_PLACEHOLDER,
  isPrivateHost,
  serverMcpUrl,
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

export function ConnectModal({
  isOpen,
  onClose,
  nestId,
  nestName,
  onManageKeys,
}: ConnectModalProps) {
  const { authenticated, authMode, mcpOauthEnabled } = useAuth();
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
  // With sign-in on, the key panel is for automation only — collapsed.
  const [showKeys, setShowKeys] = useState(false);

  const [error, setError] = useState<string | null>(null);

  // "Create a key for this nest only" — the key names come from the account's
  // key list so the default name never collides (the server refuses duplicates).
  const qc = useQueryClient();
  const canMintKey = authenticated && authMode !== "open";
  const { data: keyData } = useApiKeys({ enabled: isOpen && canMintKey });
  const [mintingNestKey, setMintingNestKey] = useState<string | null>(null);
  const [nestKey, setNestKey] = useState<{
    key: string;
    kind: "generated" | "rotated";
  } | null>(null);
  const [rotateTarget, setRotateTarget] = useState<{ id: string; name: string } | null>(null);
  // Least privilege by default: a key handed to an agent starts read-only.
  const [nestKeyReadOnly, setNestKeyReadOnly] = useState(true);
  // This nest already has a key → show it with Rotate instead of minting another.
  const existingNestKeys = (keyData?.keys ?? []).filter(
    (k) => k.nest_id === nestId,
  );
  const mintNestKey = async (keyId?: string) => {
    setError(null);
    setMintingNestKey(keyId ?? "new");
    try {
      if (keyId) {
        const rotated = await api.rotateApiKey({ key_id: keyId });
        setNestKey({ key: rotated.api_key, kind: "rotated" });
      } else {
        const label = nestOnlyKeyLabel(
          nestName,
          (keyData?.keys ?? []).map((k) => k.label),
        );
        const minted = await api.createApiKey({
          label,
          nest_id: nestId,
          capability: nestKeyReadOnly ? "read" : "write",
        });
        setNestKey({ key: minted.api_key, kind: "generated" });
      }
    } catch (err: any) {
      setError(err?.message || "Couldn't create a key for this nest.");
    } finally {
      qc.invalidateQueries({ queryKey: reads.apiKeys().queryKey });
      setMintingNestKey(null);
    }
  };

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

  const isOpenMode = authMode === "open";
  // People sign in as themselves over OAuth; API keys are for headless agents
  // and CI. OAuth is served on the server-level /mcp only, so the client
  // snippets point there (it reads every nest the person can see, this one
  // included) and carry no Authorization header.
  const signIn = mcpOauthEnabled && !isOpenMode;
  const noKey = isOpenMode || signIn;
  const clientUrl = signIn ? serverMcpUrl(serverUrl) : mcpUrl;
  const clientName = signIn ? "contextnest" : nestName;
  // Config-building logic lives in lib/connect.ts (pure, unit-tested there) —
  // see claudeDesktopConfig / claudeCodeCommand / mcpHttpConfig.
  const claudeConfig = claudeDesktopConfig(clientName, clientUrl, noKey);
  const claudeCodeCmd = claudeCodeCommand(clientName, clientUrl, noKey);
  const mcpConfig = mcpHttpConfig(clientName, clientUrl, noKey);

  const showOpenModeBanner = isOpenMode;
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
              {signIn
                ? "Use this nest in the app you already have — it signs you in as yourself, no key needed."
                : "Use this nest in the app you already have. New to this? Start on the Hootie tab — it's the quickest way in."}
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
              {signIn ? (
                <>
                  Drop one of these into Claude, Cursor, Codex or any agent. It
                  adds <code className="text-[11px]">{serverMcpUrl(serverUrl)}</code>{" "}
                  and your app opens a browser so you sign in as yourself — no
                  key to copy. API keys are for headless agents and CI.
                </>
              ) : (
                <>
                  Drop one of these into Claude, Cursor, Hootie, or any agent. It
                  self-installs, connects, and asks you for your API key — one
                  paste, all-purpose.
                </>
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <CopyButton
                text={nestChatPrompt(nestName)}
                variant="default"
                icon={MessageSquareText}
                label="Chat with this nest"
                toastMessage="Chat prompt copied"
              />
              <CopyButton
                text={
                  signIn
                    ? `${allNestsChatPrompt(serverUrl, false, true)}\n\nStart with the "${nestName}" nest (id ${nestId}).`
                    : nestSetupPrompt(nestName, serverUrl, nestId, showOpenModeBanner)
                }
                variant="default"
                icon={Sparkles}
                label="Set up an agent"
                toastMessage="Setup prompt copied"
              />
            </div>
          </div>
          {showLoginBanner && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                You're not logged in. Log in from the header to connect your
                apps or create an API key for agents and CI.
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
          {authenticated && signIn && (
            <button
              type="button"
              onClick={() => setShowKeys((v) => !v)}
              aria-expanded={showKeys}
              className="flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-sm hover:bg-muted/40"
            >
              <span className="font-medium">API key for headless agents &amp; CI</span>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Not needed for apps you use yourself
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${showKeys ? "rotate-180" : ""}`}
                />
              </span>
            </button>
          )}
          {authenticated && !showOpenModeBanner && (!signIn || showKeys) && (
            <div className="rounded-md border bg-card p-3 space-y-2">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2 text-sm min-w-0">
                  <Key className="h-3.5 w-3.5 shrink-0" />
                  <span className="font-medium truncate">
                    API key for headless agents &amp; CI
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
                {signIn && (
                  <>
                    <strong>Not needed for apps you use yourself</strong> —
                    Claude, Cursor, Codex and Gemini sign you in (see{" "}
                    <em>Configure a specific client</em>). A key is for an agent,
                    pipeline or script that runs without you.{" "}
                  </>
                )}
                Use the key you already have — an all-nests key works here too.
                Handing this nest to an agent or integration that shouldn't see
                anything else? Create a key for this nest only: it works with
                this nest's MCP URL below, and every other nest, your account
                and your API keys answer 403. Revoke keys on the API keys page;
                a key is shown only once, when it's created or rotated.
              </p>
              {existingNestKeys.length > 0 ? (
                existingNestKeys.map((k) => {
                  const can = keyCapability(k);
                  return (
                  <div
                    key={k.id}
                    className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5"
                  >
                    <div className="flex min-w-0 items-center gap-2 text-xs">
                      <span className="truncate font-medium">
                        {k.label || "Untitled key"}
                      </span>
                      <code className="font-mono text-muted-foreground">
                        {k.key_prefix}…
                      </code>
                      {/* Same badge as the API keys page. */}
                      <Badge
                        variant="outline"
                        className="shrink-0 gap-1"
                        title={
                          can.kind === "read"
                            ? "This key can read but not change anything."
                            : "This key can read and write."
                        }
                      >
                        {can.kind === "read" ? (
                          <Eye className="h-3 w-3" />
                        ) : (
                          <Pencil className="h-3 w-3" />
                        )}
                        {can.label}
                      </Badge>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      disabled={mintingNestKey !== null}
                      onClick={() =>
                        setRotateTarget({ id: k.id, name: k.label || "Untitled key" })
                      }
                    >
                      {mintingNestKey === k.id ? (
                        <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      Rotate
                    </Button>
                  </div>
                  );
                })
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    disabled={mintingNestKey !== null || !keyData}
                    onClick={() => mintNestKey()}
                  >
                    {mintingNestKey ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Key className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    Create a key for this nest only
                  </Button>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="nest-key-read-only"
                      checked={nestKeyReadOnly}
                      onCheckedChange={setNestKeyReadOnly}
                    />
                    <Label htmlFor="nest-key-read-only" className="text-xs font-normal">
                      Read-only (can't change anything)
                    </Label>
                  </div>
                </div>
              )}
              <Snippet label="This nest's MCP URL" value={mcpUrl} />
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

              {/* Claude */}
              <TabsContent value="claude" className="space-y-4 pt-4">
                {/* Hosted connector (claude.ai, Claude Desktop/Cowork
                    "Connectors"). Two facts people trip on: it connects from
                    Anthropic's servers, so a VPN-only nest is unreachable; and
                    it can't carry our API key, so it needs OAuth sign-in —
                    which is also what makes it read as each person. */}
                <div className="space-y-2">
                  <p className="text-sm">
                    <strong>Claude connector</strong> (claude.ai, Claude Desktop
                    or Cowork): <em>Settings → Connectors → Add custom
                    connector</em>, and paste this URL.
                  </p>
                  <Snippet label="Connector URL" value={serverMcpUrl(serverUrl)} />
                  {mcpOauthEnabled ? (
                    <p className="text-xs text-muted-foreground">
                      Claude sends you here to sign in, then reads as{" "}
                      <strong>you</strong> — every nest you can see, this one
                      included, with your permissions. No key to paste or
                      share: everyone who adds it signs in as themselves.
                    </p>
                  ) : (
                    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
                      <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      <span>
                        Connectors sign each person in, and that's off on this
                        server. An admin turns it on in{" "}
                        <strong>Server settings → Features → Agent OAuth</strong>.
                        Until then, use Claude Code or the Desktop config below.
                      </span>
                    </div>
                  )}
                  <div
                    className={
                      isPrivateHost(serverUrl)
                        ? "flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"
                        : "flex items-start gap-2 text-xs text-muted-foreground"
                    }
                  >
                    <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>
                      {isPrivateHost(serverUrl) ? (
                        <>
                          <strong>This server is on a private network</strong>, so a
                          connector can't reach it: connectors connect from
                          Anthropic's servers, not your computer, and your VPN
                          doesn't apply to them.{" "}
                        </>
                      ) : (
                        <>
                          Behind a VPN or firewall? A connector connects from
                          Anthropic's servers, not your computer, so it can't
                          reach a server only your VPN can.{" "}
                        </>
                      )}
                      Use <strong>Claude Code</strong> or the{" "}
                      <strong>Desktop config</strong> below — they run on your
                      machine and go through your VPN — or ask your admin to
                      allowlist{" "}
                      <a
                        href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        Anthropic's IP ranges
                      </a>{" "}
                      for this server's <code className="text-[10px]">/mcp</code>{" "}
                      and sign-in endpoints.
                    </span>
                  </div>
                </div>
                <div className="border-t pt-3">
                  <p className="text-sm mb-3">
                    <strong>Claude Code plugin</strong> — the easiest way: install
                    it, then let it walk you through setup. Nothing to copy, and
                    connecting uploads nothing.
                  </p>
                  <Snippet
                    label="Run inside Claude Code"
                    value={"/plugin marketplace add promptowl/contextnest\n/plugin install contextnest\n/contextnest:setup"}
                    multiline
                  />
                </div>
                <div className="border-t pt-3">
                  <p className="text-sm mb-3">
                    <strong>Claude Code</strong> (the CLI) registers a server with
                    one command — it persists the config itself, no file to find
                    or edit.
                    {signIn && (
                      <>
                        {" "}
                        Then run <code className="text-[11px] bg-muted px-1 rounded">/mcp</code>{" "}
                        in Claude Code and choose <strong>Authenticate</strong> to
                        sign in.
                      </>
                    )}
                    {!noKey && (
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
                  <Snippet
                    label="Run in your terminal (Claude Code CLI)"
                    value={claudeCodeCmd}
                    multiline
                  />
                  <p className="text-xs text-muted-foreground mt-2">
                    Takes effect on your next Claude Code session — the nest's
                    context tools then appear in the tools panel.
                  </p>
                </div>
                <div className="border-t pt-3">
                  <p className="text-sm mb-3">
                    Using <strong>Claude Desktop</strong> (the GUI app) instead?
                    It has no CLI, so add this to your{" "}
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">
                      claude_desktop_config.json
                    </code>
                    {signIn && " — or use the connector above, which needs no file. A browser opens to sign you in on first use."}
                    {!noKey && (
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
                  <Snippet
                    label="Claude Desktop config (via mcp-remote bridge)"
                    value={claudeConfig}
                    multiline
                  />
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
                  <p className="text-xs text-muted-foreground mt-2">
                    Claude Desktop config runs a local command, so this uses{" "}
                    <code className="text-[10px]">mcp-remote</code> to bridge to
                    the server's HTTP endpoint — you need{" "}
                    <a
                      href="https://nodejs.org"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      Node.js
                    </a>{" "}
                    installed (it provides{" "}
                    <code className="text-[10px]">npx</code>). Restart Claude
                    Desktop after editing; the nest's context tools then appear
                    in the tools panel.
                  </p>
                </div>
              </TabsContent>

              {/* Raw MCP */}
              <TabsContent value="mcp" className="space-y-4 pt-4">
                <div>
                  <p className="text-sm mb-3">
                    Streamable HTTP MCP endpoint with 25 tools (11 content + 11
                    governance + 3 admin/sync). Works with native HTTP MCP
                    clients (Cursor, VS Code) as a JSON config; Claude Code has
                    its own one-command setup and Claude Desktop needs a
                    bridge — see the Claude tab for both.
                    {signIn && " The client opens a browser to sign you in on first use — no key."}
                    {!noKey && (
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
                  <Snippet
                    label="Direct HTTP config (Cursor, VS Code, Claude Code — not Claude Desktop)"
                    value={mcpConfig}
                    multiline
                  />
                  <Snippet
                    label={`From the ctx CLI (2.2+)${showOpenModeBanner ? "" : " — headless agents & CI: export CONTEXTNEST_API_KEY first (people: ctx login, CLI tab)"}`}
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
                    CLI:
                  </p>
                  <Snippet
                    label="Install"
                    value="npm i -g @promptowl/contextnest-cli"
                  />
                  {!showOpenModeBanner && (
                    <>
                      <Snippet
                        label="Sign in once (opens your browser) — registers every nest you can see"
                        value={`ctx login ${serverUrl}`}
                      />
                      <p className="mb-3 text-xs text-muted-foreground">
                        If this server has no browser sign-in, ctx says so and
                        takes a key on stdin instead (
                        <code className="text-[10px]">--key-stdin</code>).
                      </p>
                    </>
                  )}
                  <Snippet
                    label={
                      showOpenModeBanner
                        ? "Register this nest as a vault alias, then query it"
                        : "Headless agents & CI — register this nest with the key in CONTEXTNEST_API_KEY"
                    }
                    value={ctxAliasSnippet}
                    multiline
                  />
                  <Snippet
                    label={`Push a local vault into this nest${showOpenModeBanner ? "" : " (after ctx login, drop the key; in CI it comes from the environment)"}`}
                    value={ctxPush}
                    multiline
                  />
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
              <CopyButton text={nestId} variant="ghost" className="h-6 px-2" />
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
      {nestKey && (
        <KeyRevealModal
          apiKey={nestKey.key}
          kind={nestKey.kind}
          nestId={nestId}
          scopedTo={{ nestName, mcpUrl }}
          onClose={() => setNestKey(null)}
        />
      )}
      <RotateKeyConfirm
        target={rotateTarget}
        onConfirm={(id) => mintNestKey(id)}
        onClose={() => setRotateTarget(null)}
      />
    </>
  );
}

/** Rotating kills the old key on the spot — ask first, naming the key. */
export function RotateKeyConfirm({
  target,
  onConfirm,
  onClose,
}: {
  target: { id: string; name: string } | null;
  onConfirm: (id: string) => Promise<unknown>;
  onClose: () => void;
}) {
  if (!target) return null;
  return (
    <ReasonDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Rotate "${target.name}"?`}
      description="The current key stops working immediately — anything still using it needs the new one."
      confirmLabel="Rotate key"
      destructive
      onConfirm={async () => {
        await onConfirm(target.id);
      }}
    />
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
  scopedTo,
}: {
  apiKey: string;
  kind: "generated" | "rotated";
  onClose: () => void;
  nestId?: string;
  /** Set when the key is nest-only: says so, and pairs it with the one MCP
   *  URL it works with. */
  scopedTo?: { nestName: string; mcpUrl: string };
}) {
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
            <CopyButton text={apiKey} />
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
          {scopedTo && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              <p className="mb-1.5">
                This key works for <strong>{scopedTo.nestName}</strong> only.
                Use it with this nest's MCP URL — other nests, your account and
                your API keys refuse it.
              </p>
              <Snippet label="MCP URL" value={scopedTo.mcpUrl} />
            </div>
          )}
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
        <CopyButton text={value} variant="ghost" className="h-6 px-2" />
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
