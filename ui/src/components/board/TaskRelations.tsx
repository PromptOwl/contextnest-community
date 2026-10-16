/**
 * TaskRelations — the Relations section on a task: what it blocks, what blocks
 * it, related tasks and duplicates, grouped by kind (Linear's issue-relations
 * block). Add picks a kind, then a document from the nest; remove is the x on
 * the row. Related documents the viewer can't read come back from the server
 * as a count and render as "1 hidden", never as a title.
 *
 * Relations aren't document content, so they're editable in view mode — only
 * the caller's edit access to the task gates them (the server re-checks).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CheckCircle2, Circle, EyeOff, Plus, X } from "lucide-react";
import { toast } from "sonner";
import * as api from "../../lib/api";
import { keys, reads } from "../../lib/queries";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DocumentPickerModal } from "../DocumentPickerModal";

/** Display order and copy, blockers first — that's what someone opening a
 *  task needs to know before anything else. */
const GROUPS: Array<{ kind: api.RelationKind; label: string; pick: string }> = [
  { kind: "blocked_by", label: "Blocked by", pick: "Blocked by…" },
  { kind: "blocks", label: "Blocks", pick: "Blocks…" },
  { kind: "relates_to", label: "Related", pick: "Related to…" },
  { kind: "duplicates", label: "Duplicates", pick: "Duplicate of…" },
  { kind: "duplicated_by", label: "Duplicated by", pick: "Duplicated by…" },
];

/** What the add menu offers. `duplicated_by` stays a view — you mark the copy. */
const ADDABLE: api.RelationKind[] = ["blocked_by", "blocks", "relates_to", "duplicates"];

export function TaskRelations({
  nestId,
  nodeId,
  canEdit,
  onOpen,
}: {
  nestId: string;
  nodeId: string;
  canEdit: boolean;
  onOpen: (nodeId: string, title: string) => void;
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery(reads.nodeRelations(nestId, nodeId));
  const [picking, setPicking] = useState<api.RelationKind | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = (next: api.TaskRelations) => {
    qc.setQueryData(keys.nodeRelations(nestId, nodeId), next);
  };

  const add = async (kind: api.RelationKind, other: { id: string; title: string }) => {
    setBusy(true);
    try {
      refresh(await api.addRelation(nestId, nodeId, kind, other.id));
    } catch (e: any) {
      toast.error(e?.message || "Couldn't add the relation");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (rel: api.TaskRelation) => {
    setBusy(true);
    try {
      refresh(await api.removeRelation(nestId, nodeId, rel.id));
    } catch (e: any) {
      toast.error(e?.message || "Couldn't remove the relation");
    } finally {
      setBusy(false);
    }
  };

  const relations = data?.relations ?? [];
  const hidden = data?.hidden ?? {};
  const groups = GROUPS.map((g) => ({
    ...g,
    items: relations.filter((r) => r.type === g.kind),
    hidden: hidden[g.kind] ?? 0,
  })).filter((g) => g.items.length > 0 || g.hidden > 0);
  const empty = !isLoading && groups.length === 0;

  // Nothing to show and nothing the viewer could add: stay out of the way.
  if (empty && !canEdit) return null;

  return (
    <section className="space-y-2" data-testid="task-relations" aria-label="Relations">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">Relations</h3>
        {data?.blocked && (
          <span
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium bg-red-500/10 text-red-700 dark:text-red-300"
            title={`${data.open_blockers} open blocker${data.open_blockers === 1 ? "" : "s"}`}
          >
            <Ban className="h-3 w-3" />
            Blocked
          </span>
        )}
        {canEdit && (
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={busy}
              className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
              data-testid="task-relations-add"
            >
              <Plus className="h-3.5 w-3.5" />
              Add relation
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuLabel className="text-xs">This task is…</DropdownMenuLabel>
              {ADDABLE.map((k) => (
                <DropdownMenuItem key={k} onSelect={() => setPicking(k)} className="text-sm">
                  {GROUPS.find((g) => g.kind === k)!.pick}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {empty ? (
        <p className="text-xs text-muted-foreground/80">
          No relations yet. Mark what blocks this task, or link related and duplicate work.
        </p>
      ) : (
        <div className="divide-y rounded-lg border">
          {groups.map((g) => (
            <div key={g.kind} className="flex gap-3 px-3 py-2" data-testid={`task-relations-${g.kind}`}>
              <div className="w-24 shrink-0 pt-0.5 text-xs text-muted-foreground">{g.label}</div>
              <ul className="min-w-0 flex-1 space-y-0.5">
                {g.items.map((r) => (
                  <li key={r.id} className="group/rel flex items-center gap-2 text-sm">
                    {r.node.done ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-label="Done" />
                    ) : (
                      <Circle
                        className={`h-3.5 w-3.5 shrink-0 ${g.kind === "blocked_by" ? "text-red-600" : "text-muted-foreground"}`}
                        aria-label="Open"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => onOpen(r.node.id, r.node.title)}
                      className={`min-w-0 truncate text-left hover:underline ${r.node.done ? "text-muted-foreground line-through decoration-muted-foreground/50" : "text-foreground"}`}
                      title={r.node.id}
                    >
                      {r.node.title}
                    </button>
                    {canEdit && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => remove(r)}
                        className="ml-auto rounded p-0.5 text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus:opacity-100 group-hover/rel:opacity-100"
                        title="Remove relation"
                        aria-label={`Remove ${g.label.toLowerCase()} ${r.node.title}`}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </li>
                ))}
                {g.hidden > 0 && (
                  <li
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                    title="Documents you don't have access to"
                  >
                    <EyeOff className="h-3.5 w-3.5 shrink-0" />
                    {g.hidden} hidden
                  </li>
                )}
              </ul>
            </div>
          ))}
        </div>
      )}

      <DocumentPickerModal
        isOpen={picking !== null}
        onClose={() => setPicking(null)}
        nestId={nestId}
        excludeNodeId={nodeId}
        title={picking ? `${GROUPS.find((g) => g.kind === picking)!.pick.replace("…", "")}` : ""}
        description="Pick a document in this nest. Done blockers don't count — a task stays blocked only while something it waits on is still open."
        onSelect={(n) => {
          const kind = picking;
          setPicking(null);
          if (kind) void add(kind, n);
        }}
      />
    </section>
  );
}
