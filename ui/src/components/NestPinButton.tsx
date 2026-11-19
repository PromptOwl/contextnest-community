/**
 * The pin toggle for one nest (PO-1441), for the left rail's nest rows and the
 * nest page header. Same glyph and words as the All nests card: a Bookmark,
 * "Pin" / "Unpin" — the star already means "prime document" in this app.
 *
 * Reads `pinned` off the cached nest list (the one the rail and the grid
 * read), so every control shows the same state; renders nothing for a nest
 * that isn't in the caller's list (a public reader who isn't signed in).
 */
import { useQuery } from "@tanstack/react-query";
import { Bookmark } from "lucide-react";
import { reads } from "../lib/queries";
import { useNestPin } from "../lib/nest-pin";
import { cn } from "@/lib/utils";

interface Props {
  nestId: string;
  /** "rail": a small row control — shown while pinned, on hover/focus
   *  otherwise. "header": always shown beside the nest name. */
  variant: "rail" | "header";
  className?: string;
}

export function NestPinButton({ nestId, variant, className }: Props) {
  const list = useQuery({ ...reads.nestList() });
  const { toggle, busy } = useNestPin();
  const nest = (list.data?.nests ?? []).find((n: any) => n.id === nestId) as
    | { id: string; name: string; pinned?: boolean }
    | undefined;
  if (!nest) return null;
  const pinned = !!nest.pinned;
  const rail = variant === "rail";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void toggle(nestId, !pinned);
      }}
      disabled={busy.has(nestId)}
      aria-pressed={pinned}
      aria-label={pinned ? `Unpin nest ${nest.name}` : `Pin nest ${nest.name}`}
      title={pinned ? "Unpin — stop keeping this nest at the top" : "Pin — keep this nest at the top for you"}
      data-testid={rail ? "document-sidebar-nest-pin" : "nest-header-pin"}
      className={cn(
        "shrink-0 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
        rail
          ? cn(
              "p-0.5 hover:bg-muted",
              // Pinned rows keep the mark, so the pinned group reads as one;
              // the rest offer it on hover or keyboard focus.
              pinned ? "text-amber-400" : "opacity-0 group-hover:opacity-100 focus:opacity-100",
            )
          : cn(
              "p-1.5",
              pinned
                ? "text-amber-500 hover:bg-amber-50 hover:text-amber-600"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            ),
        className,
      )}
    >
      <Bookmark className={cn(rail ? "h-3.5 w-3.5" : "h-4 w-4", pinned && "fill-current")} />
    </button>
  );
}
