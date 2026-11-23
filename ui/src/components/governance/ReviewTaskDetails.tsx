/**
 * What a task is, on the review pane. A task's body is often a line or two, so
 * the fields people decide on (owner, due date, priority, stage, tags) sit in
 * a card of their own instead of leaving the pane looking empty.
 */
import { ListChecks } from "lucide-react";
import { currentStage, stageLabel, stageNamespace } from "../../lib/task-details";

export interface ReviewTaskNode {
  type?: string;
  assignee?: string | null;
  due?: string | null;
  priority?: string | null;
  tags?: string[];
}

/** True for a task, or anything carrying task fields. */
export const isTaskLike = (n?: ReviewTaskNode | null): boolean =>
  !!n && (n.type === "task" || !!n.assignee || !!n.due || !!n.priority);

export function taskDetailRows(n: ReviewTaskNode): Array<{ label: string; value: string }> {
  const tags = n.tags ?? [];
  const stage = currentStage(tags, stageNamespace());
  const plain = tags.filter((t) => !/^#?(stage|ticket):/i.test(t)).map((t) => (t.startsWith("#") ? t : `#${t}`));
  const rows: Array<{ label: string; value: string }> = [];
  if (n.assignee) rows.push({ label: "Owner", value: n.assignee });
  if (n.due) rows.push({ label: "Due", value: n.due });
  if (n.priority) rows.push({ label: "Priority", value: stageLabel(n.priority) });
  if (stage) rows.push({ label: "Stage", value: stageLabel(stage) });
  if (plain.length) rows.push({ label: "Tags", value: plain.join(" ") });
  return rows;
}

export function ReviewTaskDetails({ node }: { node: ReviewTaskNode }) {
  const rows = taskDetailRows(node);
  return (
    <div className="rounded-lg border bg-background px-4 py-3" data-testid="review-pane-task-details">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        <ListChecks className="h-3.5 w-3.5" /> Task details
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No owner, due date or priority set yet.</p>
      ) : (
        <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="min-w-0 break-words">{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
