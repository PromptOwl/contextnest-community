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
import { createInstall } from "../surfaces/services/install-store.js";
import { buildManifest } from "../surfaces/adapters/slack/manifest.js";
import { getSettings, updateSettings } from "../surfaces/services/settings-service.js";
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
      "Surfaces status: connected workspace installs, how many conversation bindings are active / paused by the guard / paused by a member / removed, " +
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
    description: "Change a binding's explicit_public_bind / ext_capture_enabled / listener agent; the guard re-runs and may pause it. Admin only.",
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
    name: "context_surfaces_settings_get",
    description: "Read the Surfaces settings (quiet window, window age, buffer TTL, gate minimum, propose threshold, card limits, timezone). Server admin only.",
    inputSchema: { type: "object", properties: {}, required: [] as string[] },
  },
  {
    name: "context_surfaces_settings_update",
    description:
      "Change Surfaces settings. Ranges: quiet_minutes 5–240, window_max_age_hours 1–12 and below buffer_ttl_hours, buffer_ttl_hours 1–24, min_meaningful_chars 1–50, propose_threshold 0.5–0.95. Server admin only.",
    inputSchema: {
      type: "object",
      properties: {
        quiet_minutes: { type: "number" },
        window_max_age_hours: { type: "number" },
        buffer_ttl_hours: { type: "number" },
        min_meaningful_chars: { type: "number" },
        propose_threshold: { type: "number" },
        reviewer_daily_cards: { type: "number" },
        conversation_daily_cards: { type: "number" },
        timezone: { type: "string" },
      },
      required: [] as string[],
    },
  },
  {
    name: "context_surfaces_windows_list",
    description: "The judgement verdict log for this nest: one row per conversation window (verdict, reason, counts, model, cost). Never message text.",
    inputSchema: {
      type: "object",
      properties: {
        binding_id: BINDING_ID,
        verdict: { type: "string", description: "Filter: no_op, proposed, forced, filtered, budget_exhausted, error_schema…" },
      },
      required: [] as string[],
    },
  },
];

export const SURFACES_TOOL_NAMES = new Set(SURFACES_TOOL_DEFINITIONS.map((t) => t.name));

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
      case "context_surfaces_settings_get": {
        await requireOrgAdmin(ctx);
        const settings = await getSettings();
        return { text: JSON.stringify(settings), data: { settings } };
      }
      case "context_surfaces_settings_update": {
        await requireOrgAdmin(ctx);
        const patch: Record<string, unknown> = {};
        for (const k of ["quiet_minutes", "window_max_age_hours", "buffer_ttl_hours", "min_meaningful_chars", "propose_threshold", "reviewer_daily_cards", "conversation_daily_cards", "timezone"]) {
          if (args[k] !== undefined) patch[k] = args[k];
        }
        try {
          const settings = await updateSettings(patch);
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
      default:
        return { text: `Unknown surfaces tool: ${toolName}`, isError: true, data: { code: "VALIDATION_FAILED", message: `Unknown surfaces tool: ${toolName}` } };
    }
  } catch (err) {
    return refusal(err);
  }
}
