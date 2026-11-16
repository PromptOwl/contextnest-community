/**
 * First-run onboarding (PO-1185): the pure logic behind the welcome screen.
 * React-free so it unit-tests in this repo's node-only vitest setup.
 *
 * HARNESS TILES. One tile per agent client ("harness") a person may connect.
 * The order is fixed: Hootie first (zero setup), then Claude, then the rest.
 * Every tile carries the nest's MCP URL and ends in the connect proof — the
 * server's record that an agent really read the nest (GET
 * /onboarding/connection), never the agent's own claim.
 *
 * HONESTY RULE (AC7). A tile gives exact steps only when they come from this
 * repo's own harness list (agent-connect-docs.ts, each entry citing its
 * vendor page) or from the vendor's official documentation, named in
 * `source`. Where neither confirms the steps, `confirmed` is false: the tile
 * says so and shows the general MCP steps instead of guessing a menu path.
 */
import { harnessById, type ConnectDocsContext } from "./agent-connect-docs";

export type HarnessAuth = "native" | "oauth" | "key";

export interface OnboardingNest {
  id: string;
  name: string;
  mcp_url: string;
  server_mcp_url: string;
}

export interface SlackConnectorState {
  configured: boolean;
  can_connect: boolean;
  connected: boolean;
  admin_settings_path: string | null;
  reason: string | null;
  disclosure: string;
}

export interface OnboardingState {
  enabled: boolean;
  show: boolean;
  first_run: boolean;
  dismissed: boolean;
  nest: OnboardingNest | null;
  can_create_nest: boolean;
  suggested_nest_name: string;
  server_url: string;
  open_mode: boolean;
  mcp_oauth_enabled: boolean;
  hootie_enabled: boolean;
  distill: { enabled: boolean; model_available: boolean; mode: "server" | "agent" };
  connectors: { slack: SlackConnectorState };
}

export interface ConnectionEvidence {
  connected: boolean;
  at: string | null;
  via: "mcp" | "api" | "hootie" | null;
  client: string | null;
  tool: string | null;
}

export interface TileContext {
  nest: OnboardingNest;
  serverUrl: string;
  openMode: boolean;
  mcpOauthEnabled: boolean;
  hootieEnabled: boolean;
}

export interface HarnessTile {
  id: string;
  name: string;
  /** Who makes it, as a short subtitle. */
  maker: string;
  /** Steps are confirmed by repo docs or the vendor's official docs. */
  confirmed: boolean;
  auth: HarnessAuth;
  /** The URL this tile tells the person to paste. */
  connectUrl: string;
  /** Markdown body: the steps. Never contains key material. */
  steps: string;
  /** The page the steps were written from (absent when unconfirmed). */
  source?: string;
  /** Matches what the client calls itself in the connect proof. */
  clientPattern: RegExp;
  /** The tile can act in-app instead of giving steps (Hootie panel). */
  inApp?: boolean;
}

/** The public agent manual every server serves — the general MCP steps. */
export function generalInstructionsUrl(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, "")}/llms.txt`;
}

const KEY = "<your ContextNest API key>";

/** The general MCP steps for a client whose own steps are not confirmed. */
export function generalMcpSteps(name: string, ctx: TileContext): string {
  const lines = [
    `We could not confirm ${name}'s exact connect steps from its vendor's documentation, so these are the general steps that work with any MCP client.`,
    "",
    `1. In ${name}, find where you add an MCP server. Clients call this connectors, extensions, tools or MCP servers.`,
    `2. Add a remote server (Streamable HTTP) at \`${ctx.nest.mcp_url}\`.`,
  ];
  if (ctx.openMode) lines.push("3. Choose no authentication. This server needs no credential.");
  else if (ctx.mcpOauthEnabled)
    lines.push(
      `3. If ${name} offers to sign in (OAuth), use \`${ctx.nest.server_mcp_url}\` instead and sign in as yourself. It reads this nest and every other nest you can see. Otherwise send the header \`Authorization: Bearer ${KEY}\`.`,
    );
  else lines.push(`3. Send the header \`Authorization: Bearer ${KEY}\`. Create a key under API keys.`);
  lines.push(`4. Ask ${name} to list the documents in "${ctx.nest.name}". This screen shows when it really did.`);
  return lines.join("\n");
}

