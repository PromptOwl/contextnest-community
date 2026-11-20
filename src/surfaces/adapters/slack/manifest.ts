/**
 * The Slack app manifest (PRD §5.4): least-privilege bot scopes, no user
 * scopes, no mpim:*. S2a ships only what it uses: no im:history /
 * message.im / Messages tab (DM capture is S2b) and no team:read
 * (oauth.v2.access already returns the team) — security round 2 INFO; the bot events ingestion needs, interactivity on, App
 * Home on. Generated per install so the request URLs carry the install id;
 * the hosted app uses the same lists. docs/surfaces/slack-app-manifest.json
 * is the same manifest with placeholder URLs, for the customer-owned app.
 */
import { isPrivateHost } from "../../../shared/private-host.js";

export const BOT_SCOPES: readonly string[] = [
  "channels:history",
  "groups:history",
  // S2b: DM capture (§12 R2, default OFF) needs message.im + im:history.
  "im:history",
  "channels:read",
  "groups:read",
  "im:read",
  "im:write",
  "reactions:read",
  "users:read",
  "users:read.email",
  "chat:write",
  "app_mentions:read",
  // S2b: the /nest slash command (leave, dm off|on — §12 R2/R3). Not in the
  // PRD §5.4 list; slash commands can't be registered without it.
  "commands",
];

export const BOT_EVENTS: readonly string[] = [
  "message.channels",
  "message.groups",
  "message.im",
  "app_mention",
  "reaction_added",
  "member_joined_channel",
  "member_left_channel",
  "channel_left",
  "group_left",
  "channel_shared",
  "channel_unshared",
  "channel_archive",
  "group_archive",
  "channel_deleted",
  "group_deleted",
  "user_change",
  "app_home_opened",
  "app_uninstalled",
  "tokens_revoked",
];

/** What is wrong with this server's public address for Slack, and how to fix it. */
export interface PublicUrlProblem {
  problem: string;
  steps: string[];
}

export const PUBLIC_URL_SETTING = "Server settings → Basic → Public base URL";

/**
 * Null when Slack can reach `baseUrl`: set, https, and not a localhost or
 * private address. Slack calls the server from its own network, so anything
 * else fails at Slack with an error page we never see.
 */
export function publicUrlProblem(baseUrl: string): PublicUrlProblem | null {
  let problem: string | null = null;
  if (!baseUrl) problem = "This server has no public base URL set.";
  else if (isPrivateHost(baseUrl)) problem = `The public base URL is ${baseUrl}. Slack can't reach a localhost or private network address.`;
  else if (!/^https:\/\//i.test(baseUrl)) problem = `The public base URL is ${baseUrl}. Slack accepts only https:// addresses.`;
  if (!problem) return null;
  return {
    problem,
    steps: [
      "Find the public https address people use to open this server from outside your network, for example https://nest.yourcompany.com. Ask whoever runs this server if you don't know it.",
      `Open ${PUBLIC_URL_SETTING}, enter that address and click Save. It applies at once.`,
      "Open this server at that address and sign in again.",
      "In Control room → Setup, download the manifest again and paste it into your Slack app (api.slack.com/apps → your app → App Manifest), so Slack has the new addresses.",
      "Click Open Slack to approve again.",
    ],
  };
}

/**
 * Null when the request reached this server at its public base URL. Slack
 * sends the browser back to the public base URL, so starting from any other
 * address (localhost, or another server's domain) can't finish here.
 * `requestHost` is host[:port] as the request arrived; null = unknown, no check.
 */
export function originMismatch(baseUrl: string, requestHost: string | null): PublicUrlProblem | null {
  if (!requestHost || !baseUrl) return null;
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (base.host.toLowerCase() === requestHost.trim().toLowerCase()) return null;
  return {
    problem: `You opened this server at ${requestHost}, but its public base URL is ${baseUrl}. Slack sends you back to the public base URL after approval, so the install can only finish there.`,
    steps: [
      `If ${baseUrl} is this server, open it at that address, sign in, and start again from Control room → Setup.`,
      `If it is a different server, open ${PUBLIC_URL_SETTING}, enter this server's own public https address and click Save.`,
    ],
  };
}

export function slackUrls(baseUrl: string, installId: string | "hosted") {
  const base = baseUrl.replace(/\/+$/, "");
  const prefix = installId === "hosted" ? `${base}/surfaces/slack/hosted` : `${base}/surfaces/slack/${installId}`;
  return {
    events: `${prefix}/events`,
    interactions: `${prefix}/interactions`,
    commands: `${prefix}/commands`,
    redirect: `${base}/surfaces/slack/oauth/callback`,
  };
}

export function buildManifest(opts: { baseUrl: string; installId: string | "hosted"; appName?: string }) {
  const urls = slackUrls(opts.baseUrl, opts.installId);
  const name = (opts.appName ?? "Nest").slice(0, 35);
  return {
    _metadata: { major_version: 1, minor_version: 1 },
    display_information: {
      name,
      description: "Listens with judgement and proposes what's worth keeping to your governed nest. Nothing is saved until a person approves it.",
      background_color: "#1f2937",
    },
    features: {
      // S2b: DM capture (a setting, default OFF) — the Messages tab is on.
      app_home: { home_tab_enabled: true, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: name.toLowerCase().replace(/[^a-z0-9._-]/g, "-"), always_online: false },
      slash_commands: [
        { command: "/nest", url: urls.commands, description: "Remove Nest from this conversation, or turn your DM capture off/on", usage_hint: "leave | invite | dm off | dm on", should_escape: false },
      ],
    },
    oauth_config: {
      redirect_urls: [urls.redirect],
      scopes: { bot: [...BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: { request_url: urls.events, bot_events: [...BOT_EVENTS] },
      interactivity: { is_enabled: true, request_url: urls.interactions },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
