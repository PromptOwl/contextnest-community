/**
 * `nest_pin` (PO-1441): pin or unpin a nest for the caller — the MCP twin of
 * POST / DELETE /nests/:id/pin. The list side is `nest_index`, which carries
 * `pinned` per nest exactly as GET /nests does.
 *
 * A pin belongs to a person (nest_pins, CU-wdqcq00d63): a key pins for the
 * person who owns it, and nobody else sees it. Server-level only — it is about
 * the caller's list of nests, not about one nest's content. Community-only:
 * the engine has no users, so it has no pin op to consume.
 */
import { z } from "zod";
import { mcpInputSchema } from "../workflow/agent-event-schema.js";
import { pinNest, unpinNest } from "../nests/service.js";
import type { ToolResult } from "./tools.js";

export const NEST_PIN_TOOL = "nest_pin";

/** Its MCP JSON schema is generated from this (no inline literal, lint:mcp-schemas). */
export const NestPinInput = z.object({
  nest: z.string().describe("Target nest — id, or exact name/slug (case-insensitive)."),
  pinned: z
    .boolean()
    .optional()
    .describe("true (the default) pins the nest for you; false unpins it."),
});

export const NEST_PIN_TOOL_DEFINITION = {
  name: NEST_PIN_TOOL,
  description:
    "Pin (star) a nest for yourself so it sits at the top of your nest list and the web app's left rail, or unpin it with `pinned: false`. " +
    "A pin is private to the person who owns these credentials and changes nothing about the nest. `nest_index` shows which nests are pinned.",
  inputSchema: mcpInputSchema(NestPinInput),
};

const failure = (message: string, code: string): ToolResult => ({ text: message, data: { code, message }, isError: true });

export async function nestPinToolResult(
  args: Record<string, unknown>,
  ctx: {
    userId: string;
    /** A nest-scoped key reaches its own nest only. */
    nestScope: string | null;
    /** Resolves the `nest` argument to a nest the caller can read, else null. */
    resolveNest: (ref: string) => Promise<{ id: string; name: string } | null>;
  },
): Promise<ToolResult> {
  // The advertised schema is the one validator (tools/call does not apply it).
  const parsed = NestPinInput.safeParse(args);
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "nest");
    return failure(
      field === "pinned" ? "`pinned` must be true or false." : "`nest` is required: a nest id, name or slug.",
      "INVALID_INPUT",
    );
  }
  const ref = parsed.data.nest.trim();
  if (!ref) return failure("`nest` is required: a nest id, name or slug.", "INVALID_INPUT");
  const pinned = parsed.data.pinned !== false;
  const nest = await ctx.resolveNest(ref);
  // One answer for "no such nest", "can't read it" and "outside this key's
  // scope", like REST's 404: the tool must not confirm that a nest id exists.
  if (!nest || (ctx.nestScope && nest.id !== ctx.nestScope)) {
    return failure(`Nest not found: ${ref}`, "NOT_FOUND");
  }
  if (pinned) await pinNest(ctx.userId, nest.id);
  else await unpinNest(ctx.userId, nest.id);
  return {
    text: pinned
      ? `Pinned "${nest.name}" (id: ${nest.id}). It now sits at the top of your nest list.`
      : `Unpinned "${nest.name}" (id: ${nest.id}).`,
    data: { nest: { id: nest.id, name: nest.name }, pinned },
  };
}
