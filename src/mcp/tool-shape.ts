/**
 * One tool definition → the zod shape the MCP SDK registers it with.
 *
 * Both endpoints build their tools from the same kind of descriptor — the
 * per-nest server (`mcp/routes.ts`) and the server-level one
 * (`mcp/server-routes.ts`) — and they used to carry a copy of this loop each.
 * Two copies meant every change to how an argument is declared had to be made
 * twice and stay identical by hand, which is how they would eventually stop
 * being identical.
 *
 * The mapping is deliberately narrow: the SDK wants zod, the catalog speaks
 * JSON Schema, and only three of its types appear in these definitions.
 * Anything else — an object, a nested array, a union — lands on `z.any()`,
 * which advertises the argument without describing it. That is a real
 * limitation rather than an oversight: the shapes are advertisement, and every
 * call is validated again by the handler (`handleToolCall` for the operation
 * catalog's own schemas, `parseClientMetadata` for `client`). Teach this
 * function a richer mapping only alongside a definition that needs one.
 */
import { z } from "zod";
import { clientToolField } from "../shared/client-metadata.js";

/** The shape of a tool definition this builder understands. */
export interface ToolDefinitionLike {
  inputSchema: unknown;
}

export function toolShape(tool: ToolDefinitionLike): Record<string, z.ZodTypeAny> {
  const props = (tool.inputSchema as any).properties || {};
  const required = (tool.inputSchema as any).required || [];
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, def] of Object.entries(props) as Array<[string, any]>) {
    let field: z.ZodTypeAny;
    if (def.type === "string") field = z.string();
    else if (def.type === "number") field = z.number();
    else if (def.type === "array") field = z.array(z.string());
    else field = z.any();

    if (!required.includes(key)) field = field.optional();
    shape[key] = field;
  }

  // Caller attribution rides on EVERY tool (spec §9.4) — attached here rather
  // than written into each tool's inputSchema, so no tool can be added without
  // it and the divergence guard sees no new inline schema. Validated against
  // the engine's own schema inside the handler.
  return Object.assign(shape, clientToolField);
}
