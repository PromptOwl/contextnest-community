/**
 * MCP surface for Nest Plugins (Slice A, CU-wdqcq05raz) — at parity with the
 * REST routes (src/plugins/routes.ts) because both call the same service layer
 * (src/plugins/service.ts), which makes every permission decision.
 *
 *   context_plugins           read tier: list (config + recent runs) | runs
 *   context_plugin_run        write tier: run a plugin's pull now
 *   context_plugin_configure  nest owner/admin: configure | remove
 *
 * Registered only when FEATURE_PLUGINS is on (mcp/routes.ts), mirroring the
 * REST 404. Inline schemas: these are server-registry operations with no
 * engine descriptor to import (the engine's `sync` ops take settings per call;
 * here they are stored per nest) — see the baseline note in
 * scripts/check-mcp-schemas.mjs.
 */
import { AppError, ValidationError } from "../shared/errors.js";
import type { McpToolContext, ToolResult } from "./tools.js";
import {
  configurePlugin,
  listNestPlugins,
  listPluginRuns,
  removePlugin,
  runPluginNow,
  type Caller,
  type PluginDescription,
} from "../plugins/service.js";

export const PLUGIN_TOOL_DEFINITIONS = [
  {
    name: "context_plugins",
    description:
      "Nest Plugins on this nest — connectors (GitHub, Gong, Slack, email…) that pull outside sources into governed nodes. action: list (default) — every plugin this server loaded, with this nest's config (secrets shown only as set/unset), its system identity and recent runs | runs (plugin) — the run ledger. Error text from a failed run is shown only to editors.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["list", "runs"], description: "What to read. Default list." },
        plugin: { type: "string", description: "Plugin name (runs)." },
      },
    },
  },
  {
    name: "context_plugin_run",
    description:
      "Run a Nest Plugin's pull now on this nest (editors). Items land through the nest's normal write path as the plugin's own system identity: enforced structure rules apply, a governed nest sends them to review, and a node a person edited is never overwritten (reported as a conflict). Returns the run: created / updated / unchanged / conflicts / failed.",
    inputSchema: {
      type: "object" as const,
      properties: {
        plugin: { type: "string", description: "Plugin name, from context_plugins." },
      },
      required: ["plugin"],
    },
  },
  {
    name: "context_plugin_configure",
    description:
      "Nest owners/admins: configure a Nest Plugin on this nest. action: configure (plugin; any of enabled, mode raw|summary, folder, settings) — settings the plugin marks secret are stored encrypted in the nest env store, never returned; pass null to clear one. Enabling provisions the plugin's own system identity (a write-tier system on this nest) that its writes are attributed to. | remove (plugin) — forget config, secrets and the system identity; nodes it wrote stay.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["configure", "remove"], description: "What to do." },
        plugin: { type: "string", description: "Plugin name, from context_plugins." },
        enabled: { type: "boolean", description: "Enable or disable (configure)." },
        mode: { type: "string", enum: ["raw", "summary"], description: "How items land (configure)." },
        folder: { type: "string", description: "Folder under nodes/ for this plugin's nodes (configure). Default inbox/<plugin>." },
        settings: { type: "object", description: "Plugin settings, per its settings schema (configure). Merged over what is stored." },
      },
      required: ["action", "plugin"],
    },
  },
];

const PLUGIN_TOOL_NAMES = new Set(PLUGIN_TOOL_DEFINITIONS.map((t) => t.name));
export const isPluginTool = (name: string): boolean => PLUGIN_TOOL_NAMES.has(name);

function errorResult(err: unknown): ToolResult {
  if (!(err instanceof AppError)) throw err;
  const code =
    err.statusCode === 403 ? "UNAUTHORIZED_ACTION" : err.statusCode === 404 ? "DOCUMENT_NOT_FOUND" : "VALIDATION_FAILED";
  return { text: err.message, isError: true, data: { code, message: err.message } };
}

const describeOne = (p: PluginDescription) =>
  `- **${p.displayName}** (\`${p.name}\` v${p.version}) — ${p.enabled ? "enabled" : p.configured ? "disabled" : "not configured"}` +
  `${p.last_status ? `, last run ${p.last_status} at ${p.last_run_at}` : ""}${p.system ? `, writes as ${p.system.name}` : ""}`;

export async function runPluginTool(toolName: string, args: Record<string, any>, ctx: McpToolContext): Promise<ToolResult> {
  const caller: Caller = { userId: ctx.userId, capability: ctx.capability === "read" ? "read" : "write" };
  const plugin = typeof args.plugin === "string" ? args.plugin : "";
  try {
    switch (toolName) {
      case "context_plugins": {
        if ((args.action ?? "list") === "runs") {
          const r = await listPluginRuns(ctx.nestId, plugin, caller);
          return {
            text: r.runs.length
              ? r.runs.map((x) => `- ${x.started_at} ${x.status} (${x.triggered_by}): +${x.created} ~${x.updated} =${x.unchanged}`).join("\n")
              : `No runs yet for ${plugin}.`,
            data: r,
          };
        }
        const r = await listNestPlugins(ctx.nestId, caller);
        return {
          text: r.plugins.length ? `Nest Plugins:\n\n${r.plugins.map(describeOne).join("\n")}` : "No plugins are loaded on this server.",
          data: r,
        };
      }
      case "context_plugin_run": {
        const r = await runPluginNow(ctx.nestId, plugin, caller);
        const x = r.run;
        return {
          text: `${plugin}: ${x.status} — ${x.created} created, ${x.updated} updated, ${x.unchanged} unchanged, ${x.conflicts.length} conflicts, ${x.failed.length} failed.`,
          data: r,
        };
      }
      case "context_plugin_configure": {
        if (args.action === "remove") {
          const r = await removePlugin(ctx.nestId, plugin, caller);
          return { text: `Removed ${plugin} from this nest. Its nodes stay.`, data: r };
        }
        if (args.action !== "configure") return errorResult(new ValidationError("action must be configure or remove"));
        const r = await configurePlugin(
          ctx.nestId,
          plugin,
          { enabled: args.enabled, mode: args.mode, folder: args.folder, settings: args.settings },
          caller,
        );
        return { text: `Saved.\n${describeOne(r.plugin)}`, data: r };
      }
    }
  } catch (err) {
    return errorResult(err);
  }
  return `Unknown tool: ${toolName}`;
}
