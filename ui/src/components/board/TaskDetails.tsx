/**
 * TaskDetails — Stage, Priority and Due on a task's own page, next to the
 * Assignee, with the task's ticket number first. Like Assignee they are not
 * document content: on a saved task they are editable in view mode and saved the
 * moment you pick, with a revert and a toast if the server says no. On a task
 * that doesn't exist yet (`onChange` given) nothing is saved: the picks are
 * handed to the caller, who sends them with the create — so a new task can be
 * filled in before it is first saved. The same server rules apply as on the
 * board (one stage per task, the nest's priority levels).
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import * as api from "../../lib/api";
import { reads, useNestSettings } from "../../lib/queries";
import { usePriorityLevels } from "../../lib/priorities";
import { currentStage, stageLabel, stageNamespace, stageOptions, withStage } from "../../lib/task-details";
import { Input } from "@/components/ui/input";
import { TicketChip } from "./CardParts";
import { ticketOf } from "../../lib/ticket";
import { priorityTone, stageTone } from "../../lib/tones";

const SELECT_BASE = "h-8 rounded-md border px-2 text-sm disabled:opacity-60";
/** A set value reads as a coloured pill (stage and priority are the two things
 *  you scan this row for); unset stays a plain box. */
const selectClass = (tone?: string) =>
  tone
    ? `${SELECT_BASE} border-transparent font-medium ${tone}`
    : `${SELECT_BASE} border-input bg-background`;

export function TaskDetails({
  nestId,
  nodeId,
  tags,
  priority,
  due,
  canEdit,
  onSaved,
  onChange,
}: {
  nestId: string;
  /** Absent while the task is still being drafted. */
  nodeId?: string;
  /** The task's tags as the page holds them (no `#`). */
  tags: string[];
  priority?: string;
  due?: string;
  canEdit: boolean;
  onSaved?: (node: any) => void;
  /** Draft mode: receive the pick instead of saving it. */
  onChange?: (patch: { tags?: string[]; priority?: string | null; due?: string | null }) => void;
}) {
  const settings = useNestSettings(nestId);
  const rules = (settings.data as any)?.task_rules as api.TaskRules | undefined;
  const meta = useQuery(reads.nodesMeta(nestId));
  const levels = usePriorityLevels();
  const ns = stageNamespace(rules);
  const stage = currentStage(tags, ns);
  const options = stageOptions(
    rules,
    (meta.data?.nodes ?? []).map((n: any) => (n.tags ?? []) as string[]),
    ns,
    stage,
  );
  const [prio, setPrio] = useState(priority ?? "");
  const [dueVal, setDueVal] = useState(due ?? "");
  useEffect(() => setPrio(priority ?? ""), [priority]);
  useEffect(() => setDueVal(due ?? ""), [due]);

  const save = async (patch: Parameters<typeof api.updateNode>[2], undo: () => void, what: string) => {
    if (onChange || !nodeId) {
      onChange?.(patch);
      return;
    }
    try {
      const res: any = await api.updateNode(nestId, nodeId, patch);
      if (res?.node) onSaved?.(res.node);
    } catch (e: any) {
      undo();
      toast.error(e?.message || `Couldn't change the ${what}`);
    }
  };

  const showStage = options.length > 0 || stage !== undefined;
  const ticket = ticketOf(tags);
  return (
    <section className="flex flex-wrap items-center gap-x-5 gap-y-2" data-testid="task-details" aria-label="Task details">
      {ticket && (
        <span className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Ticket</span>
          <TicketChip ticket={ticket} className="text-xs" />
        </span>
      )}
      {showStage && (
        <label className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Stage</span>
          <select
            className={selectClass(stageTone(stage))}
            aria-label="Stage"
            disabled={!canEdit}
            value={stage ?? ""}
            onChange={(e) => {
              const v = e.target.value || null;
              void save({ tags: withStage(tags, ns, v) }, () => {}, "stage");
            }}
          >
            <option value="">No stage</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {stageLabel(o)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Priority</span>
        <select
          className={selectClass(priorityTone(levels.map((l) => l.key), prio))}
          aria-label="Priority"
          disabled={!canEdit}
          value={prio}
          onChange={(e) => {
            const prev = prio;
            const v = e.target.value;
            setPrio(v);
            void save({ priority: v || null }, () => setPrio(prev), "priority");
          }}
        >
          <option value="">No priority</option>
          {levels.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
          {/* A level the nest no longer offers stays visible on the tasks that hold it. */}
          {prio && !levels.some((p) => p.key === prio) && <option value={prio}>{prio}</option>}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Due</span>
        <Input
          type="date"
          aria-label="Due date"
          className="h-8 w-auto"
          disabled={!canEdit}
          value={dueVal}
          onChange={(e) => {
            const prev = dueVal;
            const v = e.target.value;
            setDueVal(v);
            void save({ due: v || null }, () => setDueVal(prev), "due date");
          }}
        />
      </label>
    </section>
  );
}
