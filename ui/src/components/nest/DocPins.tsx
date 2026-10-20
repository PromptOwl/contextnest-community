/**
 * Experimental document pins (CU-wdqcq02crw) — the UI half.
 *
 *   <PinnedStrip>    the "Pinned" strip above a nest's document list: the
 *                    editorial pins first (drag to reorder, for stewards), then
 *                    the caller's own; unpin inline; hidden when empty.
 *   <DocPinControl>  the pin button on a document's header: "Pin for everyone"
 *                    (stewards only) and "Pin for me" (anyone who reads it).
 *
 * Both render nothing unless /health says experimental.doc_pins is on, so the
 * switch hides every trace of the feature — the routes 404 at the same moment.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Pin, PinOff, GripVertical, X, Users, User } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import * as api from "../../lib/api";
import { reads } from "../../lib/queries";
import { movePin, pinStateFor } from "../../lib/doc-pins";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

function errorText(e: unknown, fallback: string) {
  return e instanceof Error && e.message ? e.message : fallback;
}

export function PinnedStrip({
  nestId,
  onOpenDocument,
}: {
  nestId: string;
  onOpenDocument: (nodeId: string) => void;
}) {
  const { docPinsEnabled } = useAuth();
  const { data } = useQuery({ ...reads.docPins(nestId), enabled: docPinsEnabled });
  const [dragging, setDragging] = useState<string | null>(null);
  // Optimistic order while a reorder is in flight, so the chip doesn't jump
  // back for the moment before the refetch lands.
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);

  if (!docPinsEnabled || !data) return null;
  const { personal, can_pin_editorial: canCurate } = data;
  const editorial = pendingOrder
    ? pendingOrder
        .map((id) => data.editorial.find((p) => p.node_id === id))
        .filter((p): p is api.DocPin => !!p)
    : data.editorial;
  if (editorial.length === 0 && personal.length === 0) return null;

  const unpin = async (nodeId: string, scope: api.DocPinScope) => {
    try {
      await api.unpinDoc(nestId, nodeId, scope);
    } catch (e) {
      toast.error(errorText(e, "Couldn't unpin"));
    }
  };

  const drop = async (target: string | null) => {
    const dragged = dragging;
    setDragging(null);
    if (!dragged) return;
    const ids = editorial.map((p) => p.node_id);
    const next = movePin(ids, dragged, target);
    if (next === ids) return;
    setPendingOrder(next);
    try {
      await api.reorderDocPins(nestId, next);
    } catch (e) {
      toast.error(errorText(e, "Couldn't reorder the pins"));
    } finally {
      setPendingOrder(null);
    }
  };

  const chip = (p: api.DocPin, draggable: boolean) => (
    <div
      key={`${p.scope}:${p.node_id}`}
      draggable={draggable}
      onDragStart={draggable ? () => setDragging(p.node_id) : undefined}
      onDragEnd={draggable ? () => setDragging(null) : undefined}
      onDragOver={draggable && dragging ? (e) => e.preventDefault() : undefined}
      onDrop={
        draggable
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              void drop(p.node_id);
            }
          : undefined
      }
      className={cn(
        "group flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-sm",
        draggable && "cursor-grab",
        dragging === p.node_id && "opacity-50",
      )}
      data-testid={`pinned-${p.scope}-${p.node_id}`}
    >
      {draggable && <GripVertical className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />}
      <button
        type="button"
        className="max-w-[16rem] truncate hover:underline"
        onClick={() => onOpenDocument(p.node_id)}
        title={p.title}
      >
        {p.title}
      </button>
      {(p.scope === "user" || canCurate) && (
        <button
          type="button"
          className="ml-0.5 rounded p-0.5 text-muted-foreground opacity-60 hover:bg-accent hover:opacity-100"
          onClick={() => void unpin(p.node_id, p.scope)}
          aria-label={p.scope === "nest" ? `Unpin ${p.title} for everyone` : `Unpin ${p.title} for me`}
          title={p.scope === "nest" ? "Unpin for everyone" : "Unpin for me"}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );

  return (
    <div className="rounded-lg border bg-muted/30 p-3 space-y-2" data-testid="pinned-strip">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Pin className="h-3.5 w-3.5" /> Pinned
      </div>
      {editorial.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          onDragOver={canCurate && dragging ? (e) => e.preventDefault() : undefined}
          onDrop={canCurate ? (e) => { e.preventDefault(); void drop(null); } : undefined}
        >
          <Users className="h-3.5 w-3.5 text-muted-foreground" aria-label="Pinned for everyone" />
          {editorial.map((p) => chip(p, canCurate))}
        </div>
      )}
      {personal.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <User className="h-3.5 w-3.5 text-muted-foreground" aria-label="Pinned for me" />
          {personal.map((p) => chip(p, false))}
        </div>
      )}
    </div>
  );
}

export function DocPinControl({ nestId, nodeId }: { nestId: string; nodeId: string }) {
  const { docPinsEnabled } = useAuth();
  const { data } = useQuery({ ...reads.docPins(nestId), enabled: docPinsEnabled });
  if (!docPinsEnabled || !data) return null;
  const state = pinStateFor(data, nodeId);

  const toggle = async (scope: api.DocPinScope, pinned: boolean) => {
    try {
      if (pinned) await api.unpinDoc(nestId, nodeId, scope);
      else await api.pinDoc(nestId, nodeId, scope);
    } catch (e) {
      toast.error(errorText(e, pinned ? "Couldn't unpin" : "Couldn't pin"));
    }
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant={state.any ? "secondary" : "ghost"}
          size="sm"
          className="h-8"
          title={state.any ? "Pinned — change" : "Pin this document"}
          aria-label="Pin this document"
          data-testid="document-pin-control"
        >
          {state.any ? <Pin className="h-4 w-4 fill-current" /> : <Pin className="h-4 w-4" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Pins (experimental)
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {data.can_pin_editorial && (
          <DropdownMenuItem onClick={() => void toggle("nest", state.editorial)}>
            {state.editorial ? <PinOff className="h-4 w-4 mr-2" /> : <Users className="h-4 w-4 mr-2" />}
            {state.editorial ? "Unpin for everyone" : "Pin for everyone"}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => void toggle("user", state.personal)}>
          {state.personal ? <PinOff className="h-4 w-4 mr-2" /> : <User className="h-4 w-4 mr-2" />}
          {state.personal ? "Unpin for me" : "Pin for me"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
