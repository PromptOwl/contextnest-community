/**
 * The Slack adapter: S1's SurfaceConnector over the Slack Web API.
 *
 * Event-driven only. The single history read is `fetchMessages`, used by the
 * explicit-ask fetch queue (§4.3) for one message or one thread — never a
 * backfill. Every call uses the install's bot token from the secret store.
 * members() fails closed: any error, a missing profile or a page it can't
 * finish is {known:false} (AC-CON-02); MPIMs are never enumerable.
 */
import type {
  BindingRef,
  CardRef,
  FetchedMessage,
  MembersResult,
  ProposalView,
  SurfaceConnector,
  SurfaceInstallRef,
  SurfaceMember,
  SurfaceMessage,
  SurfaceSignal,
  SurfaceUserProfile,
  VerifyResult,
} from "../../contract.js";
import { getSecret } from "../../services/secret-store.js";
import { getInstall } from "../../services/install-store.js";
import { slackCall } from "./api.js";
import { verifySlackSignature } from "./verify.js";
import { renderCard, renderCardText } from "./card.js";
import { REMEMBER_RE, SKIP_ME_RE } from "../../core/gate.js";

const MAX_MEMBER_PAGES = 50;

async function token(installId: string): Promise<string> {
  const t = await getSecret(installId, "bot_token");
  if (!t) throw new Error("no bot token");
  return t;
}

function profileOf(u: Record<string, any>): SurfaceUserProfile {
  return {
    surface_user_id: String(u.id),
    home_team_id: u.team_id ? String(u.team_id) : null,
    enterprise_id: u.enterprise_user?.enterprise_id ? String(u.enterprise_user.enterprise_id) : null,
    email: typeof u.profile?.email === "string" ? u.profile.email : null,
    // V19: absent → null, so auto-match fails closed.
    email_confirmed: typeof u.is_email_confirmed === "boolean" ? u.is_email_confirmed : null,
    is_restricted: !!u.is_restricted,
    is_ultra_restricted: !!u.is_ultra_restricted,
    is_stranger: !!u.is_stranger,
    is_bot: !!u.is_bot || u.id === "USLACKBOT",
    deleted: !!u.deleted,
    user_role: null,
    display_name: (u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || null) as string | null,
  };
}

async function userInfo(installId: string, userId: string): Promise<SurfaceUserProfile | null> {
  try {
    const r = await slackCall("users.info", { user: userId }, { token: await token(installId) });
    return r.user ? profileOf(r.user) : null;
  } catch {
    return null;
  }
}

