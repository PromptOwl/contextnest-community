/**
 * CreateTaskDialog — the Board's "+ Add task": a focused dialog (ClickUp/Jira)
 * for title, description, assignee, priority and due date. The column, lane,
 * filter tags and parent are the caller's — `initial` prefills what the column
 * implies (an assignee or priority column), and a changed value wins.
 */
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AssigneeMenu, type Person } from "./CardParts";
import { usePriorityLevels } from "../../lib/priorities";

export interface NewTask {
  title: string;
  content: string;
  assignee?: string;
  priority?: string;
  due?: string;
  /** Tag (no `#`) of the surface picked; the caller adds it to the task. */
  surfaceTag?: string;
}

/** What the dialog sends: trimmed title, blank optional fields left out (so the
 *  column/lane/filter values apply) — or null while there's no title. */
export function newTaskPayload(f: NewTask): NewTask | null {
  const title = f.title.trim();
  if (!title) return null;
  return {
    title,
    content: f.content,
    ...(f.assignee ? { assignee: f.assignee } : {}),
    ...(f.priority ? { priority: f.priority } : {}),
    ...(f.due ? { due: f.due } : {}),
    ...(f.surfaceTag ? { surfaceTag: f.surfaceTag } : {}),
  };
}

export function CreateTaskDialog({
  parentTitle,
  initial,
  people,
  me,
  surfaces = [],
  defaultSurface,
  onSubmit,
  onClose,
}: {
  /** Set when adding a sub-item. */
  parentTitle?: string;
  initial?: { assignee?: string; priority?: string };
  people: Person[];
  me?: string;
  /** The nest's surfaces, each with the tag it adds. Empty: no picker. */
  surfaces?: { name: string; tag: string }[];
  /** Tag preselected in the picker. */
  defaultSurface?: string;
  onSubmit: (task: NewTask) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [assignee, setAssignee] = useState(initial?.assignee);
  const levels = usePriorityLevels();
  const [priority, setPriority] = useState(initial?.priority ?? "");
  const [due, setDue] = useState("");
  const [surfaceTag, setSurfaceTag] = useState(defaultSurface ?? "");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const task = newTaskPayload({ title, content, assignee, priority, due, surfaceTag });
    if (!task || saving) return;
    setSaving(true);
    try {
      await onSubmit(task);
    } catch {
      setSaving(false); // the caller toasts; keep the dialog and what was typed
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="sm:max-w-lg" data-testid="create-task-dialog">
        <DialogHeader>
          <DialogTitle>{parentTitle ? `New sub-item of “${parentTitle}”` : "New task"}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            aria-label="Title"
            autoFocus
            disabled={saving}
          />
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Description (markdown)"
            aria-label="Description"
            rows={5}
            disabled={saving}
          />
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <AssigneeMenu
              assignee={assignee}
              people={people}
              me={me}
              editable={!saving}
              onChange={(email) => setAssignee(email ?? undefined)}
              showName
            />
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              aria-label="Priority"
              disabled={saving}
              className="h-8 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">No priority</option>
              {levels.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
            {surfaces.length > 0 && (
              <select
                value={surfaceTag}
                onChange={(e) => setSurfaceTag(e.target.value)}
                aria-label="Surface"
                disabled={saving}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">No surface</option>
                {surfaces.map((sf) => (
                  <option key={sf.tag} value={sf.tag}>
                    {sf.name}
                  </option>
                ))}
              </select>
            )}
            <Input
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              aria-label="Due date"
              disabled={saving}
              className="h-8 w-auto"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={!title.trim() || saving}>
              {saving ? "Creating…" : "Create task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
