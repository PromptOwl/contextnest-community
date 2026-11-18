/**
 * First-run onboarding over MCP (PO-1185), at UI parity with /onboarding/*:
 *
 *   context_onboarding         read   the welcome screen's state, the nest it
 *                                     works on, connector status (Slack), the
 *                                     connect proof for that nest and, with
 *                                     `job_id`, a distill job's progress
 *                                     (GET /onboarding, /onboarding/connection
 *                                     and /onboarding/distill/:id in one read)
 *   context_onboarding_update  write  dismiss | reopen | create_nest
 *   context_distill            write  start a distill of a public URL into a
 *                                     nest as drafts (or get the agent prompt)
 *
 * Server-level /mcp only: onboarding is the person's own state, not a nest's.
 * Each tool calls the same service function as its REST route.
 *
 * Inline schemas: onboarding state, distill jobs and the Slack self-serve
 * install are Community-only tables the engine does not model, so there is no
 * engine descriptor to import (checked against @promptowl/contextnest-engine
 * 3.5.0's /api catalog). The exception is recorded per tool in
 * scripts/check-mcp-schemas.mjs and in docs/prds/api-convergence.md.
 */
import { AppError } from "../shared/errors.js";
import {
  connectionEvidence,
  createMyNest,
  dismissOnboarding,
  getOnboardingState,
  reopenOnboarding,
} from "../onboarding/service.js";
import { getDistillJob, startDistill } from "../onboarding/distill.js";
import type { ToolResult } from "./tools.js";
import { listRecipes, parseRecipeRef, recipeAppliedText } from "../nests/recipe-service.js";

export const ONBOARDING_TOOL_DEFINITIONS = [
  {
    name: "context_onboarding",
    description:
      "Reads the caller's first-run onboarding state: whether the welcome screen shows (a first run owns no nest and was invited to none), the nest it works on (with its MCP URL), whether a model can distill on the server, Slack connector status, and the connect proof — whether an agent really read that nest (after `since`, if given). With `job_id`, also the progress of a distill job you started: phase, steps done of total, and the drafts written so far.",
    inputSchema: {
      type: "object" as const,
      properties: {
        nest: { type: "string", description: "Nest (id, name or slug) to check the connect proof for. Default: the onboarding nest." },
        since: { type: "string", description: "ISO time; only count reads at or after it." },
        job_id: { type: "string", description: "A job id context_distill returned: include that distill's progress." },
      },
    },
  },
  {
    name: "context_onboarding_update",
    description:
      "Changes the caller's onboarding: `dismiss` closes the welcome screen (Skip), `reopen` shows it again (Getting started), `create_nest` makes the caller's own nest (\"<Name>'s nest\", or `name`) — idempotent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["dismiss", "reopen", "create_nest"], description: "What to do." },
        name: { type: "string", description: "create_nest only: the nest name. Default \"<Name>'s nest\"." },
        recipe: { type: "string", description: "create_nest only: a recipe id from context_recipes (product-factory, gtm-factory, operations, ideation) to pre-populate the new nest. Default blank." },
      },
      required: ["action"],
    },
  },
  {
    name: "context_recipes",
    description:
      "Lists the recipes a new nest can start from (the same catalog as GET /recipes): Product factory, GTM factory, Operations, Ideation and Blank. Each has a name, a one-line purpose and what you get — folders, starter documents, boards with their stage columns, team chat channels and the agents worth hiring. Pass a recipe's id to nest_create or context_onboarding_update (create_nest).",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "context_distill",
    description:
      "Distills a public https site or public GitHub repo into a nest with the nest's distill ontology (a versioned document in the nest). Every document lands as a draft for the person to review before agents read it. With a model on the server it starts a job (poll context_onboarding with its job_id); without one it returns the prompt for you to run yourself.",
    inputSchema: {
      type: "object" as const,
      properties: {
        nest: { type: "string", description: "Nest (id, name or slug) to write into. You need edit access." },
        url: { type: "string", description: "Public https URL of a site or a github.com repo." },
      },
      required: ["nest", "url"],
    },
  },
];

export const ONBOARDING_TOOL_NAMES = new Set(ONBOARDING_TOOL_DEFINITIONS.map((t) => t.name));
export const ONBOARDING_READ_TOOL_NAMES = ["context_onboarding", "context_recipes"];

interface Ctx {
  userId: string;
  userEmail: string;
  baseUrl: string;
  nestScope: string | null;
  contributorCredential: boolean;
  /** The API key the call came with, for the push-confirmation gate a recipe's writes honour. */
  apiKeyId?: string | null;
  /** The server endpoint's nest resolver, gated on the caller's read access. */
  resolveNest: (ref: string) => Promise<{ id: string } | null>;
}

const json = (text: string, data: unknown): ToolResult => ({ text, data } as ToolResult);