/** Slack event_callback envelope → contract messages / signal. */
export function normalizeSlack(envelope: Record<string, any>): SurfaceMessage[] | SurfaceSignal {
  const workspace = String(envelope.team_id ?? "");
  const ev = (envelope.event ?? {}) as Record<string, any>;
  const sig = (kind: SurfaceSignal["kind"], extra: Partial<SurfaceSignal> = {}): SurfaceSignal => ({ surface: "slack", workspace, kind, ...extra });
  const author = (id: unknown) => ({ id: String(id ?? ""), is_bot: false, is_guest: false, is_external: false });
  switch (ev.type) {
    case "member_joined_channel":
      return sig("member_joined", { conversation: ev.channel, user: ev.user });
    case "member_left_channel":
      return sig("member_left", { conversation: ev.channel, user: ev.user });
    case "channel_left":
    case "group_left":
      return sig("bot_removed", { conversation: ev.channel });
    case "channel_shared":
      return sig("conversation_shared", { conversation: ev.channel });
    case "channel_unshared":
      return sig("conversation_unshared", { conversation: ev.channel });
    case "channel_archive":
    case "group_archive":
      return sig("conversation_archived", { conversation: ev.channel });
    case "channel_deleted":
    case "group_deleted":
      return sig("conversation_deleted", { conversation: ev.channel });
    case "user_change":
      return sig("user_change", { user: ev.user?.id });
    case "app_uninstalled":
      return sig("uninstalled");
    case "tokens_revoked":
      return sig("tokens_revoked");
    case "reaction_added": {
      if (ev.reaction !== "brain" || ev.item?.type !== "message") return [];
      return [
        {
          surface: "slack",
          workspace,
          conversation: String(ev.item.channel),
          thread: null,
          author: author(ev.user),
          text: "",
          ts: String(ev.event_ts ?? ev.item.ts),
          id: `reaction:${ev.item.ts}:${ev.user}`,
          kind: "explicit_ask",
          ask_via: "reaction",
          target: { id: String(ev.item.ts), author: ev.item_user ? String(ev.item_user) : null, thread: null },
        },
      ];
    }
    case "app_mention": {
      const text = String(ev.text ?? "");
      const base = {
        surface: "slack" as const,
        workspace,
        conversation: String(ev.channel),
        thread: ev.thread_ts ? String(ev.thread_ts) : null,
        author: author(ev.user),
        text: "",
        ts: String(ev.ts),
        id: String(ev.ts),
      };
      if (SKIP_ME_RE.test(text)) return [{ ...base, kind: "optout" }];
      if (REMEMBER_RE.test(text)) {
        const root = ev.thread_ts ? String(ev.thread_ts) : String(ev.ts);
        return [{ ...base, kind: "explicit_ask", ask_via: "mention", target: { id: root, author: null, thread: root } }];
      }
      return [];
    }
    case "message": {
      const st = ev.subtype ? String(ev.subtype) : null;
      if (st === "message_deleted") {
        return [{ surface: "slack", workspace, conversation: String(ev.channel), thread: null, author: author(null), text: "", ts: String(ev.deleted_ts), id: String(ev.deleted_ts), kind: "delete" }];
      }
      if (st === "message_changed") {
        const m = (ev.message ?? {}) as Record<string, any>;
        return [
          {
            surface: "slack",
            workspace,
            conversation: String(ev.channel),
            thread: m.thread_ts ? String(m.thread_ts) : null,
            author: author(m.user),
            text: String(m.text ?? ""),
            ts: String(m.ts),
            id: String(m.ts),
            kind: "edit",
            subtype: m.subtype ? String(m.subtype) : null,
            bot_id: m.bot_id ? String(m.bot_id) : null,
          },
        ];
      }
      return [
        {
          surface: "slack",
          workspace,
          conversation: String(ev.channel),
          thread: ev.thread_ts ? String(ev.thread_ts) : null,
          author: author(ev.user),
          text: String(ev.text ?? ""),
          ts: String(ev.ts),
          id: String(ev.ts),
          kind: "message",
          subtype: st,
          bot_id: ev.bot_id ? String(ev.bot_id) : null,
        },
      ];
    }
    default:
      return [];
  }
}

