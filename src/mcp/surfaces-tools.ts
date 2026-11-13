/**
 * Surfaces over MCP (PRD §5.5 / M11, S1 part): the REST twins of bindings
 * CRUD + preview / recheck / resume, identity links and link reviews.
 *
 * Each tool calls the same service function its REST route calls, so the
 * guard, the 409/422 rules and the admin checks cannot drift. On the per-nest
 * endpoint a binding tool acts on THAT nest only. MCP never commits a
 * proposal for a surface user (§5.5).
 *
 * Gating: advertised only while FEATURE_SURFACES is on, and all are in
 * MCP_ADMIN_TOOLS (offered only to a person who administers the nest); every
 * call re-checks in the service layer (nest admin for bindings, server admin
 * for links and reviews).
 *
 * Inline schemas: Surfaces is Community-only state the engine does not model,
 * so there is no engine descriptor to import (scripts/check-mcp-schemas.mjs
 * baseline raised and documented).
 */
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { surfacesEnabled } from "../surfaces/flags.js";
import {
  GuardRefusedError,
  SERVER_ADMIN_DISCLOSURE,
  bindingView,
  canAdministerNest,
  getBindingRow,
  isOrgAdmin,
  listBindings,
  previewBinding,
  recheckBinding,
  removeBinding,
  resumeBinding,
  updateBinding,
} from "../surfaces/services/binding-service.js";
import {
  clearAutoMatchBlock,
  decideLinkReview,
  getLink,
  listLinkReviews,
  listLinks,
  revokeLink,
} from "../surfaces/services/identity-service.js";
import type { McpToolContext, ToolResult } from "./tools.js";
import { randomBytes } from "crypto";
import { getDb } from "../db/client.js";
import { config } from "../config.js";
import { createBindingWithListener } from "../surfaces/services/listener-service.js";
import { createInstall, getInstall } from "../surfaces/services/install-store.js";
import { listInstallChannels } from "../surfaces/adapters/slack/channels.js";
import { SlackApiError } from "../surfaces/adapters/slack/api.js";
import { buildManifest } from "../surfaces/adapters/slack/manifest.js";
import { getSettings } from "../surfaces/services/settings-service.js";
import { updateSettingsWithEffects } from "../surfaces/services/dm-service.js";
import { listCommits, listProposals } from "../surfaces/services/report-service.js";
import { myPending } from "../surfaces/services/home-service.js";
import { budgetView, getBudget, setCap } from "../surfaces/services/spend-service.js";
import { disconnectInstall } from "../surfaces/services/lifecycle-service.js";
import { SettingsError } from "../surfaces/core/settings.js";
import { listWindows } from "../surfaces/services/report-service.js";

const BINDING_ID = { type: "string", description: "Binding id (context_surfaces_bindings_list shows them)." } as const;
const BIND_FIELDS = {
  install_id: { type: "string", description: "The workspace install the conversation belongs to." },
  conversation_id: { type: "string", description: "The surface's conversation id (Slack channel / DM id)." },
  explicit_public_bind: {
    type: "boolean",
    description: "Public channels only: bind even though people outside the channel read this nest. Never allowed on externally shared channels.",
  },
  ext_capture_enabled: { type: "boolean", description: "Externally shared channel: allow capture (off by default; nest text is never shown there)." },
} as const;