function existingBody(id: string, ctx: TileContext, url: string): { steps: string; source: string } {
  const h = harnessById(id);
  if (!h) throw new Error(`no harness ${id}`);
  const docsCtx: ConnectDocsContext = { serverUrl: ctx.serverUrl, openMode: ctx.openMode };
  return { steps: h.body(docsCtx, url), source: h.docs };
}

/** The tiles, in display order, for one nest. */
export function harnessTiles(ctx: TileContext): HarnessTile[] {
  const nestUrl = ctx.nest.mcp_url;
  const serverUrl = ctx.nest.server_mcp_url;
  const tiles: HarnessTile[] = [];

  // Hootie: zero setup in the app; the desktop app takes the server URL.
  tiles.push({
    id: "hootie",
    name: "Hootie",
    maker: "PromptOwl",
    confirmed: true,
    auth: "native",
    connectUrl: nestUrl,
    inApp: ctx.hootieEnabled,
    clientPattern: /hootie/i,
    steps: [
      ctx.hootieEnabled
        ? `Hootie is built in. Open your nest and ask Hootie a question about it. Nothing to set up.`
        : "Hootie in the app is off on this server. A server admin turns it on in Server settings → Hootie.",
      "",
      "**Hootie desktop app**",
      "",
      "1. Open Hootie and click the gear icon (Settings).",
      "2. Go to **ContextNest Vault** and switch to **Remote Server**.",
      `3. Paste the server URL \`${ctx.serverUrl}\`${ctx.openMode ? "" : " and your API key"}, then click **Test Vault**.`,
    ].join("\n"),
  });

  // Claude: the connector with sign-in when the server runs OAuth.
  {
    const code = existingBody("claude-code", ctx, nestUrl);
    const connector = ctx.mcpOauthEnabled
      ? [
          "**claude.ai and Claude Desktop**",
          "",
          "1. Open **Customize → Connectors** and click **Add custom connector**.",
          `2. Paste \`${serverUrl}\`. Sign-in connectors use the server URL; it reads this nest and every other nest you can see.`,
          "3. Click **Add**, then **Connect**, and sign in here as yourself. No key to paste.",
        ].join("\n")
      : ["**claude.ai and Claude Desktop**", "", existingBody("claude-desktop", ctx, nestUrl).steps].join("\n");
    tiles.push({
      id: "claude",
      name: "Claude",
      maker: "Anthropic",
      confirmed: true,
      auth: ctx.mcpOauthEnabled ? "oauth" : "key",
      connectUrl: ctx.mcpOauthEnabled ? serverUrl : nestUrl,
      source: harnessById("claude-desktop")!.docs,
      clientPattern: /claude/i,
      steps: [connector, "", "**Claude Code**", "", code.steps].join("\n"),
    });
  }

  // Duet: Anthropic's harness. No official connect page found.
  tiles.push(unconfirmed("duet", "Duet", "Anthropic", /duet/i, ctx));
  // Muse: Meta's harness and connector platform. Only third-party guides
  // were found, and they disagree on the path, so no steps are given.
  tiles.push(unconfirmed("muse", "Muse", "Meta", /muse/i, ctx));

  // Grok and Hermes: from this repo's harness list, with the nest's URL.
  for (const [id, name, maker, pattern] of [
    ["grok", "Grok", "xAI", /grok/i],
    ["hermes", "Hermes", "Nous Research", /hermes/i],
  ] as const) {
    const b = existingBody(id, ctx, nestUrl);
    tiles.push({ id, name, maker, confirmed: true, auth: "key", connectUrl: nestUrl, steps: b.steps, source: b.source, clientPattern: pattern });
  }

  tiles.push(unconfirmed("instinct", "Instinct", "Consumer assistant", /instinct/i, ctx));

  // Goose: steps from goose's own documentation (Using Extensions).
  tiles.push({
    id: "goose",
    name: "Goose",
    maker: "Block",
    confirmed: ctx.mcpOauthEnabled || ctx.openMode,
    auth: "oauth",
    connectUrl: ctx.openMode ? nestUrl : serverUrl,
    source: "https://goose-docs.ai/docs/getting-started/using-extensions",
    clientPattern: /goose/i,
    steps:
      ctx.mcpOauthEnabled || ctx.openMode
        ? [
            "1. Run `goose configure` and choose **Add Extension**.",
            "2. Choose **Remote Extension (Streamable HTTP)**.",
            `3. Give it a name and the URL \`${ctx.openMode ? nestUrl : serverUrl}\`, and keep the default timeout.`,
            ctx.openMode ? "4. Start a session. This server needs no sign-in." : "4. Start a session. Goose opens this server's sign-in page; sign in as yourself.",
            "",
            `For one session only: \`goose session --with-streamable-http-extension "${ctx.openMode ? nestUrl : serverUrl}"\`.`,
          ].join("\n")
        : generalMcpSteps("Goose", ctx) +
          "\n\nGoose's documentation describes sign-in (OAuth) for remote extensions but no header field. Sign-in is off on this server; a server admin turns it on in Server settings → Features → Agent OAuth.",
  });

  return tiles;
}