export function createSlackConnector(): SurfaceConnector {
  return {
    surface: "slack",

    /** Manifest installs: /surfaces/slack/:installId/… signed with that install's secret. */
    async verify(request: Request): Promise<VerifyResult> {
      const m = /\/surfaces\/slack\/([^/]+)\/(events|interactions)$/.exec(new URL(request.url).pathname);
      if (!m) return { ok: false, status: 404 };
      const install = await getInstall(m[1]);
      if (!install || install.surface !== "slack") return { ok: false, status: 404 };
      const raw = await request.clone().text();
      const ok = verifySlackSignature(
        await getSecret(install.id, "signing_secret"),
        request.headers.get("x-slack-request-timestamp"),
        request.headers.get("x-slack-signature"),
        raw,
      );
      return ok ? { ok: true, install_id: install.id } : { ok: false, status: 401 };
    },

    normalize(event: unknown) {
      return normalizeSlack((event ?? {}) as Record<string, any>);
    },

    async members(install: SurfaceInstallRef, conversation: string): Promise<MembersResult> {
      try {
        const tk = await token(install.id);
        const info = (await slackCall("conversations.info", { channel: conversation }, { token: tk })).channel as Record<string, any>;
        if (!info || info.is_mpim) return { known: false, reason: "not_enumerable" };
        const kind = info.is_im ? "dm" : info.is_private || info.is_group ? "private_channel" : "public_channel";
        const ids: string[] = [];
        let cursor = "";
        for (let page = 0; ; page++) {
          if (page >= MAX_MEMBER_PAGES) return { known: false, reason: "incomplete" };
          const r = await slackCall("conversations.members", { channel: conversation, limit: 200, ...(cursor ? { cursor } : {}) }, { token: tk });
          if (!Array.isArray(r.members)) return { known: false, reason: "malformed" };
          ids.push(...r.members.map(String));
          cursor = String(r.response_metadata?.next_cursor ?? "");
          if (!cursor) break;
        }
        const home = install.team_id ?? install.tenant_key;
        const members: SurfaceMember[] = [];
        for (const id of ids) {
          const p = await userInfo(install.id, id);
          if (!p) return { known: false, reason: "profile_unreadable" };
          members.push({
            surface_user_id: id,
            is_bot: p.is_bot,
            is_guest: p.is_restricted || p.is_ultra_restricted,
            is_external: p.is_stranger || (!!p.home_team_id && p.home_team_id !== home),
            home_tenant: p.home_team_id,
          });
        }
        return {
          known: true,
          complete: true,
          members,
          conversation: {
            id: conversation,
            name: info.name ? String(info.name) : null,
            kind,
            is_private: kind !== "public_channel",
            is_ext_shared: !!(info.is_ext_shared || info.is_shared || info.is_pending_ext_shared),
            is_general: !!info.is_general,
            enumerable: true,
          },
        };
      } catch {
        return { known: false, reason: "error" };
      }
    },

    userProfile(install: SurfaceInstallRef, surfaceUserId: string) {
      return userInfo(install.id, surfaceUserId);
    },

    async postProposal(binding: BindingRef, view: ProposalView): Promise<CardRef> {
      const r = await slackCall(
        "chat.postMessage",
        {
          channel: binding.conversation_id,
          thread_ts: view.thread_ref ?? undefined,
          text: renderCardText(view),
          blocks: JSON.stringify(renderCard(view)),
          unfurl_links: false,
          unfurl_media: false,
        },
        { token: await token(binding.install_id) },
      );
      return { surface: "slack", conversation: String(r.channel ?? binding.conversation_id), message_ref: String(r.ts) };
    },

    async updateProposal(ref: CardRef, view: ProposalView): Promise<void> {
      void ref;
      void view;
      // Card updates (outcomes) land with the commit path in S2b.
    },

    async resolveIdentity(install: SurfaceInstallRef, surfaceUserId: string) {
      const { resolveIdentity } = await import("../../services/identity-service.js");
      return resolveIdentity(install.id, surfaceUserId);
    },

    async sendPrivate(binding: BindingRef, surfaceUserId: string, view: ProposalView): Promise<void> {
      await slackCall(
        "chat.postEphemeral",
        { channel: binding.conversation_id, user: surfaceUserId, text: renderCardText(view), blocks: JSON.stringify(renderCard(view)) },
        { token: await token(binding.install_id) },
      );
    },

    async publishPending(): Promise<void> {
      // App Home "My pending" is S2b.
    },

    async sendNote(binding: BindingRef, surfaceUserId: string, text: string, threadRef?: string | null): Promise<void> {
      await slackCall(
        "chat.postEphemeral",
        { channel: binding.conversation_id, user: surfaceUserId, text, thread_ts: threadRef ?? undefined },
        { token: await token(binding.install_id) },
      );
    },

    async permalink(install: SurfaceInstallRef, conversation: string, messageId: string): Promise<string | null> {
      try {
        const r = await slackCall("chat.getPermalink", { channel: conversation, message_ts: messageId }, { token: await token(install.id) });
        return typeof r.permalink === "string" && /^https:\/\//.test(r.permalink) ? r.permalink : null;
      } catch {
        return null;
      }
    },

    async fetchMessages(install: SurfaceInstallRef, method: string, params: Record<string, string>): Promise<FetchedMessage[]> {
      if (method !== "conversations.history" && method !== "conversations.replies") throw new Error("unsupported fetch");
      const r = await slackCall(method, params, { token: await token(install.id) });
      const msgs = Array.isArray(r.messages) ? (r.messages as Array<Record<string, any>>) : [];
      return msgs.map((m) => ({
        id: String(m.ts),
        ts: String(m.ts),
        thread: m.thread_ts ? String(m.thread_ts) : null,
        author: m.user ? String(m.user) : null,
        text: String(m.text ?? ""),
        subtype: m.subtype ? String(m.subtype) : null,
        bot_id: m.bot_id ? String(m.bot_id) : null,
      }));
    },
  };
}
