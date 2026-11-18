/**
 * Hire agents, and recommend them, over MCP (PO-1201, team chat C10) — the
 * twins of /nests/:id/hire and /nests/:id/agents/recommendations.
 *
 *   context_hire_catalog          GET /hire/catalog
 *   context_hire_agent            POST /hire (action "hire", default) · DELETE /hire/:kind/:handle (action "let_go")
 *   context_hired_agents          GET /hire
 *   context_agent_identity        GET /hire/me (who am I, who owns me — for an agent's own key)
 *   context_agent_recommendations GET /agents/recommendations (action "list", default) · POST …/:id/dismiss ("dismiss")
 *
 * Each calls the same service function its REST route calls and returns that
 * object as structuredContent, so the two can't drift. Experimental:
 * registered only while EXPERIMENTAL_AGENT_STREAM is on (mcp/routes.ts), and
 * re-checked here. A read-only key is offered the three reads and a
 * list-only view of the recommendations tool; hire, let go and dismiss
 * answer READ_ONLY_KEY_REFUSAL.
 *
 * Inline schemas: hiring is Community-only (it composes this edition's
 * Hootie switch, metacognition, agent webhooks and keys), so the engine has
 * no operation to import a descriptor from (scripts/check-mcp-schemas.mjs
 * baseline, documented there).
 */
import { config } from "../config.js";
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../shared/errors.js";
import { agentIdentity, hireAgent, hireCatalog, letAgentGo, listHiredAgents, type AgentIdentityView, type HireCaller, type HiredAgentView } from "../hire/service.js";
import { dismissRecommendation, listRecommendations, type Recommendation } from "../hire/recommend.js";
import type { CatalogView } from "../hire/catalog.js";
import { messageClient } from "../channels/message-meta.js";
import { READ_ONLY_KEY_REFUSAL } from "./channel-tools.js";
import { toolError, type McpToolContext, type ToolResult } from "./tools.js";

export const HIRE_TOOL_DEFINITIONS = [
  {
    name: "context_hire_catalog",
    description:
      "Lists the kinds of agent this server can add to this nest, in plain words: Hootie (answers questions from the nest), a watcher (a metacognition agent reading a channel), " +
      "a webhook agent (your own runner, woken by @mentions) and a key agent (connects over MCP with its own key). Each says what it does in a channel, what it needs, " +
      "what it may do, its cost, who may hire it, and `available` with a `reason` when this server or you can't right now. Hire one with context_hire_agent.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "context_hire_agent",
    description:
      'Hire an agent for this nest in one step (action "hire", default), or let one go (action "let_go"). `kind` is hootie | watcher | webhook | key (see context_hire_catalog). ' +
      "`handle` is the agent's @name (not needed for hootie). `config.url` is the runner's public https URL for a webhook. `channels` are channel names: the ones a watcher reads, " +
      "and where `announce: true` posts one welcome line as you. Hiring creates the existing thing underneath — the metacognition agent, the agent webhook (its signing `secret` returned once), " +
      "the key agent's own identity (an agent principal: not a person, not a seat, an editor of this nest only) and its nest-scoped key (`api_key` returned once) — under that feature's own gate (owner/admin for hootie, watcher and webhook; a writer for a key). " +
      "A key agent may take `config.url` to add its wake webhook in the same hire (owner/admin), and `name` for its display name. Any member can then DM or @mention it, and it reads that conversation with its own key. Hiring what exists returns it with `created: false` and no secret.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: 'One of "hire" (default) or "let_go".' },
        kind: { type: "string", description: "hootie | watcher | webhook | key." },
        handle: { type: "string", description: "The agent's @handle: 1–63 lowercase letters, digits, dots, dashes or underscores. Not used for hootie." },
        name: { type: "string", description: "key: the agent's display name (default: its handle)." },
        config: { type: "object", description: "Per kind: webhook needs { url } (public https); key may take { url } to add its wake webhook too (owner/admin). Others take nothing." },
        channels: { type: "array", items: { type: "string" }, description: "Channel names: the ones a watcher reads ([] = the whole nest), and where the announcement is posted." },
        announce: { type: "boolean", description: 'Post "Hired @handle: …" in each channel, as you. Default false.' },
      },
      required: ["kind"],
    },
  },
  {
    name: "context_hired_agents",
    description:
      "Lists the agents hired for this nest: kind, @handle, who hired it, when, and a status — active, failing (a webhook whose last delivery failed), no_key (needs a model key on the server) or off (its switch is off). " +
      "Derived from the agents that exist (Hootie, metacognition agents, agent webhooks, key agents), so it is always current.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "context_agent_identity",
    description:
      "Who am I, as an agent: for a hired agent's own key, its @handle, display name, address, nest, owner (the person who hired it), when it was hired, whether it has a wake webhook, and what it may do. " +
      "`legacy: true` means the key is a person's key labelled with the handle (hired before agents had their own identity). A person's credential answers `agent: false`.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "context_agent_recommendations",
    description:
      'Recommends agents that would help this nest, computed from what already happened — never from a model (action "list", default; at most 5): questions nobody answered for a day (hire Hootie), ' +
      "a channel that keeps turning threads into decisions or tasks (hire a watcher), an @name people keep tagging that nobody answers to (hire an agent with that handle), a webhook that isn't getting through (fix or replace), " +
      'a key agent silent for a month (let go?). Each carries evidence links and a ready `hire` payload for context_hire_agent. "dismiss" with `id` hides one for you only.',
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", description: 'One of "list" (default) or "dismiss".' },
        id: { type: "string", description: "dismiss: the recommendation's id, e.g. mention:grok." },
      },
    },
  },
];

