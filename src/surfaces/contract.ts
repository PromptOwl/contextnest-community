/**
 * Surfaces connector contract (PRD M10, §5.2). Slack, Teams and email each
 * implement `SurfaceConnector`; the judgement pipeline, the binding guard and
 * the commit path depend only on these types, never on an adapter.
 *
 * Types (plus one error class) — no imports — so `core/` can import it and stay pure.
 */

export type Surface = "slack" | "teams" | "email";

export type ConversationKind =
  | "public_channel"
  | "private_channel"
  | "dm"
  | "teams_standard"
  | "teams_chat"
  | "email_address";

/** What a connector needs to know about the install it is acting for. */
export interface SurfaceInstallRef {
  id: string;
  surface: Surface;
  tenant_key: string;
  team_id: string | null;
  enterprise_id: string | null;
  bot_user_id: string | null;
}

/** The binding a card is posted into. */
export interface BindingRef {
  id: string;
  install_id: string;
  conversation_id: string;
  nest_id: string;
}

export interface SurfaceAuthor {
  id: string;
  is_bot: boolean;
  is_guest: boolean;
  is_external: boolean;
}

export interface SurfaceMessage {
  surface: Surface;
  /** tenant_key of the install (Slack team, Teams tenant, email address). */
  workspace: string;
  conversation: string;
  thread: string | null;
  author: SurfaceAuthor;
  text: string;
  ts: string;
  kind: "message" | "edit" | "delete" | "explicit_ask" | "optout";
  /** The surface's own message id (Slack ts). Defaults to `ts`. */
  id?: string;
  /** Surface subtype (Slack `subtype`), for the gate's G3. */
  subtype?: string | null;
  /** Set when an integration/bot posted it (Slack `bot_id`). */
  bot_id?: string | null;
  /** Explicit asks: what the ask points at (a reacted-to message, or the
   *  thread a mention was made in) and how it was asked. */
  target?: { id: string; author: string | null; thread: string | null } | null;
  ask_via?: "reaction" | "mention" | "dm";
  /** S2b: the message was sent in a 1:1 DM with the bot (Slack channel_type "im"). */
  dm?: boolean;
}

/** Membership / lifecycle events that feed the guard re-check (§4.17). */
export interface SurfaceSignal {
  surface: Surface;
  workspace: string;
  kind:
    | "member_joined"
    | "member_left"
    | "conversation_shared"
    | "conversation_unshared"
    | "conversation_archived"
    | "conversation_deleted"
    | "bot_removed"
    | "user_change"
    | "uninstalled"
    | "tokens_revoked";
  conversation?: string;
  user?: string;
}

export interface SurfaceMember {
  surface_user_id: string;
  is_guest: boolean;
  is_external: boolean;
  is_bot: boolean;
  home_tenant: string | null;
}

export interface ConversationInfo {
  id: string;
  name?: string | null;
  kind: ConversationKind;
  is_private: boolean;
  is_ext_shared: boolean;
  /** Slack is_general / org-wide default; Teams General (§12 R3). */
  is_general: boolean;
  /** False when the surface can't enumerate it (Teams private/shared
   *  channels, Grid multi-workspace channels, MPIMs) — fails the guard closed. */
  enumerable: boolean;
}

/**
 * `known:true` only with every page fetched (`complete: true`). Anything else
 * — an error, a denial, a partial page — is `known:false` (AC-CON-02).
 */
export type MembersResult =
  | { known: true; complete: true; members: SurfaceMember[]; conversation: ConversationInfo }
  | { known: false; reason: string };

/** A surface user's profile, as needed by the §4.11 auto-match rules. */
export interface SurfaceUserProfile {
  surface_user_id: string;
  home_team_id: string | null;
  enterprise_id: string | null;
  email: string | null;
  /** Slack is_email_confirmed. null = unknown → auto-match fails closed. */
  email_confirmed: boolean | null;
  is_restricted: boolean;
  is_ultra_restricted: boolean;
  is_stranger: boolean;
  is_bot: boolean;
  deleted: boolean;
  /** Teams userRole ("guest" never auto-matches). */
  user_role: string | null;
  display_name: string | null;
}

