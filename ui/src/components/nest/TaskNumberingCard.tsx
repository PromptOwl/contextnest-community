/**
 * Task numbering — the nest's ticket prefix, surfaces and stage rules
 * (`task_rules` in the nest settings; see API.md).
 *
 * Nothing here names a particular team's product areas. A nest picks ONE
 * prefix and the server numbers every new task `PREFIX-n`, race-free. Surfaces
 * (a name and the tags that put a task there) are a separate attribute: they
 * sort and filter tasks but are never part of the number. Admins and the owner
 * edit; everyone else sees the setup read-only. The server re-checks every write.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import * as api from "../../lib/api";
import { reads } from "../../lib/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

type Row = { name: string; tags: string };
/** A priority row. `key` is set for a level that already exists (it never
 *  changes, so tasks keep their level when it is renamed); a new row gets its
 *  key from the label on the server. */
type PrioRow = { key?: string; label: string };
type Draft = {
  stageOrder: string;
  priorities: PrioRow[];
  numbering: boolean;
  prefix: string;
  startAt: string;
  rows: Row[];
  defaultSurface: string;
  stageNamespaces: string;
  defaultStage: string;
};

const BLANK: Draft = { stageOrder: "", priorities: [], numbering: false, prefix: "", startAt: "", rows: [], defaultSurface: "", stageNamespaces: "", defaultStage: "" };

/** Starting points, not product config: a team edits them freely. */
export const TASK_PRESETS: { label: string; hint: string; draft: Draft }[] = [
  {
    label: "Engineering tickets",
    hint: "One stage per task, new tasks land in backlog, numbering on. Pick your prefix and surfaces.",
    draft: { stageOrder: "backlog, in-progress, in-review, qa-staging, ready-for-deployment, qa-production, done", priorities: [], numbering: true, prefix: "", startAt: "", rows: [], defaultSurface: "", stageNamespaces: "stage", defaultStage: "stage:backlog" },
  },
  { label: "Blank", hint: "Everything off.", draft: BLANK },
];

