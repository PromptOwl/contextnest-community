/**
 * Server appearance over MCP (PO-1430), at parity with the REST surface:
 *
 *   context_appearance         read   the navigation rail color — GET /health
 *                                     `nav_color`, plus the default and the
 *                                     readable text color the UI derives
 *   context_appearance_update  write  set or reset it — PATCH /admin/settings
 *                                     `nav_color`, server admin only
 *
 * Server-level /mcp only: the color is the deployment's, not a nest's. Both
 * tools call the same functions as REST (src/shared/appearance.ts), so they
 * accept and refuse the same values.
 *
 * Schemas are generated from zod (mcpInputSchema), so src/mcp/ gains no
 * inline schema literal (lint:mcp-schemas, no baseline raise). Community-only:
 * server settings are this edition's state, which the engine does not model.
 */
import { config } from "../config.js";
import { isServerAdminUserId } from "../shared/access.js";
import {
  AppearanceReadInput,
  AppearanceUpdateInput,
  currentAppearance,
  updateAppearance,
  type Appearance,
} from "../shared/appearance.js";
import { mcpInputSchema } from "../workflow/agent-event-schema.js";
import { toolError, type ToolResult } from "./tools.js";

export const APPEARANCE_READ_TOOL = "context_appearance";
export const APPEARANCE_UPDATE_TOOL = "context_appearance_update";

export const APPEARANCE_TOOL_DEFINITIONS = [
  {
    name: APPEARANCE_READ_TOOL,
    description:
      "Reads this server's appearance: the navigation rail color (`nav_color`, null when it is the default), the default, the color in effect, and the text color (black or white) the app draws on it for contrast. Anyone signed in can read it.",
    inputSchema: mcpInputSchema(AppearanceReadInput),
  },
  {
    name: APPEARANCE_UPDATE_TOOL,
    description:
      "Sets the navigation rail color for everyone on this server (server admin only). Give a hex color; text, icon, hover and border colors are derived from it so they stay readable. An empty string restores the default navy. Same rules as PATCH /admin/settings `nav_color`.",
    inputSchema: mcpInputSchema(AppearanceUpdateInput),
  },
];

export const APPEARANCE_TOOL_NAMES = new Set(APPEARANCE_TOOL_DEFINITIONS.map((t) => t.name));
export const APPEARANCE_READ_TOOL_NAMES = [APPEARANCE_READ_TOOL];

function describe(a: Appearance): string {
  return a.nav_color
    ? `Navigation color: ${a.nav_color} (text ${a.foreground === "#ffffff" ? "white" : "black"}). The default is ${a.default_nav_color}.`
    : `Navigation color: the default (${a.default_nav_color}). No custom color is set.`;
}

export async function handleAppearanceTool(
  name: string,
  args: Record<string, any>,
  ctx: { userId: string; nestScope: string | null },
): Promise<ToolResult> {
  if (name === APPEARANCE_READ_TOOL) {
    const a = currentAppearance();
    return { text: describe(a), data: a };
  }
  if (name === APPEARANCE_UPDATE_TOOL) {
    // The same gate as PATCH /admin/settings (serverAdminAllowed in app.ts).
    const admin = config.AUTH_MODE === "open" || (await isServerAdminUserId(ctx.userId));
    if (!admin || ctx.nestScope)
      return toolError("Only a server admin can change the navigation color, with a credential that isn't scoped to one nest.", "UNAUTHORIZED_ACTION");
    if (typeof args.nav_color !== "string")
      return toolError('nav_color is required: a hex color like "#1e40af", or "" for the default.', "VALIDATION_FAILED");
    const out = await updateAppearance({ nav_color: args.nav_color });
    if (!out.ok) return toolError(out.fieldErrors.nav_color ?? "Invalid appearance.", "VALIDATION_FAILED");
    return { text: `Saved. ${describe(out.appearance)}`, data: out.appearance };
  }
  return toolError(`Unknown appearance tool "${name}".`, "VALIDATION_FAILED");
}