function unconfirmed(id: string, name: string, maker: string, clientPattern: RegExp, ctx: TileContext): HarnessTile {
  return {
    id,
    name,
    maker,
    confirmed: false,
    auth: ctx.mcpOauthEnabled ? "oauth" : "key",
    connectUrl: ctx.nest.mcp_url,
    steps: generalMcpSteps(name, ctx),
    clientPattern,
  };
}

/** What a tile says about the connect proof. */
export function connectionLabel(e: ConnectionEvidence | null | undefined, tile: Pick<HarnessTile, "name" | "clientPattern">): {
  state: "waiting" | "connected" | "other";
  text: string;
} {
  if (!e?.connected) return { state: "waiting", text: `Waiting for ${tile.name} to read your nest` };
  const who = e.client?.trim();
  if (who && tile.clientPattern.test(who)) return { state: "connected", text: `${tile.name} read your nest` };
  if (!who) return { state: "connected", text: `An agent read your nest` };
  return { state: "other", text: `An agent that calls itself "${who}" read your nest` };
}

/** Progress of a distill job as a 0–100 bar and a line of text. */
export function distillProgress(job: { status: string; phase: string; done_steps: number; total_steps: number; nodes: unknown[]; error: string | null } | null | undefined): {
  percent: number;
  label: string;
} {
  if (!job) return { percent: 0, label: "" };
  if (job.status === "failed") return { percent: 0, label: job.error ?? "The distill failed." };
  if (job.status === "done") return { percent: 100, label: `Done. ${job.nodes.length} draft${job.nodes.length === 1 ? " is" : "s are"} waiting for your review.` };
  const pct = job.total_steps > 0 ? Math.min(99, Math.round((job.done_steps / job.total_steps) * 100)) : 2;
  const label =
    job.phase === "fetching"
      ? "Reading the source"
      : job.phase === "extracting"
        ? `Extracting (${job.done_steps} of ${Math.max(job.total_steps - 1, 1)} parts)`
        : job.phase === "organizing"
          ? "Organizing into documents"
          : `Writing drafts (${job.nodes.length} so far)`;
  return { percent: Math.max(pct, 2), label };
}

/** The Slack tile: what to show and what the button does. */
export function slackTile(s: SlackConnectorState | null | undefined, hasNest: boolean): {
  action: "connect" | "connected" | "admin" | "blocked";
  text: string;
} {
  if (!s) return { action: "blocked", text: "" };
  if (s.connected) return { action: "connected", text: "Slack is connected to this nest. Bind a channel to start capturing." };
  if (s.can_connect && hasNest) return { action: "connect", text: "Connect your own Slack workspace. You choose the channels later." };
  if (s.admin_settings_path) return { action: "admin", text: "Configure the Slack app in Server settings first. You are a server admin." };
  return { action: "blocked", text: s.reason ?? "A server admin must configure Slack first." };
}

/** Read the `?onboarding=slack&slack=connected` return and strip it. */
export function slackReturn(search: string): { returned: boolean; connected: boolean; clean: string } {
  const p = new URLSearchParams(search);
  const returned = p.get("onboarding") === "slack";
  const connected = returned && p.get("slack") === "connected";
  p.delete("onboarding");
  p.delete("slack");
  const rest = p.toString();
  return { returned, connected, clean: rest ? `?${rest}` : "" };
}
