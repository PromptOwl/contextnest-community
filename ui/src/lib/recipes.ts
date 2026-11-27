/**
 * Recipes and the harness step (PO-1411): the pure logic behind the recipe
 * cards (create-nest dialog, welcome screen) and the "Connect a harness"
 * choices. React-free so it unit-tests in the node-only vitest setup.
 *
 * The catalog comes from GET /recipes; nothing here names a recipe's folders
 * or documents. Blank is the server's own entry (id "blank").
 */

export interface RecipeAgent {
  kind: "hootie" | "watcher" | "webhook" | "key";
  handle: string;
  why: string;
  channels: string[];
}

export interface Recipe {
  id: string;
  name: string;
  purpose: string;
  description: string | null;
  version: number;
  source: "bundled" | "library" | "none";
  gets: {
    folders: string[];
    documents: string[];
    instructions: boolean;
    definitions: number;
    boards: Array<{ name: string; stages: string[] }>;
    channels: Array<{ name: string; purpose: string }>;
    agents: RecipeAgent[];
    distill: boolean;
  };
}

export interface RecipeItem {
  kind: string;
  target: string;
  action: string;
  note?: string;
}

export interface RecipeApplied {
  id: string;
  status: string;
  items: RecipeItem[];
  drafts: number;
  suggested_agents: RecipeAgent[];
  error?: string;
}

export const BLANK_RECIPE_ID = "blank";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Words that read as initials, not as a word: "prd" → "PRD". */
const INITIALS = new Set(["prd", "qa", "sop", "ai", "ux", "ui", "api"]);

/** A stage slug as a column heading: "red-team" → "Red team", "prd" → "PRD". */
export function stageLabel(slug: string): string {
  const words = slug.split(/[-_]+/).filter(Boolean);
  return words
    .map((w, i) => (INITIALS.has(w) ? w.toUpperCase() : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * The card's "what you get" line, shortest first: the board and its stage
 * count, then documents, channels and agents. Blank says so plainly.
 */
export function recipeSummary(r: Recipe): string[] {
  const g = r.gets;
  if (r.id === BLANK_RECIPE_ID) return ["Nothing added. Start from an empty nest."];
  const out: string[] = [];
  for (const b of g.boards) out.push(`${b.name} board, ${plural(b.stages.length, "stage")}`);
  const docs = g.documents.length + (g.instructions ? 1 : 0);
  if (docs) out.push(plural(docs, "starter document"));
  if (g.channels.length) out.push(plural(g.channels.length, "channel"));
  if (g.agents.length) out.push(`${plural(g.agents.length, "agent")} to hire`);
  return out;
}

/** Blank last, whatever order the server sent; the first real recipe is never auto-picked. */
export function orderedRecipes(list: Recipe[]): Recipe[] {
  return [...list.filter((r) => r.id !== BLANK_RECIPE_ID), ...list.filter((r) => r.id === BLANK_RECIPE_ID)];
}

/** The `recipe` a create call sends: none for Blank. */
export function recipeParam(id: string | null | undefined): string | undefined {
  return id && id !== BLANK_RECIPE_ID ? id : undefined;
}

/**
 * One sentence on what a recipe apply did, for the step after Create. Says
 * when channels were left out (team chat off) and when something failed.
 */
export function appliedSummary(r: RecipeApplied | null | undefined, recipeName: string): string | null {
  if (!r) return null;
  if (r.status === "failed") return `${recipeName} could not be applied: ${r.error ?? "unknown error"}. The nest was created; some recipe items may be missing.`;
  const made = r.items.filter((i) => i.action === "created");
  const count = (kind: string) => made.filter((i) => i.kind === kind).length;
  const parts = [
    count("node") + count("context") ? plural(count("node") + count("context"), "document") : "",
    count("board") ? plural(count("board"), "board") : "",
    count("channel") ? plural(count("channel"), "channel") : "",
  ].filter(Boolean);
  const skipped = r.items.some((i) => i.kind === "channel" && i.action === "skipped");
  const failed = r.items.filter((i) => i.action === "failed").length;
  return [
    `${recipeName} is set up${parts.length ? `: ${parts.join(", ")}` : ""}.`,
    r.drafts ? `${plural(r.drafts, "document")} wait for review.` : "",
    skipped ? "Channels were skipped because team chat is off." : "",
    failed ? `${plural(failed, "item")} did not apply; open the nest's seed settings to retry.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// ─── the harness step ───────────────────────────────────────────────────────

export type HarnessKind = "local" | "central-lite" | "central-durable";

export interface HarnessChoice {
  id: HarnessKind;
  name: string;
  /** One line under the name. */
  summary: string;
  /** What it is, in two or three plain sentences. */
  detail: string;
  /** What you need before you start. */
  needs: string[];
  /** False until the deploy bundle is published: the choice explains and links docs. */
  available: boolean;
}

/** Where the central options are explained (public repo docs). */
export const CENTRAL_HARNESS_DOCS = "https://github.com/PromptOwl/contextnest-community/blob/development/docs/central-harness.md";

export const HARNESS_CHOICES: readonly HarnessChoice[] = [
  {
    id: "local",
    name: "Local",
    summary: "Your agent, on your computer",
    detail:
      "Connect Claude Code, Cursor, opencode or another MCP client to this nest. Nothing to run on a server. The agent works while your computer is on.",
    needs: ["An MCP client", "An API key, or sign-in where the client supports it"],
    available: true,
  },
  {
    id: "central-lite",
    name: "Central lite",
    summary: "One small server runs an agent for the team",
    detail:
      "A runner (Claude Code or opencode, headless) on one small server, behind a model gateway that holds the model key. It wakes when someone mentions it in a channel and replies in the thread.",
    needs: ["A small Linux server with Docker", "A model API key for the gateway"],
    available: false,
  },
  {
    id: "central-durable",
    name: "Central durable",
    summary: "Long jobs that keep running after you leave",
    detail:
      "The runner plus a workflow engine (Temporal) and a model gateway (LiteLLM). Work survives restarts and waits for approvals, and every model call is metered in one place.",
    needs: ["A server or cluster with Docker or Kubernetes", "A model API key for the gateway"],
    available: false,
  },
];

export const CENTRAL_PLACEHOLDER =
  "The one-step deploy for this option is not published yet. Read how it works, and connect a local agent in the meantime.";
