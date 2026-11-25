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
import { MarkdownEditor } from "../MarkdownEditor";
import { AssigneeMenu, type Person } from "./CardParts";
import { usePriorityLevels } from "../../lib/priorities";
import { FolderSelect } from "../FolderSelect";

export interface NewTask {
  title: string;
  content: string;
  assignee?: string;
  priority?: string;
  due?: string;
  /** Tag (no `#`) of the surface picked; the caller adds it to the task. */
  surfaceTag?: string;
  /** The folder picked; "" is the nest root. Left out: the column's own. */
  folder?: string;
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
    ...(f.folder !== undefined ? { folder: f.folder } : {}),
  };
}

/**
 * The dialog fits its description field, which is what people drag to resize,
 * both ways (po-1205). Pinned at its top left, not centred: a centred box moves
 * away from the pointer at half its speed. The dialog itself does not scroll,
 * so its pickers are never clipped, and carries no transform, so the editor's
 * fixed menus open where the caret is.
 */
export const RESIZABLE_DIALOG = [
  "left-4 top-[6vh] !w-fit min-w-[min(32rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] !transform-none",
  "sm:left-[calc(50vw-16rem)] sm:max-w-[calc(50vw+15rem)]",
  "data-[state=open]:slide-in-from-left-0 data-[state=open]:slide-in-from-top-0 data-[state=closed]:slide-out-to-left-0 data-[state=closed]:slide-out-to-top-0",
].join(" ");

/** The description field: full width to start, then as wide and tall as it is dragged. */
export const RESIZABLE_FIELD = "h-64 min-h-40 max-h-[55vh] resize overflow-auto rounded-md border border-input min-w-full w-0 max-w-[calc(100vw-4rem)] sm:max-w-[calc(50vw+11.5rem)]";

interface Props {
  nestId: string;
  /** Set when adding a sub-item. */
  parentTitle?: string;
  initial?: { assignee?: string; priority?: string; folder?: string };
  people: Person[];
  me?: string;
  /** The nest's surfaces, each with the tag it adds. Empty: no picker. */
  surfaces?: { name: string; tag: string }[];
  /** Tag preselected in the picker. */
  defaultSurface?: string;
  /** Every folder of the nest. Not set: no folder picker. */
  folders?: readonly string[];
  /** Creates the task. `another`: the dialog stays open for the next one. */
  onSubmit: (task: NewTask, another: boolean) => Promise<void>;
  onClose: () => void;
}

export function CreateTaskDialog({ parentTitle, initial, onSubmit, onClose, ...rest }: Props) {
  const [saving, setSaving] = useState(false);
  // "Create and add another" remounts the form: every field starts over and
  // the title takes the focus. Only the folder carries on, like the column.
  const [round, setRound] = useState(0);
  const [folder, setFolder] = useState(initial?.folder ?? "");

  const submit = async (task: NewTask, another: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      await onSubmit(task, another);
      if (another) {
        setRound((n) => n + 1);
        setSaving(false);
      }
    } catch {
      setSaving(false); // the caller toasts; keep the dialog and what was typed
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className={RESIZABLE_DIALOG} data-testid="create-task-dialog"
        // Escape in the description closes an editor menu, not the dialog with the text in it.
        onEscapeKeyDown={(e) => {
          if ((e.target as HTMLElement | null)?.closest?.("[data-task-description]")) e.preventDefault();
        }}
      >
        {/* w-0 min-w-full: only the description sets the dialog's width. */}
        <DialogHeader className="w-0 min-w-full">
          <DialogTitle>{parentTitle ? `New sub-item of “${parentTitle}”` : "New task"}</DialogTitle>
        </DialogHeader>
        <TaskForm
          key={round}
          {...rest}
          initial={initial}
          folder={folder}
          onFolder={setFolder}
          saving={saving}
          onSubmit={(task, another) => void submit(task, another)}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}

export function TaskForm({
  nestId,
  initial,
  people,
  me,
  surfaces = [],
  defaultSurface,
  folders,
  folder,
  onFolder,
  saving,
  onSubmit,
  onClose,
}: Omit<Props, "onSubmit" | "parentTitle"> & {
  folder: string;
  onFolder: (folder: string) => void;
  saving: boolean;
  onSubmit: (task: NewTask, another: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [assignee, setAssignee] = useState(initial?.assignee);
  const levels = usePriorityLevels();
  const [priority, setPriority] = useState(initial?.priority ?? "");
  const [due, setDue] = useState("");
  const [surfaceTag, setSurfaceTag] = useState(defaultSurface ?? "");

  const submit = (another: boolean) => {
    const task = newTaskPayload({ title, content, assignee, priority, due, surfaceTag, ...(folders ? { folder } : {}) });
    if (task) onSubmit(task, another);
  };

  return (
    <form
      className="min-w-0 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        // React bubbles a submit from the editor's own dialogs (link, image).
        if (e.target === e.currentTarget) submit(false);
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
      {/* The document editor, so formatting and paste work as on the task's page. */}
      <div
        role="group"
        aria-label="Description"
        className={RESIZABLE_FIELD}
        data-task-description
        // Enter in the editor's find/replace fields is not "create the task".
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") e.preventDefault();
        }}
      >
        <MarkdownEditor
          content={content}
          onChange={setContent}
          editable={!saving}
          nestId={nestId}
          placeholder="Description"
          autofocus={false}
          compact
          className="min-h-full rounded-none border-0 shadow-none"
        />
      </div>
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
      {folders && (
        <div className="w-0 min-w-full">
          <FolderSelect value={folder} onChange={onFolder} folders={folders} disabled={saving} testId="create-task-folder" />
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => submit(true)}
          disabled={!title.trim() || saving}
          data-testid="create-task-another"
        >
          Create and add another
        </Button>
        <Button type="submit" disabled={!title.trim() || saving}>
          {saving ? "Creating…" : "Create task"}
        </Button>
      </DialogFooter>
    </form>
  );
}