/** What a read-only key is offered for the tool that also dismisses (list only). */
export const HIRE_READ_KEY_TOOL_VIEWS: Record<
  string,
  {
    description: string;
    schema: { type: "object"; properties: Record<string, unknown> };
    annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
  }
> = {
  context_agent_recommendations: {
    description:
      "Recommends agents that would help this nest, computed from what already happened (at most 5), each with evidence links and a ready hire payload. This key is read-only: it can list, and cannot dismiss or hire.",
    // `action` stays in the schema so a dismiss is answered with the plain
    // refusal rather than silently stripped by the SDK's input validation.
    schema: { type: "object", properties: { action: { type: "string", description: 'Only "list" for this key.' } } },
    annotations: { title: "List agent recommendations", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
};

const NAMES = new Set(HIRE_TOOL_DEFINITIONS.map((t) => t.name));

export function isHireTool(name: string): boolean {
  return NAMES.has(name);
}

function refusal(err: unknown): ToolResult {
  if (err instanceof NotFoundError) return toolError(err.message, "DOCUMENT_NOT_FOUND");
  if (err instanceof ForbiddenError) return toolError(err.message, "UNAUTHORIZED_ACTION");
  if (err instanceof ConflictError) return toolError(err.message, "DOCUMENT_ALREADY_EXISTS");
  if (err instanceof ValidationError) return toolError(err.message, "VALIDATION_FAILED");
  if (err instanceof AppError && err.statusCode === 403) return toolError(err.message, "UNAUTHORIZED_ACTION");
  if (err instanceof AppError && (err.statusCode === 400 || err.statusCode === 409)) return toolError(err.message, "VALIDATION_FAILED");
  throw err;
}

const callerOf = (ctx: McpToolContext): HireCaller => ({
  nestId: ctx.nestId,
  userId: ctx.userId,
  userEmail: ctx.userEmail,
  // crossNest is false exactly when the key is fenced to this nest.
  nestScoped: ctx.crossNest === false,
  client: ctx.client,
});

function catalogText(catalog: CatalogView[]): string {
  return `# Agents this server can offer (${catalog.length})\n\n${catalog
    .map((e) => `- **${e.name}** (kind \`${e.kind}\`) — ${e.in_channel}. Hire: ${e.hire_by}. ${e.available ? "Available." : `Not now: ${e.reason}`}`)
    .join("\n")}\n\nHire one with context_hire_agent { kind, handle?, config?, channels?, announce? }.`;
}

function hiredText(hired: HiredAgentView[]): string {
  if (hired.length === 0) return "No agents hired here yet. See context_hire_catalog.";
  return `# Hired agents (${hired.length})\n\n${hired
    .map((h) => `- @${h.handle} (${h.kind}) — ${h.status}${h.detail ? `: ${h.detail}` : ""}; ${h.hired_by ? `hired by ${h.hired_by} on ` : "hired "}${h.hired_at}${h.channels.length ? `; watches ${h.channels.map((c) => `#${c}`).join(", ")}` : ""}`)
    .join("\n")}`;
}

function identityText(v: AgentIdentityView): string {
  if (!v.agent) return `Not an agent. ${v.detail ?? ""}`.trim();
  return [
    `You are @${v.handle} (${v.name}) in ${v.nest?.name ?? v.nest?.id}${v.legacy ? ", running on a person's key (legacy)" : ""}.`,
    v.owner ? `Owned by ${v.owner.name ? `${v.owner.name} <${v.owner.email}>` : v.owner.email}, who hired you on ${v.hired_at}.` : "",
    v.webhook ? "You have a wake webhook: DMs and @mentions wake you." : "No wake webhook: find what tags you with context_my_work.",
    ...(v.can ?? []).map((c) => `- ${c}`),
  ]
    .filter(Boolean)
    .join("\n");
}

function recommendationsText(recs: Recommendation[]): string {
  if (recs.length === 0) return "No recommendations right now.";
  return `# Recommendations (${recs.length})\n\n${recs
    .map((r) => `- [${r.id}] **${r.title}** — ${r.reason}${r.hire ? ` Hire: context_hire_agent ${JSON.stringify(r.hire)}.` : ""}${r.let_go ? ` Let go: context_hire_agent { action: "let_go", kind: "${r.let_go.kind}", handle: "${r.let_go.handle}" }.` : ""}`)
    .join("\n")}\n\nDismiss one for yourself with { action: "dismiss", id }.`;
}

export async function runHireTool(toolName: string, args: Record<string, any>, ctx: McpToolContext): Promise<ToolResult> {
  if (!config.EXPERIMENTAL_AGENT_STREAM) {
    return toolError("Hiring agents is part of the experimental team chat harness, which is not enabled on this server (EXPERIMENTAL_AGENT_STREAM).", "DOCUMENT_NOT_FOUND");
  }
  const caller = callerOf(ctx);
  try {
    if (toolName === "context_hire_catalog") {
      const data = await hireCatalog(caller);
      return { text: catalogText(data.catalog), data };
    }
    if (toolName === "context_hired_agents") {
      const data = await listHiredAgents(caller);
      return { text: hiredText(data.hired), data };
    }
    if (toolName === "context_agent_identity") {
      const data = await agentIdentity({ ...caller, apiKeyId: ctx.apiKeyId ?? null });
      return { text: identityText(data), data };
    }
    if (toolName === "context_agent_recommendations") {
      const action = String(args.action ?? "list").toLowerCase();
      if (action === "list") {
        const data = await listRecommendations(caller);
        return { text: recommendationsText(data.recommendations), data };
      }
      if (ctx.capability === "read") return toolError(READ_ONLY_KEY_REFUSAL, "UNAUTHORIZED_ACTION");
      if (action === "dismiss") {
        const data = await dismissRecommendation(caller, args.id);
        return { text: `Dismissed ${data.dismissed} for you.`, data };
      }
      return toolError(`Unknown action "${action}" — use list or dismiss.`, "VALIDATION_FAILED");
    }
    // context_hire_agent
    if (ctx.capability === "read") return toolError(READ_ONLY_KEY_REFUSAL, "UNAUTHORIZED_ACTION");
    const action = String(args.action ?? "hire").toLowerCase();
    if (action === "let_go") {
      const data = await letAgentGo(caller, args.kind, args.handle);
      return { text: `Let @${String(args.handle ?? args.kind)} go.`, data };
    }
    if (action !== "hire") return toolError(`Unknown action "${action}" — use hire or let_go.`, "VALIDATION_FAILED");
    const data = await hireAgent(
      { ...caller, client: messageClient(ctx.client, args.client, ctx.apiKeyLabel) },
      { kind: args.kind, handle: args.handle, name: args.name, config: args.config, channels: args.channels, announce: args.announce },
    );
    const lines = [
      data.created ? `Hired @${data.hired.handle} (${data.hired.kind}).` : `@${data.hired.handle} (${data.hired.kind}) was already hired; nothing changed.`,
      data.secret ? `Signing secret (shown once, give it to the runner): ${data.secret}` : "",
      data.api_key ? `API key (shown once, paste it into the agent's MCP client): ${data.api_key}` : "",
      data.hired.principal ? `@${data.hired.handle} has its own identity (${data.hired.principal.email}); any member can DM or @mention it.` : "",
      data.wake_error ? `The wake webhook was not added: ${data.wake_error}` : "",
      data.announced.length ? `Announced in ${data.announced.map((a) => `#${a.channel}`).join(", ")}.` : "",
    ].filter(Boolean);
    return { text: lines.join("\n"), data };
  } catch (err) {
    return refusal(err);
  }
}
