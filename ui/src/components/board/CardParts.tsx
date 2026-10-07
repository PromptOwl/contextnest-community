/**
 * The small, editable pieces of a project-board card: priority, due date,
 * assignee, plus the column's "+ Add task" composer and the governed-move
 * warning. Logic lives in lib/board-tasks; these only render and report.
 *
 * Borrowed patterns, on purpose: Linear's priority bars and avatar slot
 * (bottom-right), Trello's red overdue chip and add-card-at-the-bottom
 * composer (Enter adds and stays open, Esc closes), ClickUp's click-a-field-
 * to-set-it-in-place.
 *
 * Every control sits inside a clickable card, and React bubbles events out of
 * portals along the component tree — so each one stops its clicks, or picking
 * a menu item would also open the document.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarDays, ListTree, UserRound, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { initialsOf, personTint } from "../AuthorshipChips";
import { COLLAB_PERMISSIONS } from "../CollaboratorManager";
import {
  PRIORITIES,
  PRIORITY_LABELS,
  dueState,
  formatDue,
  type Priority,
} from "../../lib/board-tasks";

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

/** Wraps a control so neither clicks nor drags leak to the card. */
function Isolate({ children }: { children: ReactNode }) {
  return (
    <span onClick={stop} onDoubleClick={stop} className="inline-flex">
      {children}
    </span>
  );
}

// ── Priority ────────────────────────────────────────────────────────────────

/** Linear's glyphs: urgent is a filled "!" square, the rest are 1–3 bars. */
export function PriorityIcon({ priority }: { priority?: string }) {
  if (priority === "urgent") {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-orange-500" aria-label="Urgent">
        <rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" />
        <rect x="7.1" y="4" width="1.8" height="5" rx="0.9" fill="white" />
        <rect x="7.1" y="10.5" width="1.8" height="1.8" rx="0.9" fill="white" />
      </svg>
    );
  }
  const filled = priority === "high" ? 3 : priority === "medium" ? 2 : priority === "low" ? 1 : 0;
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 text-foreground/70"
      aria-label={priority ? PRIORITY_LABELS[priority as Priority] : "No priority"}
    >
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={2 + i * 4.5}
          y={10 - i * 3}
          width="3"
          height={4 + i * 3}
          rx="1"
          fill="currentColor"
          opacity={filled === 0 ? 0.25 : i < filled ? 1 : 0.2}
        />
      ))}
    </svg>
  );
}

