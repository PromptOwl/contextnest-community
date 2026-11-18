/**
 * The model route over MCP (po-1419): read and change whether a failing own
 * model key falls back to PromptOwl's licence gateway. The twins of the
 * `model_fallback_promptowl` field on GET / PATCH /admin/settings, on the
 * same setting (MODEL_FALLBACK_PROMPTOWL, persisted like every server
 * setting), so an agent and the Settings page see one value.
 *
 * Community-only: a server setting the engine does not model, so there is no
 * engine descriptor to import (see scripts/check-mcp-schemas.mjs).
 *
 * Server admins only, on their own full credential: never a nest-scoped or
 * read-only key (the same rule as the Surfaces org-level tools).
 */
import { ForbiddenError, ValidationError } from "../shared/errors.js";
import { isOrgAdmin } from "../surfaces/services/binding-service.js";
import { persistSetting } from "../db/settings.js";
import { modelRouteSettings } from "../shared/model-route.js";
import type { McpToolContext, ToolResult } from "./tools.js";

export const MODEL_ROUTE_TOOL_DEFINITIONS = [
  {
    name: "context_model_route_get",
    description:
      "Read this server's model route: whether a failing own model key (a nest's key or the server's own gateway) falls back to PromptOwl's licence gateway (model_fallback_promptowl, default on), whether the licence has a gateway to fall back to (model_fallback_available), and which key model calls use first (model_source: own or promptowl). Mirrors GET /admin/settings. Server admin only.",
    inputSchema: { type: "object" as const, properties: {}, required: [] as string[] },
  },
  {
    name: "context_model_route_update",
    description:
      "Turn the fallback to PromptOwl's gateway on or off. On (the default): a model call on an own key that fails for billing/out of credit, a refused key (401/403), a rate limit, a 5xx or no connection is retried once on PromptOwl's licence gateway and metered in credits; a request-shaped 400 never falls back, and the own key is never sent to PromptOwl. Off: a failing own key fails, and no content goes to PromptOwl (air-gapped, data residency). Mirrors PATCH /admin/settings {model_fallback_promptowl}. Server admin only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        model_fallback_promptowl: { type: "boolean", description: "true = fall back to PromptOwl's gateway (default); false = never." },
      },
      required: ["model_fallback_promptowl"],
    },
  },
];

export const MODEL_ROUTE_TOOL_NAMES = MODEL_ROUTE_TOOL_DEFINITIONS.map((t) => t.name);

export function isModelRouteTool(name: string): boolean {
  return MODEL_ROUTE_TOOL_NAMES.includes(name);
}

async function requireServerAdmin(ctx: McpToolContext): Promise<void> {
  if (ctx.contributorCredential !== true) {
    throw new ForbiddenError("The model route can only be changed with your own full credential, not a nest-scoped or read-only key.");
  }
  if (!(await isOrgAdmin(ctx.userId))) throw new ForbiddenError("Server administrators only.");
}

export async function runModelRouteTool(toolName: string, args: Record<string, unknown>, ctx: McpToolContext): Promise<ToolResult> {
  await requireServerAdmin(ctx);
  if (toolName === "context_model_route_update") {
    const on = args.model_fallback_promptowl;
    if (typeof on !== "boolean") throw new ValidationError("model_fallback_promptowl must be true or false");
    const value = on ? "true" : "false";
    await persistSetting("MODEL_FALLBACK_PROMPTOWL", value);
    process.env.MODEL_FALLBACK_PROMPTOWL = value;
  }
  const settings = modelRouteSettings();
  const text = `Fallback to PromptOwl's gateway: ${settings.model_fallback_promptowl ? "on" : "off"}` +
    (settings.model_fallback_available ? "" : " (this licence has no PromptOwl gateway, so it has nothing to fall back to)") +
    `. Model calls use ${settings.model_source ?? "no key"} first.`;
  return { text, data: settings };
}