export type CardKind = "single" | "merged" | "conflict" | "agent" | "agent_answer";

/** Surface-neutral card. Everything outside `nest_sourced` is derived from
 *  the conversation window or from binding metadata (§4.10 "uses of flags"). */
export interface ProposalView {
  proposal_id: string;
  kind: CardKind;
  title: string;
  summary: string;
  folder: string;
  nest_name: string;
  draft_url: string;
  disclosure?: string;
  outcome?: string;
  /** Extra context line, e.g. "Previously not kept on <date>". */
  note?: string;
  /** Post in this thread (Slack thread_ts) when set. */
  thread_ref?: string | null;
  /** Strings read from the nest. Posted only when surface_ok. */
  nest_sourced?: {
    on_record?: string;
    existing_node_quote?: string;
    existing_agent_config?: string;
    agent_answer?: string;
  };
  /** S2b: the full interactive card (core/card-model.ts CardModel). Typed
   *  loosely here so this module keeps no imports; adapters render it. */
  card?: unknown;
}

export interface CardRef {
  surface: Surface;
  conversation: string;
  message_ref: string;
}

export type VerifyResult = { ok: true; install_id: string } | { ok: false; status: number };

export interface SurfaceConnector {
  readonly surface: Surface;
  /** Signature / JWT / provider auth; constant-time compare; replay window. */
  verify(request: Request): Promise<VerifyResult>;
  normalize(event: unknown): SurfaceMessage[] | SurfaceSignal;
  members(install: SurfaceInstallRef, conversation: string): Promise<MembersResult>;
  /** Profile lookup for auto-match (Slack users.info, Teams member API). */
  userProfile(install: SurfaceInstallRef, surfaceUserId: string): Promise<SurfaceUserProfile | null>;
  /** Idempotent per view.proposal_id. */
  postProposal(binding: BindingRef, view: ProposalView): Promise<CardRef>;
  updateProposal(ref: CardRef, view: ProposalView): Promise<void>;
  /** S2b security round M1: last-resort removal of a card that can't be redacted. */
  deleteProposal?(install: SurfaceInstallRef, ref: CardRef): Promise<void>;
  /** Link, else auto-match (§4.11) — adapters delegate to the identity service. */
  resolveIdentity(install: SurfaceInstallRef, surfaceUserId: string): Promise<string | null>;
  sendPrivate(binding: BindingRef, surfaceUserId: string, view: ProposalView): Promise<void>;
  publishPending(install: SurfaceInstallRef, surfaceUserId: string, items: unknown[]): Promise<void>;
  /** A short private status/refusal line to one person (Slack ephemeral). */
  sendNote?(binding: BindingRef, surfaceUserId: string, text: string, threadRef?: string | null): Promise<void>;
  /** S2b: a plain bot message in the conversation (the one-time enable notice, DM replies). */
  postNotice?(binding: BindingRef, text: string): Promise<void>;
  /** S2b: open a direct message with a user and post `text` (DM-capture notices). */
  sendDirect?(install: SurfaceInstallRef, surfaceUserId: string, text: string, channel?: string | null): Promise<void>;
  /** A stable link to a message (Slack chat.getPermalink); null if unavailable. */
  permalink?(install: SurfaceInstallRef, conversation: string, messageId: string): Promise<string | null>;
  /** Explicit-ask fetch (§4.3): one rate-aware history/replies call. */
  fetchMessages?(install: SurfaceInstallRef, method: string, params: Record<string, string>): Promise<FetchedMessage[]>;
}

export interface FetchedMessage {
  id: string;
  ts: string;
  thread: string | null;
  author: string | null;
  text: string;
  subtype: string | null;
  bot_id: string | null;
}

/** Thrown by a connector call the surface rate-limited; the caller retries after. */
export class SurfaceRateLimited extends Error {
  constructor(public readonly retryAfterSec: number) {
    super("rate limited");
  }
}

/** Every method a conforming connector must implement (§5.2 + userProfile). */
export const CONNECTOR_METHODS = [
  "verify",
  "normalize",
  "members",
  "userProfile",
  "postProposal",
  "updateProposal",
  "resolveIdentity",
  "sendPrivate",
  "publishPending",
] as const;