const split = (s: string) =>
  s.split(",").map((t) => t.trim().replace(/^#/, "").toLowerCase()).filter(Boolean);

export function draftFromRules(r: api.TaskRules | undefined): Draft {
  if (!r) return BLANK;
  return {
    stageOrder: (r.stage_order ?? []).join(", "),
    priorities: (r.priorities ?? []).map((p) => ({ key: p.key, label: p.label })),
    numbering: r.ticket_numbering,
    prefix: r.ticket_prefix ?? "",
    startAt: r.ticket_start_at ? String(r.ticket_start_at) : "",
    rows: r.surfaces.map((s) => ({ name: s.name, tags: s.tags.join(", ") })),
    defaultSurface: r.default_surface ?? "",
    stageNamespaces: r.exclusive_namespaces.join(", "),
    defaultStage: r.default_stage_tag ?? "",
  };
}

export function rulesFromDraft(d: Draft): api.TaskRules {
  return {
    exclusive_namespaces: split(d.stageNamespaces),
    default_stage_tag: d.defaultStage.trim() ? d.defaultStage.trim().replace(/^#/, "").toLowerCase() : null,
    ticket_numbering: d.numbering,
    ticket_prefix: d.prefix.trim() ? d.prefix.trim().toUpperCase() : null,
    ticket_start_at: d.startAt.trim() ? Number(d.startAt) : null,
    stage_order: split(d.stageOrder),
    priorities: d.priorities
      .filter((p) => p.label.trim())
      // A new level has no key yet — the server makes one from its label.
      .map((p) => ({ ...(p.key ? { key: p.key } : {}), label: p.label.trim() }) as { key: string; label: string }),
    default_surface: d.defaultSurface || null,
    surfaces: d.rows.map((r) => ({ name: r.name.trim(), tags: split(r.tags) })),
  };
}

export function TaskNumberingCard({ nestId, canManage }: { nestId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const q = useQuery(reads.settings(nestId));
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (q.data && !dirty) setDraft(draftFromRules(q.data.task_rules));
  }, [q.data, dirty]);

  const edit = (next: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...next }));
    setDirty(true);
    setError(null);
  };
  const setRow = (i: number, patch: Partial<Row>) =>
    edit({ rows: draft.rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const moveRow = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= draft.rows.length) return;
    const rows = [...draft.rows];
    [rows[i], rows[j]] = [rows[j]!, rows[i]!];
    edit({ rows });
  };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.updateNestSettings(nestId, { task_rules: rulesFromDraft(draft) });
      await qc.invalidateQueries({ queryKey: reads.settings(nestId).queryKey });
      setDirty(false);
      toast.success("Task numbering saved");
    } catch (e: any) {
      setError(e?.message || "Couldn't save");
    } finally {
      setBusy(false);
    }
  }

  async function backfill() {
    try {
      const dry = await api.backfillTickets(nestId, { dry_run: true });
      const pending = dry.results.length;
      if (!window.confirm(`Number up to ${Math.min(pending, 100)} existing tasks now, oldest first? Each gets its own version.`)) return;
      const r = await api.backfillTickets(nestId, {});
      toast.success(
        `${r.numbered} numbered${r.remaining ? ` — ${r.remaining} left, run it again` : ""}${r.failed ? ` (${r.failed} failed)` : ""}`,
      );
    } catch (e: any) {
      toast.error(e?.message || "Couldn't number existing tasks");
    }
  }

  const setPrio = (i: number, label: string) =>
    edit({ priorities: draft.priorities.map((p, j) => (j === i ? { ...p, label } : p)) });
  const movePrio = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= draft.priorities.length) return;
    const rows = [...draft.priorities];
    [rows[i], rows[j]] = [rows[j]!, rows[i]!];
    edit({ priorities: rows });
  };
  const usingDefaults = draft.priorities.length === 0;
  const names = draft.rows.map((r) => r.name.trim()).filter(Boolean);

  return (
    <Card data-testid="task-numbering">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Task numbering</CardTitle>
        <CardDescription>
          Give every task a permanent number like <code>{draft.prefix.trim().toUpperCase() || "ABC"}-12</code>.
          One prefix, one sequence for the whole nest. Numbers are handed out by the server, so two
          people filing at once never get the same one, and a number never changes, even when a task
          moves to another surface.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {canManage && (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Start from</span>
            {TASK_PRESETS.map((p) => (
              <Button key={p.label} size="sm" variant="outline" title={p.hint} onClick={() => edit({ ...p.draft, prefix: draft.prefix, startAt: draft.startAt, rows: draft.rows.length ? draft.rows : p.draft.rows })}>
                {p.label}
              </Button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-4 text-sm">
          <label className="flex items-center gap-3 pb-2">
            <Switch checked={draft.numbering} disabled={!canManage} onCheckedChange={(v) => edit({ numbering: v })} aria-label="Number tasks" />
            Number new tasks
          </label>
          <label className="space-y-1">
            <span className="block font-medium">Ticket prefix</span>
            <Input aria-label="Ticket prefix" className="w-28" placeholder="ABC" value={draft.prefix} disabled={!canManage} maxLength={6} onChange={(e) => edit({ prefix: e.target.value.toUpperCase() })} />
          </label>
          <label className="space-y-1">
            <span className="block font-medium">Start at</span>
            <Input aria-label="Start at" className="w-28" placeholder="1" inputMode="numeric" value={draft.startAt} disabled={!canManage} onChange={(e) => edit({ startAt: e.target.value.replace(/\D/g, "") })} />
          </label>
        </div>
        {draft.numbering && !draft.prefix.trim() && (
          <p className="text-xs text-destructive">Pick a prefix (2–6 letters or digits) before saving with numbering on.</p>
        )}

        <div className="space-y-2">
          <div className="text-sm font-medium">Surfaces</div>
          <p className="text-xs text-muted-foreground">
            Product areas for sorting and filtering. A task is in the first surface that has one of its tags. They never change a ticket number.
          </p>
          {draft.rows.length === 0 && (
            <p className="text-sm text-muted-foreground">No surfaces yet. Add one for each product area you track.</p>
          )}
          {draft.rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_1.6fr_auto] items-center gap-2">
              <Input aria-label="Surface name" placeholder="Name" value={r.name} disabled={!canManage} onChange={(e) => setRow(i, { name: e.target.value })} />
              <Input aria-label="Tags" placeholder="tags, comma separated" value={r.tags} disabled={!canManage} onChange={(e) => setRow(i, { tags: e.target.value })} />
              {canManage && (
                <div className="flex">
                  <Button size="icon" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => moveRow(i, -1)}><ArrowUp className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" aria-label="Move down" disabled={i === draft.rows.length - 1} onClick={() => moveRow(i, 1)}><ArrowDown className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" aria-label="Remove surface" onClick={() => edit({ rows: draft.rows.filter((_, j) => j !== i), defaultSurface: draft.defaultSurface === r.name ? "" : draft.defaultSurface })}><Trash2 className="h-4 w-4" /></Button>
                </div>
              )}
            </div>
          ))}
          {canManage && (
            <Button size="sm" variant="outline" onClick={() => edit({ rows: [...draft.rows, { name: "", tags: "" }] })}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />Add surface
            </Button>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-3 text-sm">
          <label className="space-y-1">
            <span className="font-medium">New-task dialog preselects</span>
            <select
              className="h-9 w-full rounded-md border bg-background px-2"
              value={draft.defaultSurface}
              disabled={!canManage}
              onChange={(e) => edit({ defaultSurface: e.target.value })}
            >
              <option value="">No surface</option>
              {names.map((n) => (<option key={n} value={n}>{n}</option>))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="font-medium">One-per-task tag groups</span>
            <Input placeholder="stage" value={draft.stageNamespaces} disabled={!canManage} onChange={(e) => edit({ stageNamespaces: e.target.value })} />
          </label>
          <label className="space-y-1">
            <span className="font-medium">New tasks start in</span>
            <Input placeholder="stage:backlog" value={draft.defaultStage} disabled={!canManage} onChange={(e) => edit({ defaultStage: e.target.value })} />
          </label>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Stage columns, in order</span>
          <Input placeholder="backlog, in-progress, in-review, done" value={draft.stageOrder} disabled={!canManage} onChange={(e) => edit({ stageOrder: e.target.value })} />
          <span className="block text-xs text-muted-foreground">Boards grouped by the stage group open in this order, left to right.</span>
        </label>

        <div className="space-y-2">
          <div className="text-sm font-medium">Priority levels</div>
          <p className="text-xs text-muted-foreground">
            Most urgent first. {usingDefaults ? "Using the defaults: Urgent, High, Medium, Low." : "Tasks keep their level if you rename it, and removing one never changes a task."}
          </p>
          {draft.priorities.map((p, i) => (
            <div key={p.key ?? `new-${i}`} className="flex items-center gap-2">
              <span className="w-5 text-right text-xs text-muted-foreground tabular-nums">{i + 1}</span>
              <Input aria-label={`Priority ${i + 1}`} className="max-w-xs" placeholder="Label" value={p.label} maxLength={24} disabled={!canManage} onChange={(e) => setPrio(i, e.target.value)} />
              {canManage && (
                <div className="flex">
                  <Button size="icon" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => movePrio(i, -1)}><ArrowUp className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" aria-label="Move down" disabled={i === draft.priorities.length - 1} onClick={() => movePrio(i, 1)}><ArrowDown className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" aria-label="Remove level" onClick={() => edit({ priorities: draft.priorities.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
                </div>
              )}
            </div>
          ))}
          {canManage && (
            <div className="flex flex-wrap gap-2">
              {usingDefaults ? (
                <Button size="sm" variant="outline" onClick={() => edit({ priorities: [{ key: "urgent", label: "Urgent" }, { key: "high", label: "High" }, { key: "medium", label: "Medium" }, { key: "low", label: "Low" }] })}>
                  Customize levels
                </Button>
              ) : (
                <>
                  <Button size="sm" variant="outline" disabled={draft.priorities.length >= 8} onClick={() => edit({ priorities: [...draft.priorities, { label: "" }] })}>
                    <Plus className="mr-1.5 h-3.5 w-3.5" />Add level
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => edit({ priorities: [] })}>Back to defaults</Button>
                </>
              )}
            </div>
          )}
        </div>

        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}

        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void save()} disabled={busy || !dirty}>{busy ? "Saving…" : "Save"}</Button>
            <Button variant="outline" onClick={() => void backfill()} disabled={dirty || !draft.numbering || !draft.prefix.trim()}>
              Number existing tasks
            </Button>
            {dirty && <span className="text-xs text-muted-foreground">Save before numbering existing tasks.</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
