/**
 * RecipePicker — the recipe cards on the New nest dialog and the welcome
 * screen (PO-1411). One radio group: Product factory, GTM factory,
 * Operations, Ideation (whatever GET /recipes lists), then Blank. The chosen
 * recipe shows its board's stage columns and what else it brings.
 *
 * Pure logic lives in lib/recipes.ts; the catalog is one cached query.
 */
import { useQuery } from "@tanstack/react-query";
import { Check, Factory, File, Layers, Lightbulb, Loader2, Megaphone, Workflow, type LucideIcon } from "lucide-react";
import * as api from "../../lib/api";
import { BLANK_RECIPE_ID, orderedRecipes, recipeSummary, stageLabel, type Recipe } from "../../lib/recipes";
import { cn } from "@/lib/utils";

export const RECIPES_QUERY_KEY = ["recipes"] as const;

/** The bundled recipes' marks; a library recipe gets the generic one. */
const ICONS: Record<string, LucideIcon> = {
  "product-factory": Factory,
  "gtm-factory": Megaphone,
  operations: Workflow,
  ideation: Lightbulb,
  [BLANK_RECIPE_ID]: File,
};

export function useRecipes() {
  return useQuery({ queryKey: RECIPES_QUERY_KEY, queryFn: () => api.listRecipes(), staleTime: 5 * 60_000 });
}

interface Props {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** Smaller detail block (the dialog). */
  compact?: boolean;
}

export function RecipePicker({ value, onChange, disabled, compact }: Props) {
  const q = useRecipes();
  const recipes = orderedRecipes(q.data?.recipes ?? []);
  const selected = recipes.find((r) => r.id === value) ?? null;

  if (q.isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading recipes
      </p>
    );
  }
  if (q.isError || recipes.length === 0) {
    return <p className="text-sm text-muted-foreground">Recipes could not be loaded. The nest will start empty.</p>;
  }

  const move = (delta: number) => {
    const i = Math.max(0, recipes.findIndex((r) => r.id === value));
    const next = recipes[(i + delta + recipes.length) % recipes.length];
    onChange(next.id);
    requestAnimationFrame(() => document.getElementById(`recipe-${next.id}`)?.focus());
  };

  return (
    <div className="space-y-3">
      <div
        role="radiogroup"
        aria-label="Recipe"
        className="grid gap-2 sm:grid-cols-2"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowRight") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
            e.preventDefault();
            move(-1);
          }
        }}
      >
        {recipes.map((r) => {
          const Icon = ICONS[r.id] ?? Layers;
          const on = r.id === value;
          return (
            <button
              key={r.id}
              id={`recipe-${r.id}`}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on || (!selected && r === recipes[0]) ? 0 : -1}
              disabled={disabled}
              data-testid={`recipe-${r.id}`}
              onClick={() => onChange(r.id)}
              className={cn(
                "flex min-w-0 flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
                on && "border-primary bg-muted/40",
                r.id === BLANK_RECIPE_ID && "sm:col-span-2",
              )}
            >
              <span className="flex w-full items-center gap-2">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate text-sm font-medium">{r.name}</span>
                {on && <Check className="ml-auto h-4 w-4 shrink-0 text-primary" aria-hidden />}
              </span>
              <span className="text-xs leading-snug text-muted-foreground">{r.purpose}</span>
              <span className="text-[11px] leading-snug text-muted-foreground/80">{recipeSummary(r).join(" · ")}</span>
            </button>
          );
        })}
      </div>
      {selected && selected.id !== BLANK_RECIPE_ID && <RecipeDetail recipe={selected} compact={compact} />}
    </div>
  );
}

function RecipeDetail({ recipe, compact }: { recipe: Recipe; compact?: boolean }) {
  const g = recipe.gets;
  const board = g.boards[0];
  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 px-3 py-2.5 text-xs" data-testid="recipe-detail" aria-live="polite">
      {board && (
        <div className="space-y-1.5">
          <p className="font-medium text-foreground">{board.name}</p>
          <ol className="flex flex-wrap items-center gap-1" aria-label={`${board.name} stages`}>
            {board.stages.map((s, i) => (
              <li key={s} className="flex items-center gap-1">
                <span className="rounded border bg-background px-1.5 py-0.5 text-[11px] text-foreground">{stageLabel(s)}</span>
                {i < board.stages.length - 1 && <span className="text-muted-foreground/60" aria-hidden>→</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
      <dl className={cn("grid gap-x-4 gap-y-1 text-muted-foreground", compact ? "grid-cols-1" : "sm:grid-cols-[auto_1fr]")}>
        {g.documents.length > 0 && (
          <>
            <dt className="font-medium text-foreground">Documents</dt>
            <dd className="min-w-0">{g.documents.join(", ")}</dd>
          </>
        )}
        {g.channels.length > 0 && (
          <>
            <dt className="font-medium text-foreground">Channels</dt>
            <dd className="min-w-0">
              {g.channels.map((c) => `#${c.name}`).join(", ")} <span className="text-muted-foreground/80">(when team chat is on)</span>
            </dd>
          </>
        )}
        {g.agents.length > 0 && (
          <>
            <dt className="font-medium text-foreground">Agents to hire</dt>
            <dd className="min-w-0">{g.agents.map((a) => `@${a.handle}`).join(", ")}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
