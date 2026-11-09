/**
 * First-run onboarding over MCP (PO-1185), at UI parity with /onboarding/*:
 *
 *   context_onboarding         read   the welcome screen's state, the nest it
 *                                     works on, connector status (Slack) and
 *                                     the connect proof for that nest
 *   context_onboarding_update  write  dismiss | reopen | create_nest
 *   context_distill            write  start a distill of a public URL into a
 *                                     nest (or get the agent prompt)
 *   context_distill_status     read   a distill job's progress
 *
 * Server-level /mcp only: onboarding is the person's own state, not a nest's.
 * Each tool calls the same service function as its REST route.
 *
 * Inline schemas: onboarding state, distill jobs and the Slack self-serve
 * install are Community-only tables the engine does not model, so there is no
 * engine descriptor to import (scripts/check-mcp-schemas.mjs baseline raised
 * and documented).
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

export const ONBOARDING_TOOL_DEFINITIONS = [
  {
    name: "context_onboarding",
    description:
      "Reads the caller's first-run onboarding state: whether the welcome screen shows, the nest it works on (with its MCP URL), whether a model can distill on the server, Slack connector status, and the connect proof — whether an agent really read that nest (after `since`, if given).",
    inputSchema: {
      type: "object" as const,
      properties: {
        nest: { type: "string", description: "Nest (id, name or slug) to check the connect proof for. Default: the onboarding nest." },
        since: { type: "string", description: "ISO time; only count reads at or after it." },
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
      },
      required: ["action"],
    },
  },
  {
    name: "context_distill",
    description:
      "Distills a public https site or public GitHub repo into a nest with the nest's distill ontology (a versioned document in the nest). With a model on the server it starts a job (poll context_distill_status); without one it returns the prompt for you to run yourself.",
    inputSchema: {
      type: "object" as const,
      properties: {
        nest: { type: "string", description: "Nest (id, name or slug) to write into. You need edit access." },
        url: { type: "string", description: "Public https URL of a site or a github.com repo." },
      },
      required: ["nest", "url"],
    },
  },
  {
    name: "context_distill_status",
    description: "Reads the progress of a distill job you started: phase, steps done of total, and the documents written so far.",
    inputSchema: {
      type: "object" as const,
      properties: { job_id: { type: "string", description: "The job id context_distill returned." } },
      required: ["job_id"],
    },
  },
];

export const ONBOARDING_TOOL_NAMES = new Set(ONBOARDING_TOOL_DEFINITIONS.map((t) => t.name));
export const ONBOARDING_READ_TOOL_NAMES = ["context_onboarding", "context_distill_status"];

interface Ctx {
  userId: string;
  userEmail: string;
  baseUrl: string;
  nestScope: string | null;
  contributorCredential: boolean;
  /** The server endpoint's nest resolver, gated on the caller's read access. */
  resolveNest: (ref: string) => Promise<{ id: string } | null>;
}

const json = (text: string, data: unknown): ToolResult => ({ text, data } as ToolResult);

export async function handleOnboardingTool(name: string, args: Record<string, any>, ctx: Ctx): Promise<ToolResult> {
  if (ctx.nestScope) return "This credential is scoped to a single nest and has no onboarding.";
  try {
    if (name === "context_onboarding") {
      const state = await getOnboardingState(ctx.userId, ctx.baseUrl);
      let nestId = state.nest?.id ?? null;
      if (args.nest) {
        const ref = await ctx.resolveNest(String(args.nest));
        if (!ref) return `Nest not found or not accessible: "${args.nest}".`;
        nestId = ref.id;
      }
      const connection = nestId ? await connectionEvidence(ctx.userId, nestId, typeof args.since === "string" ? args.since : null) : null;
      const data = { ...state, connection };
      const lines = [
        `Welcome screen: ${state.show ? "shown" : "not shown"}${state.dismissed ? " (dismissed)" : ""}.`,
        state.nest ? `Nest: "${state.nest.name}" (${state.nest.id}), MCP URL ${state.nest.mcp_url}.` : "No nest of your own yet. Call context_onboarding_update with action create_nest.",
        connection ? (connection.connected ? `Connect proof: an agent read this nest at ${connection.at}${connection.client ? ` (${connection.client})` : ""}.` : "Connect proof: no agent read of this nest yet.") : "",
        `Distill: ${state.distill.mode === "server" ? "runs on the server" : "returns a prompt for your own agent"}.`,
        `Slack: ${state.connectors.slack.connected ? "connected" : state.connectors.slack.can_connect ? "ready to connect (open the welcome screen in a browser)" : (state.connectors.slack.reason ?? "not available")}.`,
      ].filter(Boolean);
      return json(lines.join("\n"), data);
    }
    if (name === "context_onboarding_update") {
      const action = String(args.action ?? "");
      if (action === "dismiss") await dismissOnboarding(ctx.userId);
      else if (action === "reopen") await reopenOnboarding(ctx.userId);
      else if (action === "create_nest") {
        if (!ctx.contributorCredential) return "Creating your nest needs your own full credential (a session, an OAuth grant or a read-write personal key).";
        const nest = await createMyNest(ctx.userId, typeof args.name === "string" ? args.name : undefined);
        return json(`${nest.created ? "Created" : "You already have"} "${nest.name}" (id: ${nest.id}).`, { nest });
      } else return 'action must be "dismiss", "reopen" or "create_nest".';
      const state = await getOnboardingState(ctx.userId, ctx.baseUrl);
      return json(`Welcome screen: ${state.show ? "shown" : "not shown"}.`, state);
    }
    if (name === "context_distill") {
      const ref = await ctx.resolveNest(String(args.nest ?? ""));
      if (!ref) return `Nest not found or not accessible: "${args.nest}".`;
      const out = await startDistill({ nestId: ref.id, userId: ctx.userId, userEmail: ctx.userEmail, url: args.url });
      if (out.mode === "agent") return json(`${out.reason}\n\n${out.prompt}`, out);
      return json(`Distill started (job ${out.job.id}). Poll context_distill_status.`, out);
    }
    if (name === "context_distill_status") {
      const job = await getDistillJob(String(args.job_id ?? ""), ctx.userId);
      if (!job) return "No distill job with that id is yours.";
      return json(
        `Distill ${job.status}: ${job.phase}, ${job.done_steps}/${job.total_steps} steps, ${job.nodes.length} documents written.${job.error ? ` ${job.error}` : ""}`,
        { job },
      );
    }
    return `Unknown onboarding tool "${name}".`;
  } catch (err) {
    if (err instanceof AppError) return err.message;
    throw err;
  }
}
