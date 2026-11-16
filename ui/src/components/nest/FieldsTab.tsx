/**
 * Fields tab — the nest's custom field definitions (src/nodes/custom-fields.ts).
 *
 * Everyone who reads the nest sees the list (it explains the values on its
 * documents); nest admins, the owner and nest-wide reviewer stewards add,
 * edit and remove. The server decides who may (`can_manage` on GET /fields)
 * and re-checks every write.
 *
 * Estimate and time-in-status are not separate features: they are the two
 * one-click presets in "Add field".
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CalendarDays,
  CheckSquare,
  ChevronDown,
  Clock3,
  Gauge,
  Hash,
  Link2,
  List,
  ListChecks,
  MoreHorizontal,
  Plus,
  SlidersHorizontal,
  Type,
  UserRound,
} from "lucide-react";
import * as api from "../../lib/api";
import { TaskNumberingCard } from "./TaskNumberingCard";
import { reads } from "../../lib/queries";
import {
  FIELD_TYPE_HINTS,
  FIELD_TYPE_LABELS,
  WRITABLE_TYPES,
  optionDot,
  type FieldDefinition,
  type FieldType,
} from "../../lib/custom-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const TYPE_ICONS: Record<FieldType, typeof Type> = {
  text: Type,
  number: Hash,
  select: List,
  multi_select: ListChecks,
  date: CalendarDays,
  user: UserRound,
  url: Link2,
  checkbox: CheckSquare,
  time_in_status: Clock3,
};

export function FieldTypeIcon({ type, className }: { type: FieldType; className?: string }) {
  const Icon = TYPE_ICONS[type] ?? Type;
  return <Icon className={cn("h-4 w-4", className)} />;
}

/** "Severity Level" → "severity_level" — what the key box suggests. */
export function keyFromLabel(label: string): string {
  const k = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "");
  return k.slice(0, 40);
}

interface Draft {
  label: string;
  key: string;
  keyTouched: boolean;
  type: FieldType;
  options: string;
  unit: string;
  required: boolean;
  allTypes: boolean;
  defaultValue: string;
}

const EMPTY: Draft = {
  label: "",
  key: "",
  keyTouched: false,
  type: "select",
  options: "",
  unit: "",
  required: false,
  allTypes: false,
  defaultValue: "",
};

function draftOf(def: FieldDefinition): Draft {
  return {
    label: def.label,
    key: def.key,
    keyTouched: true,
    type: def.type,
    options: def.options.join("\n"),
    unit: def.unit ?? "",
    required: def.required,
    allTypes: def.applies_to.includes("*"),
    defaultValue:
      def.default_value == null
        ? ""
        : Array.isArray(def.default_value)
          ? def.default_value.join(", ")
          : String(def.default_value),
  };
}

