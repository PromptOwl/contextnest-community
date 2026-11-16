/**
 * The Slack app manifest (PRD §5.4): least-privilege bot scopes, no user
 * scopes, no mpim:*. S2a ships only what it uses: no im:history /
 * message.im / Messages tab (DM capture is S2b) and no team:read
 * (oauth.v2.access already returns the team) — security round 2 INFO; the bot events ingestion needs, interactivity on, App
 * Home on. Generated per install so the request URLs carry the install id;
 * the hosted app uses the same lists. docs/surfaces/slack-app-manifest.json
 * is the same manifest with placeholder URLs, for the customer-owned app.
 */
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
