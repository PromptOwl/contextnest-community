/**
 * Recipes (PO-1411): the seeds offered when a nest is created — Product
 * factory, GTM factory, Operations, Ideation — plus Blank.
 *
 * A recipe IS a Surfaces seed (src/surfaces/core/seed-manifest.ts) whose
 * manifest carries a `recipe` block; this module only describes the catalog
 * and applies one to a new nest through the seed engine (applySeed). Nothing
 * is written here: folders, documents, boards, channels and task stages are
 * the seed engine's items, with its idempotency and human-edit rules.
 */
import { NotFoundError, ValidationError } from "../shared/errors.js";
import { CONTEXT_TARGET, DISTILL_TARGET, type SeedAgent } from "../surfaces/core/seed-manifest.js";
import { applySeed, listRecipeSeedsFor, loadSeed, type ApplyResult, type LoadedSeed } from "../surfaces/services/seed-service.js";

export const BLANK_RECIPE_ID = "blank";
export const RECIPE_NOT_FOUND = "Recipe not found";

export interface RecipeView {
  /** What create-nest takes as `recipe`: the seed id, or "<library nest id>:<seed id>". */
  id: string;
  name: string;
  purpose: string;
  description: string | null;
  version: number;
  source: "bundled" | "library" | "none";
  gets: {
    folders: string[];
    /** Starter document titles (the nest's CONTEXT.md is `instructions`). */
    documents: string[];
    instructions: boolean;
    definitions: number;
    boards: Array<{ name: string; stages: string[] }>;
    channels: Array<{ name: string; purpose: string }>;
    agents: SeedAgent[];
    /** The recipe brings its own distill ontology (what a distill writes, in what order). */
    distill: boolean;
  };
}

const BLANK: RecipeView = {
  id: BLANK_RECIPE_ID,
  name: "Blank",
  purpose: "An empty nest. Add your own folders, documents and boards.",
  description: null,
  version: 1,
  source: "none",
  gets: { folders: [], documents: [], instructions: false, definitions: 0, boards: [], channels: [], agents: [], distill: false },
};

function viewOf(s: LoadedSeed): RecipeView {
  const m = s.manifest;
  return {
    id: s.libraryNestId ? `${s.libraryNestId}:${m.id}` : m.id,
    name: m.recipe!.name,
    purpose: m.recipe!.purpose,
    description: m.description,
    version: m.version,
    source: s.source,
    gets: {
      folders: m.folders.filter((f) => !f.admin_only).map((f) => f.path),
      documents: m.nodes.filter((n) => n.target !== CONTEXT_TARGET && n.target !== DISTILL_TARGET).map((n) => s.contents.get(n.id)?.title ?? n.target),
      instructions: m.nodes.some((n) => n.target === CONTEXT_TARGET),
      definitions: m.definitions.length,
      boards: m.boards.map((b) => ({ name: b.name, stages: [...b.stages] })),
      channels: m.channels.map((c) => ({ ...c })),
      agents: m.agents.map((a) => ({ ...a, channels: [...a.channels] })),
      distill: !!m.distill,
    },
  };
}

/** The catalog for this caller: the recipes in their order, then Blank. */
export async function listRecipes(userId: string): Promise<RecipeView[]> {
  const seeds = await listRecipeSeedsFor(userId);
  seeds.sort((a, b) => a.manifest.recipe!.order - b.manifest.recipe!.order || a.manifest.recipe!.name.localeCompare(b.manifest.recipe!.name));
  return [...seeds.map(viewOf), BLANK];
}

export interface RecipeRef {
  seedId: string;
  libraryNestId: string | null;
}

/** `recipe` as a caller sent it → a seed reference, or null for none / Blank. */
export function parseRecipeRef(raw: unknown): RecipeRef | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 200) throw new ValidationError("recipe must be a recipe id from GET /recipes");
  const v = raw.trim();
  if (!v || v === BLANK_RECIPE_ID) return null;
  const i = v.indexOf(":");
  return i > 0 ? { libraryNestId: v.slice(0, i), seedId: v.slice(i + 1) } : { libraryNestId: null, seedId: v };
}

/** Is this a recipe the caller may use? 404 (the same for absent, unreadable and not-a-recipe) before anything is created. */
export async function assertRecipe(ref: RecipeRef, userId: string): Promise<void> {
  let seed: LoadedSeed;
  try {
    seed = await loadSeed({ seedId: ref.seedId, libraryNestId: ref.libraryNestId, userId });
  } catch (err) {
    if (err instanceof NotFoundError) throw new NotFoundError(RECIPE_NOT_FOUND);
    throw err;
  }
  if (!seed.manifest.recipe) throw new NotFoundError(RECIPE_NOT_FOUND);
}

export interface RecipeApplied {
  id: string;
  status: ApplyResult["status"] | "failed";
  items: ApplyResult["items"];
  drafts: number;
  suggested_agents: SeedAgent[];
  error?: string;
}

/**
 * Apply a recipe to a nest the caller just created. Never throws: the nest
 * exists either way, and a failed or partial apply is said in the result (a
 * re-apply through POST /surfaces/seeds/apply completes it).
 */
export async function applyRecipe(nestId: string, ref: RecipeRef, actorUserId: string, credential: { keyId: string | null; agentSurface: boolean }): Promise<RecipeApplied> {
  const id = ref.libraryNestId ? `${ref.libraryNestId}:${ref.seedId}` : ref.seedId;
  try {
    const out = await applySeed({ nestId, seedId: ref.seedId, libraryNestId: ref.libraryNestId, actorUserId, credential });
    return { id, status: out.status, items: out.items, drafts: out.drafts, suggested_agents: out.suggested_agents };
  } catch (err) {
    console.error(`[recipes] recipe not applied to a new nest (${err instanceof Error ? err.name : "error"})`);
    return { id, status: "failed", items: [], drafts: 0, suggested_agents: [], error: err instanceof Error ? err.message : "The recipe could not be applied." };
  }
}

/** One line for an MCP reply. */
export function recipeAppliedText(r: RecipeApplied): string {
  if (r.status === "failed") return `The recipe ${r.id} was not applied: ${r.error ?? "unknown error"}. The nest was created; apply it again with context_surfaces_seed_apply.`;
  const made = r.items.filter((i) => i.action === "created").length;
  const skipped = r.items.filter((i) => i.action === "skipped").length;
  const agents = r.suggested_agents.map((a) => `@${a.handle} (${a.kind})`).join(", ");
  return [
    `Recipe ${r.id}: ${r.status}, ${made} item(s) created${r.drafts ? `, ${r.drafts} as drafts for review` : ""}${skipped ? `, ${skipped} channel(s) skipped because team chat is off` : ""}.`,
    agents ? `Agents worth hiring: ${agents} (context_hire_agent).` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