function inputOf(d: Draft, creating: boolean): api.FieldDefinitionInput {
  const usesOptions = d.type === "select" || d.type === "multi_select";
  const options = d.options
    .split("\n")
    .map((o) => o.trim())
    .filter(Boolean);
  let defaultValue: unknown = d.defaultValue.trim() === "" ? null : d.defaultValue.trim();
  if (defaultValue !== null && d.type === "number") defaultValue = Number(defaultValue);
  if (defaultValue !== null && d.type === "checkbox") defaultValue = defaultValue === "true";
  if (defaultValue !== null && d.type === "multi_select") {
    defaultValue = String(defaultValue)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return {
    label: d.label.trim(),
    ...(creating ? { key: d.key.trim(), type: d.type } : {}),
    ...(usesOptions ? { options } : {}),
    ...(d.type === "number" ? { unit: d.unit.trim() || null } : {}),
    ...(d.type === "time_in_status" ? {} : { required: d.required, default_value: defaultValue }),
    applies_to: d.allTypes ? ["*"] : ["task"],
  };
}

export function FieldsTab({ nestId }: { nestId: string }) {
  const q = useQuery(reads.fields(nestId));
  const defs = q.data?.fields ?? [];
  const canManage = !!q.data?.can_manage;
  const hasTimeInStatus = defs.some((d) => d.type === "time_in_status");
  const hasEstimate = defs.some((d) => d.preset === "estimate" || d.key === "estimate");

  const [editing, setEditing] = useState<{ def: FieldDefinition | null; draft: Draft } | null>(null);
  const [removing, setRemoving] = useState<FieldDefinition | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function addPreset(preset: "estimate" | "time_in_status", unit?: string) {
    try {
      await api.createField(nestId, { preset, ...(unit ? { unit } : {}) });
      toast.success(preset === "estimate" ? "Estimate added" : "Time in status added");
    } catch (e: any) {
      toast.error(e?.message || "Couldn't add the field");
    }
  }

  async function save() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const creating = editing.def === null;
      const body = inputOf(editing.draft, creating);
      if (creating) await api.createField(nestId, body);
      else {
        const res = await api.updateField(nestId, editing.def!.key, body);
        if (res.invalid_values) {
          toast.warning(
            `${res.invalid_values} document${res.invalid_values === 1 ? "" : "s"} keep a value that no longer fits “${body.label}”. It stays in their history; the next edit of that field must fix it.`,
          );
        }
      }
      toast.success(creating ? `“${body.label}” added` : `“${body.label}” saved`);
      setEditing(null);
    } catch (e: any) {
      setError(e?.message || "Couldn't save the field");
    } finally {
      setBusy(false);
    }
  }

  async function remove(def: FieldDefinition) {
    try {
      await api.deleteField(nestId, def.key);
      toast.success(`“${def.label}” removed`);
    } catch (e: any) {
      toast.error(e?.message || "Couldn't remove the field");
    }
  }

  async function move(def: FieldDefinition, dir: -1 | 1) {
    const i = defs.findIndex((d) => d.key === def.key);
    const j = i + dir;
    if (j < 0 || j >= defs.length) return;
    const order = [...defs];
    [order[i], order[j]] = [order[j]!, order[i]!];
    try {
      await Promise.all(order.map((d, pos) => (d.position === pos ? null : api.updateField(nestId, d.key, { position: pos }))));
    } catch (e: any) {
      toast.error(e?.message || "Couldn't reorder");
    }
  }

  return (
    <>
      <TaskNumberingCard nestId={nestId} canManage={canManage} />
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg">Custom fields</CardTitle>
              <CardDescription>
                Structured properties on this nest's tasks — shown on cards and documents,
                groupable on boards, readable and writable by agents over MCP. Every value
                change is versioned with the document.
              </CardDescription>
            </div>
            {canManage && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className="shrink-0" data-testid="add-field">
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    Add field
                    <ChevronDown className="ml-1 h-3.5 w-3.5 opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuItem
                    onSelect={() => setEditing({ def: null, draft: { ...EMPTY } })}
                    className="gap-2.5"
                  >
                    <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="text-sm">New field</div>
                      <div className="text-xs text-muted-foreground">Text, number, select, person…</div>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    Presets
                  </DropdownMenuLabel>
                  <DropdownMenuItem
                    disabled={hasEstimate}
                    onSelect={() => void addPreset("estimate", "points")}
                    className="gap-2.5"
                  >
                    <Gauge className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="text-sm">Estimate · points</div>
                      <div className="text-xs text-muted-foreground">A number on a story-point scale</div>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={hasEstimate}
                    onSelect={() => void addPreset("estimate", "hours")}
                    className="gap-2.5"
                  >
                    <Gauge className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="text-sm">Estimate · hours</div>
                      <div className="text-xs text-muted-foreground">A number of hours</div>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={hasTimeInStatus}
                    onSelect={() => void addPreset("time_in_status")}
                    className="gap-2.5"
                  >
                    <Clock3 className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <div className="text-sm">Time in status</div>
                      <div className="text-xs text-muted-foreground">
                        Computed: how long a task has sat in its column
                      </div>
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {q.isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : defs.length === 0 ? (
            <div className="rounded-lg border border-dashed px-6 py-10 text-center">
              <SlidersHorizontal className="mx-auto h-5 w-5 text-muted-foreground" />
              <p className="mt-2 text-sm font-medium">No custom fields yet</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                {canManage
                  ? "Add a field like Severity or Customer, or start from the Estimate and Time in status presets."
                  : "A nest admin can add fields like Severity, Estimate or Customer."}
              </p>
            </div>
          ) : (
            <ul className="divide-y rounded-lg border" data-testid="field-list">
              {defs.map((def, i) => (
                <li key={def.id} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted/40 text-muted-foreground">
                    <FieldTypeIcon type={def.type} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-sm font-medium">{def.label}</span>
                      <code className="text-[11px] text-muted-foreground">{def.key}</code>
                      {def.required && (
                        <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
                          Required
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                      <span>
                        {FIELD_TYPE_LABELS[def.type]}
                        {def.unit ? ` · ${def.unit}` : ""}
                      </span>
                      <span aria-hidden>·</span>
                      <span>{def.applies_to.includes("*") ? "All node types" : `${def.applies_to.join(", ")}s`}</span>
                      {def.options.length > 0 && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="flex min-w-0 flex-wrap items-center gap-x-2">
                            {def.options.slice(0, 6).map((o) => (
                              <span key={o} className="inline-flex items-center gap-1">
                                <span className={cn("h-1.5 w-1.5 rounded-full", optionDot(def, o))} />
                                {o}
                              </span>
                            ))}
                            {def.options.length > 6 && <span>+{def.options.length - 6}</span>}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  {canManage && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label={`${def.label} options`}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem onSelect={() => setEditing({ def, draft: draftOf(def) })}>
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={i === 0} onSelect={() => void move(def, -1)}>
                          Move up
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={i === defs.length - 1} onSelect={() => void move(def, 1)}>
                          Move down
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onSelect={() => setRemoving(def)}
                          className="text-destructive focus:text-destructive"
                        >
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <FieldDialog
        editing={editing}
        busy={busy}
        error={error}
        onChange={(draft) => setEditing((e) => (e ? { ...e, draft } : e))}
        onCancel={() => {
          setEditing(null);
          setError(null);
        }}
        onSave={() => void save()}
      />

      <AlertDialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removing?.label}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The field disappears from cards, documents and boards. Values already on
              documents stay in their version history — defining the same key again brings
              them back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const d = removing;
                setRemoving(null);
                if (d) void remove(d);
              }}
            >
              Remove field
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function FieldDialog({
  editing,
  busy,
  error,
  onChange,
  onCancel,
  onSave,
}: {
  editing: { def: FieldDefinition | null; draft: Draft } | null;
  busy: boolean;
  error: string | null;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const d = editing?.draft ?? EMPTY;
  const creating = editing?.def === null;
  const usesOptions = d.type === "select" || d.type === "multi_select";
  const computed = d.type === "time_in_status";
  const set = (patch: Partial<Draft>) => onChange({ ...d, ...patch });
  const optionList = useMemo(
    () =>
      d.options
        .split("\n")
        .map((o) => o.trim())
        .filter(Boolean),
    [d.options],
  );
  const valid =
    d.label.trim() !== "" &&
    /^[a-z][a-z0-9_]{0,39}$/.test(d.key) &&
    (!usesOptions || optionList.length > 0);

  return (
    <Dialog open={!!editing} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{creating ? "New field" : `Edit “${editing?.def?.label}”`}</DialogTitle>
          <DialogDescription>
            {creating
              ? "Defined once for the whole nest. The key and type can't change later."
              : "The key and type are fixed — values on documents are stored under them."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !busy) onSave();
          }}
        >
          <div className="grid grid-cols-[1fr_11rem] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="field-label">Name</Label>
              <Input
                id="field-label"
                autoFocus
                value={d.label}
                placeholder="Severity"
                onChange={(e) =>
                  set({
                    label: e.target.value,
                    ...(creating && !d.keyTouched ? { key: keyFromLabel(e.target.value) } : {}),
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={d.type}
                disabled={!creating}
                onValueChange={(v) => set({ type: v as FieldType, defaultValue: "" })}
              >
                <SelectTrigger aria-label="Type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(creating ? WRITABLE_TYPES : [d.type]).map((t) => (
                    <SelectItem key={t} value={t}>
                      <span className="flex items-center gap-2">
                        <FieldTypeIcon type={t} className="h-3.5 w-3.5 text-muted-foreground" />
                        {FIELD_TYPE_LABELS[t]}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">{FIELD_TYPE_HINTS[d.type]}</p>

          <div className="space-y-1.5">
            <Label htmlFor="field-key">Key</Label>
            <Input
              id="field-key"
              value={d.key}
              disabled={!creating}
              className="font-mono text-sm"
              placeholder="severity"
              onChange={(e) => set({ key: e.target.value, keyTouched: true })}
            />
            <p className="text-xs text-muted-foreground">
              What agents and the API use — lowercase letters, digits and underscores.
            </p>
          </div>

          {usesOptions && (
            <div className="space-y-1.5">
              <Label htmlFor="field-options">Options</Label>
              <textarea
                id="field-options"
                rows={4}
                value={d.options}
                placeholder={"low\nmedium\nhigh"}
                onChange={(e) => set({ options: e.target.value })}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="text-xs text-muted-foreground">One per line, in the order boards show them.</p>
            </div>
          )}

          {d.type === "number" && (
            <div className="space-y-1.5">
              <Label htmlFor="field-unit">Scale</Label>
              <Input
                id="field-unit"
                value={d.unit}
                placeholder="points, hours… (optional)"
                onChange={(e) => set({ unit: e.target.value })}
              />
            </div>
          )}

          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium">Applies to every node type</div>
                <div className="text-xs text-muted-foreground">Off: tasks only.</div>
              </div>
              <Switch checked={d.allTypes} onCheckedChange={(v) => set({ allTypes: v })} />
            </div>
            {!computed && (
              <div className="flex items-center justify-between gap-4 border-t pt-3">
                <div>
                  <div className="text-sm font-medium">Required</div>
                  <div className="text-xs text-muted-foreground">
                    New documents need a value — the default fills it if set.
                    Existing documents without one aren't changed.
                  </div>
                </div>
                <Switch checked={d.required} onCheckedChange={(v) => set({ required: v })} />
              </div>
            )}
            {!computed && (
              <div className="space-y-1.5 border-t pt-3">
                <Label htmlFor="field-default" className="text-sm">
                  Default value
                </Label>
                {d.type === "select" || d.type === "checkbox" ? (
                  <Select
                    value={d.defaultValue === "" ? "__none" : d.defaultValue}
                    onValueChange={(v) => set({ defaultValue: v === "__none" ? "" : v })}
                  >
                    <SelectTrigger id="field-default">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">None</SelectItem>
                      {(d.type === "checkbox" ? ["true", "false"] : optionList).map((o) => (
                        <SelectItem key={o} value={o}>
                          {d.type === "checkbox" ? (o === "true" ? "On" : "Off") : o}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    id="field-default"
                    type={d.type === "number" ? "number" : d.type === "date" ? "date" : "text"}
                    value={d.defaultValue}
                    placeholder={d.type === "multi_select" ? "Comma-separated options" : "None"}
                    onChange={(e) => set({ defaultValue: e.target.value })}
                  />
                )}
              </div>
            )}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || busy}>
              {creating ? "Add field" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