export const SURFACES_TOOL_DEFINITIONS = [
  {
    name: "context_surfaces_status",
    description:
      "Show how many of this nest's conversation bindings are active / paused by the guard / paused by a member / removed, " +
      "and the server-admin disclosure every binding carries. Admin only.",
    inputSchema: { type: "object", properties: {}, required: [] as string[] },
  },
  {
    name: "context_surfaces_bindings_list",
    description:
      "List this nest's conversation bindings (Slack/Teams/email conversation → this nest) with status (active | paused_guard | paused_by_member | removed), " +
      "capture_ok, surface_ok and the counts-only guard detail. Admin only.",
    inputSchema: { type: "object", properties: {}, required: [] as string[] },
  },
  {
    name: "context_surfaces_binding_preview",
    description:
      "Dry-run the binding guard for a conversation and this nest without saving: capture_ok is true only when every reader of the nest is in the " +
      "conversation (or it is an org-public channel bound explicitly). Returns the guard verdict and detail. Admin only.",
    inputSchema: { type: "object", properties: { ...BIND_FIELDS }, required: ["install_id", "conversation_id"] },
  },
  {
    name: "context_surfaces_binding_create",
    description:
      "Bind a conversation to this nest. Refused (with the guard detail) unless capture is safe — every nest reader is in the conversation, " +
      "or it is a public channel bound with explicit_public_bind. Server administrators can read every nest; that is disclosed, not checked. Admin only.",
    inputSchema: { type: "object", properties: { ...BIND_FIELDS }, required: ["install_id", "conversation_id"] },
  },
  {
    name: "context_surfaces_binding_update",
    description: "Change a binding's explicit_public_bind or ext_capture_enabled setting. The guard re-runs and may pause it. Admin only.",
    inputSchema: {
      type: "object",
      properties: {
        binding_id: BINDING_ID,
        explicit_public_bind: BIND_FIELDS.explicit_public_bind,
        ext_capture_enabled: BIND_FIELDS.ext_capture_enabled,
      },
      required: ["binding_id"],
    },
  },
  {
    name: "context_surfaces_binding_delete",
    description: "Unbind a conversation (status removed): capture stops, its buffer is purged and pending cards are withdrawn. Admin only.",
    inputSchema: { type: "object", properties: { binding_id: BINDING_ID }, required: ["binding_id"] },
  },
  {
    name: "context_surfaces_binding_recheck",
    description: "Re-run the guard for a binding now. An active binding whose guard fails is paused (paused_guard). Admin only.",
    inputSchema: { type: "object", properties: { binding_id: BINDING_ID }, required: ["binding_id"] },
  },
  {
    name: "context_surfaces_binding_resume",
    description:
      "Resume a paused binding. Refused while the guard still fails, or — after a member removed Nest — while that member is still in the " +
      "conversation and hasn't agreed to let it back. Admin only.",
    inputSchema: { type: "object", properties: { binding_id: BINDING_ID }, required: ["binding_id"] },
  },
  {
    name: "context_surfaces_links_list",
    description: "List identity links (surface user → Community user): method, status, whether auto-matching is blocked. Server admin only.",
    inputSchema: { type: "object", properties: {}, required: [] as string[] },
  },
  {
    name: "context_surfaces_link_revoke",
    description:
      "Revoke an identity link immediately. The surface user then has to link again through a one-time sign-in link; automatic matching stays " +
      "blocked until an admin clears it (context_surfaces_link_unblock). Server admin only.",
    inputSchema: {
      type: "object",
      properties: { link_id: { type: "string", description: "Link id from context_surfaces_links_list." }, reason: { type: "string", description: "Optional note." } },
      required: ["link_id"],
    },
  },
  {
    name: "context_surfaces_link_unblock",
    description: "Clear auto_match_blocked for a surface user so they may be matched by verified email again. Server admin only.",
    inputSchema: {
      type: "object",
      properties: { install_id: BIND_FIELDS.install_id, surface_user_id: { type: "string", description: "The surface user id." } },
      required: ["install_id", "surface_user_id"],
    },
  },
  {
    name: "context_surfaces_link_reviews_list",
    description: "List one-time links refused because the two identities' emails didn't match, waiting for an admin decision. Server admin only.",
    inputSchema: { type: "object", properties: {}, required: [] as string[] },
  },
  {
    name: "context_surfaces_link_review_decide",
    description: "Approve (creates the link) or deny a pending link review. Server admin only.",
    inputSchema: {
      type: "object",
      properties: {
        review_id: { type: "string", description: "Review id from context_surfaces_link_reviews_list." },
        decision: { type: "string", description: '"approve" or "deny".' },
      },
      required: ["review_id", "decision"],
    },
  },
  {
    name: "context_surfaces_slack_install_create",
    description:
      "Start connecting a Slack workspace (customer-owned app): returns the install id and the app manifest to create the Slack app from. Then save the app's credentials in Surfaces and finish OAuth in a browser. Server admin only.",
    inputSchema: {
      type: "object",
      properties: { home_nest_id: { type: "string", description: "The nest that owns this install (usually this nest)." } },
      required: [] as string[],
    },
  },
  {
    name: "context_surfaces_slack_channels_list",
    description:
      "List the Slack channels a connected install could listen in: only the public and private channels the Nest bot was added to, with privacy, Slack Connect, member count and any existing binding. Never DMs, archived channels or message text. Server admin only.",
    inputSchema: {
      type: "object",
      properties: { install_id: { type: "string", description: "The Slack install id (context_surfaces_status lists installs)." } },
      required: ["install_id"],
    },
  },
  {
    name: "context_surfaces_settings_get",
    description: "Read the Surfaces settings (quiet window, window age, buffer TTL, gate minimum, propose threshold, card limits, timezone, DM capture). Server admin only.",
    inputSchema: { type: "object", properties: {}, required: [] as string[] },
  },
  {
    name: "context_surfaces_settings_update",
    description:
      "Change Surfaces settings. Ranges: quiet_minutes 5–240, window_max_age_hours 1–12 and below buffer_ttl_hours, buffer_ttl_hours 1–24, min_meaningful_chars 1–50, propose_threshold 0.5–0.95. dm_capture (default false) turns DM capture on or off for connected workspaces; turning it off deletes every DM buffer and withdraws pending DM proposals. signin_alerts (default true) sends sealed-nest owners a Slack DM and email on new sign-ins and on sign-in or email configuration changes; turning it off notifies every sealed-nest owner. default_seed is the seed a DM private nest gets; seed_library_nests marks nests as seed libraries. Server admin only.",
    inputSchema: {
      type: "object",
      properties: {
        quiet_minutes: { type: "number", description: "Minutes of quiet that close a conversation window, 5–240 (default 20)." },
        window_max_age_hours: { type: "number", description: "Longest a window stays open in hours, 1–12 and below buffer_ttl_hours (default 6)." },
        buffer_ttl_hours: { type: "number", description: "Hours captured messages are kept, 1–24 (default 24)." },
        min_meaningful_chars: { type: "number", description: "Shortest message that counts as meaningful, in characters, 1–50 (default 6)." },
        propose_threshold: { type: "number", description: "Confidence a proposal needs, 0.5–0.95 (default 0.7)." },
        reviewer_daily_cards: { type: "number", description: "Most proposal cards a reviewer gets a day, 1–10 (default 2)." },
        dm_capture: { type: "boolean", description: "DM capture on (true) or off (false, the default)." },
        signin_alerts: { type: "boolean", description: "Sign-in alerts for sealed-nest owners on (true, the default) or off; turning off notifies every owner." },
        conversation_daily_cards: { type: "number", description: "Most proposal cards a conversation gets a day, 1–20 (default 3)." },
        timezone: { type: "string", description: 'IANA time zone name, e.g. "Europe/Berlin" (default "UTC").' },
        default_seed: { type: "string", description: 'The seed a DM private nest gets: a bundled seed id (default "generic-team"), "<library nest id>:<seed id>", or "" for none.' },
        seed_library_nests: { type: "array", items: { type: "string" }, description: "Nests whose seeds/<id>/seed nodes are offered as seeds (reads still follow each caller's access)." },
      },
      required: [] as string[],
    },
  },
  {
    name: "context_surfaces_windows_list",
    description: "List the judgement verdict log for this nest: one row per conversation window (verdict, reason, counts, model, cost). Never message text.",
    inputSchema: {
      type: "object",
      properties: {
        binding_id: BINDING_ID,
        verdict: { type: "string", description: "Filter: no_op, proposed, forced, filtered, budget_exhausted, error_schema…" },
      },
      required: [] as string[],
    },
  },
  // ─── S2b ─────────────────────────────────────────────────────────────────
  {
    name: "context_surfaces_proposals_list",
    description:
      "List the proposals Nest made from conversations bound to this nest, with their state (posted / held / queued / decided / expired / withdrawn) and per-item outcome. " +
      "Personal (DM) nests are redacted for anyone but their owner. Never message text.",
    inputSchema: { type: "object", properties: { state: { type: "string", description: "Filter by proposal state." } }, required: [] as string[] },
  },
  {
    name: "context_surfaces_my_pending",
    description:
      "List your pending proposals, the ones waiting for a reviewer, only from nests you already read and can review — in threads, held (not posted), and queued for you — " +
      "plus your daily card limit. Approving goes through the existing review tools as you (context_approve / context_reject); MCP never commits for a Slack user.",
    inputSchema: { type: "object", properties: {}, required: [] as string[] },
  },
  {
    name: "context_surfaces_commits_list",
    description:
      "List the commit audit for this nest: every proposal approved from a surface — the approving Community user, the surface, the Slack user id kept for audit, " +
      "the window and its message count, the proposal — proposed by the Nest listener.",
    inputSchema: {
      type: "object",
      properties: { node_id: { type: "string", description: "Only commits of this node." }, proposal_id: { type: "string", description: "Only commits of this proposal." } },
      required: [] as string[],
    },
  },
  {
    name: "context_surfaces_budget_get",
    description: "Show this nest's monthly model-spend budget for Surfaces (cap, spent, reserved, in micros) and whether the 90% / 100% alerts fired. Owner/admin only.",
    inputSchema: { type: "object", properties: {}, required: [] as string[] },
  },
  {
    name: "context_surfaces_budget_update",
    description: "Set this nest's monthly Surfaces model-spend cap in micros ($0–$10,000 → 0–10000000000). Owner/admin only.",
    inputSchema: { type: "object", properties: { cap_micros: { type: "number", description: "The new cap, in micros of a dollar." } }, required: ["cap_micros"] as string[] },
  },
  {
    name: "context_surfaces_binding_invite",
    description:
      "Bring Nest back to a conversation a MEMBER removed it from (the /nest invite twin). You must be a current member of that conversation, linked to it. " +
      "The safety guard is re-checked first; if the member who removed Nest is still there and isn't you, they're asked to agree first. Never resumes a binding paused by the guard, by DM settings, or removed.",
    inputSchema: { type: "object", properties: { binding_id: BINDING_ID }, required: ["binding_id"] as string[] },
  },
  {
    name: "context_surfaces_disconnect",
    description:
      "Disconnect a workspace install: pending cards are marked Withdrawn first, the token is revoked, then secrets, bindings, buffers, drafts and identity links " +
      "for it are deleted. Approved nodes and the commit audit stay. Server administrators only.",
    inputSchema: { type: "object", properties: { install_id: { type: "string", description: "The install to disconnect. Each binding from context_surfaces_bindings_list carries its install_id." } }, required: ["install_id"] as string[] },
  },
  {
    name: "context_surfaces_seed_apply",
    description:
      "Apply a seed to this nest (the POST /surfaces/seeds/apply twin): its folders, documents, CONTEXT.md, glossary definitions and thesis, and the listener settings " +
      "(folders it proposes into, domain tags, never-propose categories) for every conversation bound here. Idempotent: anything a person edited is kept (kept_human_edit); " +
      "a newer seed version updates untouched items only with upgrade: true. With an org-mirror layer it also proposes people and areas from bound conversations, as reviews. " +
      "On a nest that holds agent writes for confirmation, only an allowlisted credential may apply. dry_run: true previews without writing. Owner/admin only, on your own full credential.",
    inputSchema: {
      type: "object",
      properties: {
        seed_id: { type: "string", description: "The seed id (context_surfaces_seed_list shows them)." },
        library_nest_id: { type: "string", description: "Apply the seed from this seed-library nest instead of the bundled one." },
        upgrade: { type: "boolean", description: "Update untouched seeded items to a newer seed version (default false)." },
        dry_run: { type: "boolean", description: "Return what would be written (each item's planned action, title and an excerpt) and write nothing." },
      },
      required: ["seed_id"] as string[],
    },
  },
  {
    name: "context_surfaces_seed_list",
    description: "List the seeds you can apply to this nest: the bundled ones, and seeds in seed-library nests you can read. Owner/admin only.",
    inputSchema: { type: "object", properties: {}, required: [] as string[] },
  },
  {
    name: "context_surfaces_seed_status",
    description: "List the seeds this nest has applied (id, version, source). no_seed = true means its conversations propose nowhere yet. Owner/admin only.",
    inputSchema: { type: "object", properties: {}, required: [] as string[] },
  },
];

