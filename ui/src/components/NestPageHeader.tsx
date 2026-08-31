/**
 * The title row shared by every nest-scoped page (Nest, Board, Graph,
 * Definitions, Workflows).
 *
 * Each of those pages used to roll its own row, so the nest name showed up
 * five different ways — "Board" beside it, "Ontology · " ahead of it,
 * " Workflows" after it. The view switcher above already says which view
 * you're on, so the name stands alone here and only the right-hand controls
 * change per view.
 */
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  nestName: string;
  /** Leaves the nest entirely — the switcher handles view-to-view moves. */
  onBack: () => void;
  /** Replaces the plain name; NestView passes its inline rename field. */
  title?: ReactNode;
  /** Status chips (visibility, imported) rendered after the title. */
  badges?: ReactNode;
  /** Right-aligned, view-specific actions. */
  children?: ReactNode;
}

export function NestPageHeader({
  nestName,
  onBack,
  title,
  badges,
  children,
}: Props) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="shrink-0 px-2"
          title="Back to nests"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        {title ?? (
          <h1
            className="min-w-0 truncate text-xl font-semibold"
            title={nestName}
          >
            {nestName}
          </h1>
        )}
        {badges}
      </div>
      {/* ml-auto, not just the parent's justify-between: once the actions wrap
          onto their own line they're the only item on it, and justify-between
          parks a lone item at the start — so a wrapped toolbar drifted to the
          left edge and read as a mistake. */}
      {children && (
        <div className="flex flex-wrap items-center gap-2 w-full sm:ml-auto sm:w-auto sm:shrink-0 sm:justify-end">
          {children}
        </div>
      )}
    </div>
  );
}
