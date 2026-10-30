/**
 * The small, editable pieces of a project-board card: priority, due date,
 * assignee, plus the governed-move warning. Logic lives in lib/board-tasks;
 * these only render and report. (New tasks: CreateTaskDialog.)
 *
 * Borrowed patterns, on purpose: Linear's priority bars and avatar slot
 * (bottom-right), Trello's red overdue chip, ClickUp's click-a-field-
 * to-set-it-in-place.
 *
 * Every control sits inside a clickable card, and React bubbles events out of
 * portals along the component tree — so each one stops its clicks, or picking
 * a menu item would also open the document.
 */
import { useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Ban,
  CalendarDays,
  ListTree,
  UserRound,
  X,
} from "lucide-react";
import { NodeTypeGlyph } from "../nest/NodeTypeIcon";
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
  isPickedDue,
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

/** A node's type, as a small coloured glyph (cards and list rows). */
export function TypeIcon({ type }: { type: string }) {
  return <NodeTypeGlyph type={type} className="h-3.5 w-3.5" />;
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

const PRIORITY_TONES: Record<string, string> = {
  urgent: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  high: "bg-red-500/10 text-red-700 dark:text-red-300",
  medium: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  low: "bg-muted text-muted-foreground",
};

/** A set priority as a tinted pill: its bars plus the label. */
export function PriorityBadge({ priority }: { priority: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-medium ${PRIORITY_TONES[priority] ?? PRIORITY_TONES.low}`}
    >
      <PriorityIcon priority={priority} />
      {PRIORITY_LABELS[priority as Priority] ?? priority}
    </span>
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
  const icon = value ? <PriorityBadge priority={value} /> : <PriorityIcon />;
  if (!editable) return value ? <span title={PRIORITY_LABELS[value as Priority]}>{icon}</span> : null;
  return (
    <Isolate>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={`rounded hover:bg-muted ${value ? "" : "p-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
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
  // Overdue carries a warning icon and label, not only red (CU-wdqcq06a1x).
  const overdue = !!due && dueState(due, today) === "overdue";
  const chip = due ? (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-medium tabular-nums ${DUE_TONES[dueState(due, today)]}`}
      title={`Due ${due}${overdue ? " — overdue" : ""}`}
    >
      {overdue ? <AlertTriangle className="h-3 w-3" aria-hidden /> : <CalendarDays className="h-3 w-3" />}
      {overdue && <span className="sr-only">Overdue:</span>}
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
                if (isPickedDue(e.target.value)) {
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
  showName,
}: {
  assignee?: string;
  people: Person[];
  me?: string;
  editable: boolean;
  onChange: (email: string | null, member?: boolean) => void;
  /** Name beside the avatar, always visible ("Unassigned" when empty) — the task view. */
  showName?: boolean;
}) {
  const [q, setQ] = useState("");
  const current = assignee ? people.find((p) => p.email.toLowerCase() === assignee) : undefined;
  const avatar = assignee ? (
    <span title={`Assigned to ${current?.name ? `${current.name} (${assignee})` : assignee}`}>
      <Avatar email={assignee} />
    </span>
  ) : (
    <span className="flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-muted-foreground/50 text-muted-foreground">
      <UserRound className="h-3.5 w-3.5" />
    </span>
  );
  const face = showName ? (
    <span className="inline-flex items-center gap-1.5 text-sm">
      {avatar}
      <span className={assignee ? "" : "text-muted-foreground"}>
        {assignee ? current?.name || assignee : "Unassigned"}
      </span>
    </span>
  ) : (
    avatar
  );
  if (!editable) return assignee || showName ? face : null;
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
          className={`rounded-full ${assignee || showName ? "" : "opacity-0 group-hover:opacity-100 focus:opacity-100"}`}
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

// ── Blocked ─────────────────────────────────────────────────────────────────

/**
 * Linear's "Blocked" flag: shown while any `blocks` relation points at this
 * task from something not yet done. Read-only — relations are edited on the
 * task itself. The count only appears past one blocker.
 */
export function BlockedBadge({ count, className = "" }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 py-0.5 text-[10px] font-medium bg-red-500/10 text-red-700 dark:text-red-300 ${className}`}
      title={`Blocked by ${count} open task${count === 1 ? "" : "s"}`}
      data-testid="blocked-badge"
    >
      <Ban className="h-3 w-3" />
      Blocked{count > 1 ? ` · ${count}` : ""}
    </span>
  );
}

// ── Sub-items ───────────────────────────────────────────────────────────────

export function SubItemChip({
  items,
  done = 0,
  onOpen,
}: {
  items: Array<{ id: string; title: string; completed_at?: string }>;
  /** How many are completed — shown as Linear/ClickUp's "2/5". */
  done?: number;
  onOpen: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <Isolate>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-muted tabular-nums"
          title={`${done} of ${items.length} sub-item${items.length === 1 ? "" : "s"} done`}
        >
          <ListTree className="h-3 w-3" />
          {done > 0 ? `${done}/${items.length}` : items.length}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" onClick={stop} className="w-64">
          <DropdownMenuLabel className="text-xs">Sub-items</DropdownMenuLabel>
          {items.map((c) => (
            <DropdownMenuItem key={c.id} onSelect={() => onOpen(c.id)} className="gap-2 text-sm">
              <span className={`truncate ${c.completed_at ? "text-muted-foreground line-through" : ""}`}>
                {c.title}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </Isolate>
  );
}

// ── Governed-move warning ───────────────────────────────────────────────────

export function GovernedMoveDialog({
  title,
  verb = "Moving",
  open,
  onCancel,
  onConfirm,
}: {
  title: string;
  /** What the person did — dragged a card, or set a field on it. */
  verb?: "Moving" | "Changing";
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
                {verb} <span className="font-medium text-foreground">“{title}”</span> edits
                it, so the change is saved as a <span className="font-medium text-foreground">draft</span>.
                A reviewer has to approve it before the published version changes.
              </p>
              <p>Tasks skip review. For project work, create tasks with “+ Add task”.</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {verb === "Moving" ? "Move as draft" : "Save as draft"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeleteBoardDialog({
  name,
  onCancel,
  onConfirm,
}: {
  name: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={name !== null} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the board “{name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Its layout, filter and card order are removed. The documents on it are not touched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button variant="destructive" onClick={onConfirm}>
              Delete board
            </Button>
          </AlertDialogAction>
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