export const SURFACES_TOOL_NAMES = new Set(SURFACES_TOOL_DEFINITIONS.map((t) => t.name));
/** Every Surfaces tool but My pending (any reviewer may read their own) is admin-gated. */
export const SURFACES_ADMIN_TOOL_NAMES = new Set(
  [...SURFACES_TOOL_NAMES].filter((n) => n !== "context_surfaces_my_pending" && n !== "context_surfaces_binding_invite"),
);
/** Read-only Surfaces tools a read-only key is offered. */
export const SURFACES_READ_TOOL_NAMES = ["context_surfaces_my_pending", "context_surfaces_proposals_list", "context_surfaces_commits_list", "context_surfaces_budget_get"];

export function isSurfacesTool(name: string): boolean {
  return SURFACES_TOOL_NAMES.has(name);
}

function optBool(v: unknown, field: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new ValidationError(`${field} must be true or false`);
  return v;
}
function reqStr(v: unknown, field: string): string {
  if (typeof v !== "string" || !v) throw new ValidationError(`${field} is required`);
  return v;
}

async function bindingInNest(id: string, ctx: McpToolContext) {
  const row = await getBindingRow(id);
  if (!row || row.nest_id !== ctx.nestId) throw new NotFoundError("Binding not found in this nest");
  return row;
}