export async function handleOnboardingTool(name: string, args: Record<string, any>, ctx: Ctx): Promise<ToolResult> {
  if (ctx.nestScope) return "This credential is scoped to a single nest and has no onboarding.";
  try {
    if (name === "context_onboarding") {
      let job: Awaited<ReturnType<typeof getDistillJob>> = null;
      if (args.job_id !== undefined) {
        job = await getDistillJob(String(args.job_id ?? ""), ctx.userId);
        if (!job) return "No distill job with that id is yours.";
      }
      const state = await getOnboardingState(ctx.userId, ctx.baseUrl);
      let nestId = state.nest?.id ?? null;
      if (args.nest) {
        const ref = await ctx.resolveNest(String(args.nest));
        if (!ref) return `Nest not found or not accessible: "${args.nest}".`;
        nestId = ref.id;
      }
      const connection = nestId ? await connectionEvidence(ctx.userId, nestId, typeof args.since === "string" ? args.since : null) : null;
      const data = job ? { ...state, connection, job } : { ...state, connection };
      const lines = [
        `Welcome screen: ${state.show ? "shown" : "not shown"}${state.dismissed ? " (dismissed)" : ""}.`,
        state.nest ? `Nest: "${state.nest.name}" (${state.nest.id}), MCP URL ${state.nest.mcp_url}.` : state.shared_nests > 0
            ? `No nest of your own yet, and ${state.shared_nests} nest${state.shared_nests === 1 ? "" : "s"} shared with you (nest_index lists them). To make your own, call context_onboarding_update with action create_nest.`
            : "No nest of your own yet. Call context_onboarding_update with action create_nest.",
        connection ? (connection.connected ? `Connect proof: an agent read this nest at ${connection.at}${connection.client ? ` (${connection.client})` : ""}.` : "Connect proof: no agent read of this nest yet.") : "",
        `Distill: ${state.distill.mode === "server" ? "runs on the server" : "returns a prompt for your own agent"}.`,
        `Slack: ${state.connectors.slack.connected ? "connected" : state.connectors.slack.can_connect ? "ready to connect (open the welcome screen in a browser)" : (state.connectors.slack.reason?.replace(/\.$/, "") ?? "not available")}.`,
        job
          ? `Distill ${job.status}: ${job.phase}, ${job.done_steps}/${job.total_steps} steps, ${job.nodes.length} documents written as drafts for your review.${job.error ? ` ${job.error}` : ""}`
          : "",
      ].filter(Boolean);
      return json(lines.join("\n"), data);
    }
    if (name === "context_onboarding_update") {
      const action = String(args.action ?? "");
      if (action === "dismiss") await dismissOnboarding(ctx.userId);
      else if (action === "reopen") await reopenOnboarding(ctx.userId);
      else if (action === "create_nest") {
        if (!ctx.contributorCredential) return "Creating your nest needs your own full credential (a session, an OAuth grant or a read-write personal key).";
        const recipe = parseRecipeRef(args.recipe);
        const nest = await createMyNest(ctx.userId, typeof args.name === "string" ? args.name : undefined, recipe, ctx.apiKeyId ?? null);
        const recipeLine = nest.recipe ? ` ${recipeAppliedText(nest.recipe)}` : recipe && !nest.created ? " The recipe was not applied: it only applies to a nest this call creates." : "";
        return json(`${nest.created ? "Created" : "You already have"} "${nest.name}" (id: ${nest.id}).${recipeLine}`, { nest });
      } else return 'action must be "dismiss", "reopen" or "create_nest".';
      const state = await getOnboardingState(ctx.userId, ctx.baseUrl);
      return json(`Welcome screen: ${state.show ? "shown" : "not shown"}.`, state);
    }
    if (name === "context_recipes") {
      const recipes = await listRecipes(ctx.userId);
      const lines = recipes.map((r) => {
        const board = r.gets.boards[0];
        return `- ${r.id}: ${r.name} — ${r.purpose}${board ? ` Board "${board.name}": ${board.stages.join(" → ")}.` : ""}${r.gets.channels.length ? ` Channels: ${r.gets.channels.map((c) => `#${c.name}`).join(", ")}.` : ""}${r.gets.agents.length ? ` Agents: ${r.gets.agents.map((a) => `@${a.handle}`).join(", ")}.` : ""}`;
      });
      return json(lines.join("\n"), { recipes });
    }
    if (name === "context_distill") {
      if (!ctx.contributorCredential) return "Distilling needs your own full credential (a session, an OAuth grant or a read-write personal key).";
      const ref = await ctx.resolveNest(String(args.nest ?? ""));
      if (!ref) return `Nest not found or not accessible: "${args.nest}".`;
      const out = await startDistill({ nestId: ref.id, userId: ctx.userId, userEmail: ctx.userEmail, url: args.url });
      if (out.mode === "agent") return json(`${out.reason}\n\n${out.prompt}`, out);
      return json(`Distill started (job ${out.job.id}). Poll context_onboarding with job_id "${out.job.id}". Documents land as drafts for review.`, out);
    }
    return `Unknown onboarding tool "${name}".`;
  } catch (err) {
    if (err instanceof AppError) return err.message;
    throw err;
  }
}