export function PriorityMenu({
  value,
  editable,
  onChange,
}: {
  value?: string;
  editable: boolean;
  onChange: (p: Priority | null) => void;
}) {
  const icon = <PriorityIcon priority={value} />;
  if (!editable) return value ? <span title={PRIORITY_LABELS[value as Priority]}>{icon}</span> : null;
  return (
    <Isolate>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={`rounded p-0.5 hover:bg-muted ${value ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
          title={value ? `Priority: ${PRIORITY_LABELS[value as Priority]}` : "Set priority"}
        >
          {icon}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" onClick={stop} className="w-40">
          {PRIORITIES.map((p) => (
            <DropdownMenuItem key={p} onSelect={() => onChange(p)} className="gap-2">
              <PriorityIcon priority={p} /> {PRIORITY_LABELS[p]}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onChange(null)} className="gap-2">
            <PriorityIcon /> No priority
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </Isolate>
  );
}

// ── Due date ────────────────────────────────────────────────────────────────

const DUE_TONES = {
  overdue: "bg-red-500/15 text-red-700 dark:text-red-300",
  today: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  soon: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  later: "bg-muted text-muted-foreground",
} as const;

export function DueChip({
  due,
  today,
  editable,
  onChange,
}: {
  due?: string;
  today: string;
  editable: boolean;
  onChange: (d: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const chip = due ? (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-medium tabular-nums ${DUE_TONES[dueState(due, today)]}`}
      title={`Due ${due}${dueState(due, today) === "overdue" ? " — overdue" : ""}`}
    >
      <CalendarDays className="h-3 w-3" />
      {formatDue(due, today)}
    </span>
  ) : (
    <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
  );
  if (!editable) return due ? chip : null;
  return (
    <Isolate>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className={`rounded hover:bg-muted ${due ? "" : "p-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
          title={due ? undefined : "Set due date"}
        >
          {chip}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-2" onClick={stop}>
          <div className="flex items-center gap-1">
            <Input
              type="date"
              defaultValue={due ?? ""}
              autoFocus
              className="h-8"
              onChange={(e) => {
                if (e.target.value) {
                  onChange(e.target.value);
                  setOpen(false);
                }
              }}
            />
            {due && (
              <Button
                variant="ghost"
                size="sm"
                title="Clear due date"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </Isolate>
  );
}

// ── Assignee ────────────────────────────────────────────────────────────────

export function Avatar({ email, size = "md" }: { email: string; size?: "sm" | "md" }) {
  const dims = size === "sm" ? "h-5 w-5 text-[9px]" : "h-6 w-6 text-[10px]";
  return (
    <span
      className={`flex ${dims} shrink-0 items-center justify-center rounded-full border border-background font-medium leading-none ${personTint(email)}`}
    >
      {initialsOf(email)}
    </span>
  );
}

export interface Person {
  email: string;
  name: string | null;
  /** False for a directory suggestion: picking them asks to share the nest first. */
  member?: boolean;
}

export function AssigneeMenu({
  assignee,
  people,
  me,
  editable,
  onChange,
}: {
  assignee?: string;
  people: Person[];
  me?: string;
  editable: boolean;
  onChange: (email: string | null, member?: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const current = assignee ? people.find((p) => p.email.toLowerCase() === assignee) : undefined;
  const face = assignee ? (
    <span title={`Assigned to ${current?.name ? `${current.name} (${assignee})` : assignee}`}>
      <Avatar email={assignee} />
    </span>
  ) : (
    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-muted-foreground/50 text-muted-foreground">
      <UserRound className="h-3.5 w-3.5" />
    </span>
  );
  if (!editable) return assignee ? face : null;
  // Me first, then the roster alphabetically — the ClickUp/Linear ordering.
  const needle = q.trim().toLowerCase();
  const list = people
    .filter(
      (p) =>
        !needle ||
        p.email.toLowerCase().includes(needle) ||
        (p.name ?? "").toLowerCase().includes(needle),
    )
    .sort((a, b) => {
      if (me && a.email.toLowerCase() === me) return -1;
      if (me && b.email.toLowerCase() === me) return 1;
      return (a.name ?? a.email).localeCompare(b.name ?? b.email);
    });
  return (
    <Isolate>
      <DropdownMenu onOpenChange={(o) => !o && setQ("")}>
        <DropdownMenuTrigger
          className={`rounded-full ${assignee ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
          title={assignee ? undefined : "Assign"}
        >
          {face}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={stop} className="w-60">
          <div className="p-1">
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              // Radix menus type-ahead on keydown; let the search box have it.
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Assign to…"
              className="h-7 text-xs"
              autoFocus
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            {list.map((p) => (
              <DropdownMenuItem
                key={p.email}
                onSelect={() => onChange(p.email.toLowerCase(), p.member !== false)}
                className="gap-2"
              >
                <Avatar email={p.email} size="sm" />
                <span className="min-w-0 truncate">
                  {p.name || p.email}
                  {me && p.email.toLowerCase() === me && (
                    <span className="text-muted-foreground"> (me)</span>
                  )}
                </span>
                {p.member === false && (
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    not on nest
                  </span>
                )}
              </DropdownMenuItem>
            ))}
            {list.length === 0 && (
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                Nobody on this nest matches.
              </DropdownMenuLabel>
            )}
          </div>
          {assignee && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onChange(null)} className="gap-2">
                <UserRound className="h-4 w-4" /> Unassign
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </Isolate>
  );
}

// ── Sub-items ───────────────────────────────────────────────────────────────

export function SubItemChip({
  items,
  onOpen,
}: {
  items: Array<{ id: string; title: string }>;
  onOpen: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <Isolate>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-muted tabular-nums"
          title={`${items.length} sub-item${items.length === 1 ? "" : "s"}`}
        >
          <ListTree className="h-3 w-3" />
          {items.length}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" onClick={stop} className="w-64">
          <DropdownMenuLabel className="text-xs">Sub-items</DropdownMenuLabel>
          {items.map((c) => (
            <DropdownMenuItem key={c.id} onSelect={() => onOpen(c.id)} className="text-sm">
              <span className="truncate">{c.title}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </Isolate>
  );
}

// ── "+ Add task" composer ───────────────────────────────────────────────────

/**
 * Trello's add-a-card: a title box at the bottom of the column. Enter creates
 * and keeps the box open for the next one; Escape (or blurring it empty)
 * closes it.
 */
export function AddCardComposer({
  placeholder,
  onSubmit,
  onClose,
}: {
  placeholder: string;
  onSubmit: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const submit = async () => {
    const t = title.trim();
    if (!t || saving) return;
    setSaving(true);
    try {
      await onSubmit(t);
      setTitle("");
    } finally {
      setSaving(false);
      ref.current?.focus();
    }
  };
  return (
    <div className="rounded-md border border-primary/60 bg-card p-1.5 shadow-sm">
      <Input
        ref={ref}
        value={title}
        disabled={saving}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            onClose();
          }
        }}
        onBlur={() => {
          if (!title.trim() && !saving) onClose();
        }}
        placeholder={placeholder}
        className="h-8 rounded-sm border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
      />
      <div className="mt-1 flex items-center gap-1">
        <Button size="sm" className="h-7" disabled={!title.trim() || saving} onMouseDown={(e) => e.preventDefault()} onClick={() => void submit()}>
          Add task
        </Button>
        <Button size="sm" variant="ghost" className="h-7" onMouseDown={(e) => e.preventDefault()} onClick={onClose} title="Close (Esc)">
          <X className="h-3.5 w-3.5" />
        </Button>
        <span className="ml-auto pr-1 text-[10px] text-muted-foreground">↵ to add</span>
      </div>
    </div>
  );
}

// ── Governed-move warning ───────────────────────────────────────────────────

export function GovernedMoveDialog({
  title,
  open,
  onCancel,
  onConfirm,
}: {
  title: string;
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>This document goes through review</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                Moving <span className="font-medium text-foreground">“{title}”</span> changes
                it, so the move is saved as a <span className="font-medium text-foreground">draft</span>.
                A reviewer has to approve it before the published version changes.
              </p>
              <p>Tasks skip review. For project work, create tasks with “+ Add task”.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Move as draft</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Owner/admin picked someone off the nest: share it with them, then assign. */
export function ShareAndAssignDialog({
  email,
  onCancel,
  onConfirm,
}: {
  email: string | null;
  onCancel: () => void;
  onConfirm: (permission: string) => void;
}) {
  const [permission, setPermission] = useState("write");
  return (
    <AlertDialog open={!!email} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Share this nest to assign them?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">{email}</span> isn't on this nest.
            Share it with them as a collaborator, then assign the card.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Select value={permission} onValueChange={setPermission}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COLLAB_PERMISSIONS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label} — {p.hint}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => onConfirm(permission)}>Share and assign</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