/** Org-level identity actions: a server admin on their own full credential —
 *  never a nest-scoped or read-only key (M2; the same credential rule as
 *  org contributions, credentialMayContribute). */
async function requireOrgAdmin(ctx: McpToolContext) {
  if (ctx.contributorCredential !== true) {
    throw new ForbiddenError("Identity links can only be managed with your own full credential, not a nest-scoped or read-only key.");
  }
  if (!(await isOrgAdmin(ctx.userId))) throw new ForbiddenError("Server administrators only.");
}

/** The listener is created server-side; a client can never name one (M3). */
function refuseListener(args: Record<string, any>) {
  if (args.listener_agent_node_id !== undefined && args.listener_agent_node_id !== null) {
    throw new ValidationError("listener_agent_node_id is set by the server for the binding's own listener; it can't be supplied.");
  }
}

function refusal(err: unknown): ToolResult {
  if (err instanceof GuardRefusedError) {
    return {
      text: `${err.message}\n\nGuard: ${JSON.stringify(err.guard.detail)}`,
      isError: true,
      data: { code: "CONFLICT", message: err.message, guard: err.guard },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err instanceof ForbiddenError ? "FORBIDDEN" : err instanceof NotFoundError ? "NOT_FOUND" : err instanceof AppError && err.statusCode === 409 ? "CONFLICT" : "VALIDATION_FAILED";
  if (!(err instanceof AppError)) throw err;
  return { text: message, isError: true, data: { code, message } };
}

export async function runSurfacesTool(toolName: string, args: Record<string, any>, ctx: McpToolContext): Promise<ToolResult> {
  try {
    if (!surfacesEnabled()) throw new ForbiddenError("Surfaces is not enabled on this server.");
    const bindArgs = () => {
      refuseListener(args);
      return {
        actorUserId: ctx.userId,
        installId: reqStr(args.install_id, "install_id"),
        conversationId: reqStr(args.conversation_id, "conversation_id"),
        nestId: ctx.nestId,
        explicitPublicBind: optBool(args.explicit_public_bind, "explicit_public_bind"),
        extCaptureEnabled: optBool(args.ext_capture_enabled, "ext_capture_enabled"),
      };
    };
    switch (toolName) {
      case "context_surfaces_status": {
        if (!(await canAdministerNest(ctx.nestId, ctx.userId))) throw new ForbiddenError("Owner/admin only.");
        const bindings = await listBindings(ctx.userId, { nestId: ctx.nestId });
        const count = (s: string) => bindings.filter((b) => b.status === s).length;
        const data = {
          bindings: { total: bindings.length, active: count("active"), paused_guard: count("paused_guard"), paused_by_member: count("paused_by_member"), removed: count("removed") },
          disclosure: SERVER_ADMIN_DISCLOSURE,
        };
        return { text: `${JSON.stringify(data.bindings)}\n${SERVER_ADMIN_DISCLOSURE}`, data };
      }
      case "context_surfaces_bindings_list": {
        if (!(await canAdministerNest(ctx.nestId, ctx.userId))) throw new ForbiddenError("Owner/admin only.");
        const bindings = await listBindings(ctx.userId, { nestId: ctx.nestId });
        const lines = bindings.map((b) => `- ${b.id}: ${b.conversation_id} (${b.conversation_kind}) — ${b.status}, capture_ok=${b.capture_ok}, surface_ok=${b.surface_ok}`);
        return { text: bindings.length ? lines.join("\n") : "No conversation bindings on this nest.", data: { bindings } };
      }
      case "context_surfaces_binding_preview": {
        const out = await previewBinding(bindArgs());
        return { text: `Dry run — nothing saved. capture_ok=${out.guard.capture_ok}, surface_ok=${out.guard.surface_ok}`, data: out };
      }
      case "context_surfaces_binding_create": {
        const out = await createBindingWithListener(bindArgs());
        return { text: `Bound ${out.binding.conversation_id} → this nest (${out.binding.status}). ${SERVER_ADMIN_DISCLOSURE}`, data: out };
      }
      case "context_surfaces_binding_update": {
        refuseListener(args);
        const row = await bindingInNest(reqStr(args.binding_id, "binding_id"), ctx);
        const out = await updateBinding(row.id, ctx.userId, {
          explicitPublicBind: optBool(args.explicit_public_bind, "explicit_public_bind"),
          extCaptureEnabled: optBool(args.ext_capture_enabled, "ext_capture_enabled"),
        });
        return { text: `Updated ${row.id}: ${out.binding.status}.`, data: out };
      }
      case "context_surfaces_binding_delete": {
        const row = await bindingInNest(reqStr(args.binding_id, "binding_id"), ctx);
        const out = await removeBinding(row.id, ctx.userId);
        return { text: `Removed ${row.id}.`, data: out };
      }
      case "context_surfaces_binding_recheck": {
        const row = await bindingInNest(reqStr(args.binding_id, "binding_id"), ctx);
        if (!(await canAdministerNest(row.nest_id, ctx.userId))) throw new ForbiddenError("Owner/admin only.");
        const binding = await bindingView(await recheckBinding(row.id));
        return { text: `Re-checked ${row.id}: ${binding.status}, capture_ok=${binding.capture_ok}.`, data: { binding } };
      }
      case "context_surfaces_binding_resume": {
        const row = await bindingInNest(reqStr(args.binding_id, "binding_id"), ctx);
        const out = await resumeBinding(row.id, ctx.userId);
        return { text: `Resumed ${row.id}.`, data: out };
      }
      case "context_surfaces_links_list": {
        await requireOrgAdmin(ctx);
        const links = await listLinks();
        return { text: links.map((l) => `- ${l.id}: ${l.surface}:${l.surface_user_id} → ${l.community_user_id} (${l.method}, ${l.status})`).join("\n") || "No links.", data: { links } };
      }
      case "context_surfaces_link_revoke": {
        await requireOrgAdmin(ctx);
        const link = await getLink(reqStr(args.link_id, "link_id"));
        if (!link) throw new NotFoundError("Link not found");
        const out = await revokeLink({ linkId: link.id, byUserId: ctx.userId, reason: typeof args.reason === "string" ? args.reason : null });
        return { text: `Revoked ${link.id}.`, data: { link: out } };
      }
      case "context_surfaces_link_unblock": {
        await requireOrgAdmin(ctx);
        const n = await clearAutoMatchBlock(reqStr(args.install_id, "install_id"), reqStr(args.surface_user_id, "surface_user_id"));
        return { text: `Cleared ${n} block(s).`, data: { cleared: n } };
      }
      case "context_surfaces_link_reviews_list": {
        await requireOrgAdmin(ctx);
        const reviews = await listLinkReviews("pending");
        return { text: `${reviews.length} pending review(s).`, data: { reviews } };
      }
      case "context_surfaces_link_review_decide": {
        await requireOrgAdmin(ctx);
        const decision = reqStr(args.decision, "decision");
        if (decision !== "approve" && decision !== "deny") throw new ValidationError('decision must be "approve" or "deny"');
        const out = await decideLinkReview({ reviewId: reqStr(args.review_id, "review_id"), decision, byUserId: ctx.userId });
        return { text: `Review ${decision === "approve" ? "approved" : "denied"}.`, data: out };
      }
      case "context_surfaces_slack_install_create": {
        await requireOrgAdmin(ctx);
        const nestId = typeof args.home_nest_id === "string" && args.home_nest_id ? args.home_nest_id : ctx.nestId;
        if (!(await getDb().get("SELECT 1 AS x FROM nests WHERE id = ?", [nestId]))) throw new ValidationError("home_nest_id must name a nest");
        const install = await createInstall({ surface: "slack", mode: "manifest", tenantKey: `pending:${randomBytes(8).toString("hex")}`, homeNestId: nestId, installedByUserId: ctx.userId });
        const manifest = buildManifest({ baseUrl: config.PUBLIC_BASE_URL, installId: install.id });
        return { text: `Install ${install.id} created. Create the Slack app from the manifest, then save its credentials in Surfaces.`, data: { install_id: install.id, manifest } };
      }
      case "context_surfaces_slack_channels_list": {
        await requireOrgAdmin(ctx);
        const install = await getInstall(reqStr(args.install_id, "install_id"));
        if (!install || install.surface !== "slack") throw new NotFoundError("Install not found");
        if (install.status !== "active") throw new AppError(409, "Finish connecting Slack first: this install isn't active yet.");
        const out = await listInstallChannels(install).catch((err) => {
          if (err instanceof SlackApiError) throw new AppError(502, `Slack refused the channel list (${err.code}).`);
          throw err;
        });
        return { text: out.channels.map((ch) => `${ch.is_private ? "private" : "public"} ${ch.id} ${ch.name ?? ""}${ch.binding ? ` (bound: ${ch.binding.status})` : ""}`).join("\n") || "The bot isn't in any channel yet. Add it to a channel in Slack first.", data: out };
      }
      case "context_surfaces_settings_get": {
        await requireOrgAdmin(ctx);
        const settings = await getSettings();
        return { text: JSON.stringify(settings), data: { settings } };
      }
      case "context_surfaces_settings_update": {
        await requireOrgAdmin(ctx);
        const patch: Record<string, unknown> = {};
        for (const k of ["quiet_minutes", "window_max_age_hours", "buffer_ttl_hours", "min_meaningful_chars", "propose_threshold", "reviewer_daily_cards", "conversation_daily_cards", "timezone", "dm_capture", "signin_alerts", "default_seed", "seed_library_nests"]) {
          if (args[k] !== undefined) patch[k] = args[k];
        }
        try {
          const settings = await updateSettingsWithEffects(patch, ctx.userId);
          return { text: `Saved. ${JSON.stringify(settings)}`, data: { settings } };
        } catch (err) {
          if (err instanceof SettingsError) throw new ValidationError(err.message);
          throw err;
        }
      }
      case "context_surfaces_windows_list": {
        if (!(await canAdministerNest(ctx.nestId, ctx.userId))) throw new ForbiddenError("Owner/admin only.");
        const windows = await listWindows(ctx.userId, {
          nestId: ctx.nestId,
          bindingId: typeof args.binding_id === "string" ? args.binding_id : undefined,
          verdict: typeof args.verdict === "string" ? args.verdict : undefined,
        });
        return { text: `${windows.length} window(s).`, data: { windows } };
      }
      case "context_surfaces_proposals_list": {
        if (!(await canAdministerNest(ctx.nestId, ctx.userId))) throw new ForbiddenError("Owner/admin only.");
        const proposals = await listProposals(ctx.userId, { nestId: ctx.nestId, state: typeof args.state === "string" ? args.state : undefined });
        return { text: `${proposals.length} proposal(s).`, data: { proposals } };
      }
      case "context_surfaces_my_pending": {
        const mine = await myPending(ctx.userId, { nestId: ctx.nestId });
        return {
          text: `In threads: ${mine.in_thread.length} · not posted: ${mine.held.length} · queued for you: ${mine.queued.length} · ${mine.used_today} of your ${mine.daily_limit} cards today.`,
          data: mine,
        };
      }
      case "context_surfaces_commits_list": {
        if (!(await canAdministerNest(ctx.nestId, ctx.userId))) throw new ForbiddenError("Owner/admin only.");
        const commits = await listCommits(ctx.userId, {
          nestId: ctx.nestId,
          nodeId: typeof args.node_id === "string" ? args.node_id : undefined,
          proposalId: typeof args.proposal_id === "string" ? args.proposal_id : undefined,
        });
        return { text: `${commits.length} commit(s).`, data: { commits } };
      }
      case "context_surfaces_budget_get": {
        if (!(await canAdministerNest(ctx.nestId, ctx.userId))) throw new ForbiddenError("Owner/admin only.");
        const budget = budgetView(await getBudget(ctx.nestId));
        return { text: JSON.stringify(budget), data: { budget } };
      }
      case "context_surfaces_budget_update": {
        if (!(await canAdministerNest(ctx.nestId, ctx.userId))) throw new ForbiddenError("Owner/admin only.");
        try {
          const budget = await setCap(ctx.nestId, args.cap_micros);
          return { text: `Saved. ${JSON.stringify(budget)}`, data: { budget } };
        } catch (err) {
          if (err instanceof SettingsError) throw new ValidationError(err.message);
          throw err;
        }
      }
      case "context_surfaces_binding_invite": {
        // People only (re-review INFO): never an agent / scoped / read-only key.
        if (ctx.contributorCredential !== true) throw new ForbiddenError("Inviting Nest back needs your own full credential, not an agent or scoped key.");
        const row = await bindingInNest(reqStr(args.binding_id, "binding_id"), ctx);
        const { inviteBackAsUser } = await import("../surfaces/services/invite-service.js");
        const out = await inviteBackAsUser(row.id, ctx.userId);
        const after = await getBindingRow(row.id);
        if (!out.ok) return { text: out.message, isError: true, data: { code: out.reason === "not_member" ? "FORBIDDEN" : "CONFLICT", message: out.message } };
        return { text: `${out.message} (${after?.status ?? "unknown"})`, data: { status: out.status, binding_status: after?.status ?? null } };
      }
      case "context_surfaces_disconnect": {
        await requireOrgAdmin(ctx);
        const out = await disconnectInstall(reqStr(args.install_id, "install_id"));
        return { text: `Disconnected. ${out.withdrawn} pending proposal item(s) withdrawn. Approved nodes and the commit audit stay.`, data: { disconnected: true, ...out } };
      }
      case "context_surfaces_seed_apply": {
        // People only, never a read-only, scoped or system key (the REST rule).
        if (ctx.contributorCredential !== true) throw new ForbiddenError("Applying a seed needs your own full credential, not a nest-scoped, read-only or system key.");
        const { applySeed } = await import("../surfaces/services/seed-service.js");
        if (args.upgrade !== undefined && typeof args.upgrade !== "boolean") throw new ValidationError("upgrade must be true or false");
        if (args.dry_run !== undefined && typeof args.dry_run !== "boolean") throw new ValidationError("dry_run must be true or false");
        if (args.library_nest_id !== undefined && args.library_nest_id !== null && typeof args.library_nest_id !== "string") throw new ValidationError("library_nest_id must be a string");
        const out = await applySeed({
          nestId: ctx.nestId,
          seedId: reqStr(args.seed_id, "seed_id"),
          libraryNestId: args.library_nest_id || null,
          upgrade: args.upgrade === true,
          dryRun: args.dry_run === true,
          actorUserId: ctx.userId,
          // MCP is an agent surface whatever it authenticated with (S7-R2 M1).
          credential: { keyId: ctx.apiKeyId ?? null, agentSurface: true },
        });
        const kept = out.items.filter((i) => i.action === "kept_human_edit").length;
        return { text: `Seed ${out.seed.id}@${out.seed.version}: ${out.status}. ${out.items.length} item(s), ${kept} kept as people edited them.`, data: out };
      }
      case "context_surfaces_seed_list": {
        const { listSeedsForNest } = await import("../surfaces/services/seed-service.js");
        const seeds = await listSeedsForNest(ctx.nestId, ctx.userId);
        return { text: seeds.map((s) => `- ${s.id}@${s.version} (${s.source}): ${s.title}`).join("\n") || "No seeds available.", data: { seeds } };
      }
      case "context_surfaces_seed_status": {
        const { seedStatus } = await import("../surfaces/services/seed-service.js");
        const status = await seedStatus(ctx.nestId, ctx.userId);
        return { text: status.no_seed ? "No seed applied: conversations bound here propose nowhere yet." : status.applied.map((a) => `${a.seed_id}@${a.version}`).join(", "), data: status };
      }
      default:
        return { text: `Unknown surfaces tool: ${toolName}`, isError: true, data: { code: "VALIDATION_FAILED", message: `Unknown surfaces tool: ${toolName}` } };
    }
  } catch (err) {
    return refusal(err);
  }
}
