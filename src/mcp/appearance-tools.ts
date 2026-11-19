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
import { serverAdminAllowed } from "../shared/access.js";
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
      "Reads this server's appearance: the navigation rail color (`nav_color`, null when it is the default), the default, the color in effect, and the text color (black or white) the app draws on it for contrast. Any credential can read it; the color is also public on GET /health (`nav_color`).",
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

/** A tool result plus the HTTP status REST would answer, for the trace row. */
export interface AppearanceToolOutcome {
  result: ToolResult;
  status: 200 | 400 | 403;
}

export async function handleAppearanceTool(
  name: string,
  args: Record<string, any>,
  ctx: { userId: string; nestScope: string | null },
): Promise<AppearanceToolOutcome> {
  const ok = (result: ToolResult): AppearanceToolOutcome => ({ result, status: 200 });
  const refused = (text: string): AppearanceToolOutcome => ({ result: toolError(text, "UNAUTHORIZED_ACTION"), status: 403 });
  const invalid = (text: string): AppearanceToolOutcome => ({ result: toolError(text, "VALIDATION_FAILED"), status: 400 });
  if (name === APPEARANCE_READ_TOOL) {
    const a = currentAppearance();
    return ok({ text: describe(a), data: a });
  }
  if (name === APPEARANCE_UPDATE_TOOL) {
    // The same gate as PATCH /admin/settings.
    const admin = await serverAdminAllowed(ctx.userId);
    if (!admin || ctx.nestScope)
      return refused("Only a server admin can change the navigation color, with a credential that isn't scoped to one nest.");
    if (typeof args.nav_color !== "string")
      return invalid('nav_color is required: a hex color like "#1e40af", or "" for the default.');
    const out = await updateAppearance({ nav_color: args.nav_color });
    if (!out.ok) return invalid(out.fieldErrors.nav_color ?? "Invalid appearance.");
    return ok({ text: `Saved. ${describe(out.appearance)}`, data: out.appearance });
  }
  return invalid(`Unknown appearance tool "${name}".`);
}
