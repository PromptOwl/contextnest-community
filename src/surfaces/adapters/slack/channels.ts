/**
 * The channels a Slack install can offer the setup wizard (po-1186 CR3).
 *
 * users.conversations with the bot's own token: only the public and private
 * channels the bot was added to. Never DMs or group DMs, never archived
 * channels, never message text. Each row carries name, privacy, Slack
 * Connect and member count (when Slack sends it), plus this install's
 * binding for it, if any. REST (GET /surfaces/slack/installs/:id/channels)
 * and MCP (context_surfaces_slack_channels_list) both call this.
 */
import { getDb } from "../../../db/client.js";
import type { InstallRow } from "../../services/install-store.js";
import { botToken, NO_BOT_TOKEN } from "./connector.js";
import { slackCall, SlackApiError } from "./api.js";
import { SurfaceRateLimited } from "../../contract.js";

export const MAX_CHANNEL_PAGES = 10;

export interface InstallChannel {
  id: string;
  name: string | null;
  is_private: boolean;
  is_ext_shared: boolean;
  /** Slack's own count, when it sends one; null otherwise. */
  num_members: number | null;
  binding: { id: string; nest_id: string; status: string } | null;
}

export async function listInstallChannels(install: InstallRow): Promise<{ channels: InstallChannel[]; truncated: boolean }> {
  const token = await botToken(install.id);
  const raw: Array<Record<string, any>> = [];
  let cursor = "";
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page >= MAX_CHANNEL_PAGES) {
      truncated = true;
      break;
    }
    const r = await slackCall(
      "users.conversations",
      { types: "public_channel,private_channel", exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) },
      { token },
    );
    if (Array.isArray(r.channels)) raw.push(...r.channels);
    cursor = String(r.response_metadata?.next_cursor ?? "");
    if (!cursor) break;
  }
  const bindings = (await getDb().all("SELECT id, nest_id, status, conversation_id FROM surface_bindings WHERE install_id = ? AND status <> 'removed'", [install.id])) as Array<{
    id: string;
    nest_id: string;
    status: string;
    conversation_id: string;
  }>;
  const byConv = new Map(bindings.map((b) => [b.conversation_id, b]));
  const channels = raw
    .filter((ch) => typeof ch.id === "string" && !ch.is_im && !ch.is_mpim && !ch.is_archived)
    .map((ch): InstallChannel => {
      const b = byConv.get(ch.id);
      return {
        id: String(ch.id),
        name: typeof ch.name === "string" ? ch.name.slice(0, 80) : null,
        is_private: !!(ch.is_private || ch.is_group),
        is_ext_shared: !!(ch.is_ext_shared || ch.is_shared || ch.is_pending_ext_shared),
        num_members: typeof ch.num_members === "number" ? ch.num_members : null,
        binding: b ? { id: b.id, nest_id: b.nest_id, status: b.status } : null,
      };
    })
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  return { channels, truncated };
}

/**
 * How a failed channel list reads to the admin, shared by REST and MCP:
 * no usable bot token → 409 (finish connecting), Slack rate limit → 429 with
 * Retry-After, any other Slack refusal → 502 with Slack's code. Anything
 * else is a real server error and is rethrown.
 */
export function channelListFailure(err: unknown): { status: 409 | 429 | 502; error: string; retryAfterSec?: number } {
  if (err instanceof SurfaceRateLimited) {
    return { status: 429, error: `Slack is rate-limiting the channel list. Try again in ${err.retryAfterSec} seconds.`, retryAfterSec: err.retryAfterSec };
  }
  if (err instanceof SlackApiError) return { status: 502, error: `Slack refused the channel list (${err.code}).` };
  if (err instanceof Error && err.message === NO_BOT_TOKEN) {
    return { status: 409, error: "This install has no usable bot token. Connect Slack again (Install to Slack) to save one." };
  }
  throw err;
}

/** The truncation line both surfaces show, so a missing channel is never silent. */
export const TRUNCATED_NOTE = `Nest is in more channels than this list shows (it stops after ${MAX_CHANNEL_PAGES} pages from Slack).`;
