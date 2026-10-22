/**
 * Setting up a metacognition agent, in plain questions (CU-wdqcq05rkp):
 * what should it look at, what may it change, how much can it do each run.
 *
 * A new setup is prefilled from the agent document (GET …/suggest), with a
 * "from the agent document" hint and its reason next to each field it
 * filled; editing an existing agent shows its saved config, and "Re-suggest
 * from document" fills it again on request. The raw numbers, model, feeds
 * and MCP servers sit under Advanced. All mapping to and from the stored
 * config lives in lib/metacognition-form.ts.
 *
 * Each question is its own small section component taking SectionProps, so a
 * new one (e.g. who it may notify) drops into the list in MetacognitionForm.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Plus, Sparkles, Trash2, Wand2 } from "lucide-react";
import {
  listNestFolderPaths,
  saveMetacognitionAgent,
  suggestMetacognitionConfig,
} from "../lib/api";
import {
  EFFORT_LABEL,
  PRESETS,
  applySuggestion,
  configFromForm,
  effortText,
  formProblems,
  presetOf,
  summarize,
  toggleReadFolder,
  type Caps,
  type Effort,
  type FormState,
} from "../lib/metacognition-form";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";

export interface SectionProps {
  form: FormState;
  /** Update the form; `field` (a config path like "scope.read") drops that
   *  field's "from the agent document" hint, since the owner changed it. */
  update: (fn: (f: FormState) => FormState, field?: string) => void;
  /** Why each prefilled field was filled the way it was. */
  prefilled: Record<string, string>;
  /** Every folder in the nest. */
  folders: string[];
}

/** The subtle "filled in from the agent document" note, with its reason. */
function FromDoc({ why }: { why?: string }) {
  if (!why) return null;
  return (
    <p className="text-[11px] text-violet-700/80 dark:text-violet-300/80 flex gap-1 items-start" data-testid="metacognition-prefill-hint">
      <Sparkles className="h-3 w-3 mt-0.5 shrink-0" />
      <span>
        From the agent document: <span className="text-muted-foreground">{why}</span>
      </span>
    </p>
  );
}

function Question({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">{title}</legend>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </fieldset>
  );
}

function Choice({
  name,
  checked,
  onChange,
  testId,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-2 text-sm cursor-pointer">
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-1 accent-primary" data-testid={testId} />
      <span>{children}</span>
    </label>
  );
}

const depth = (p: string) => p.split("/").length - 1;
const within = (folder: string, list: string[]) => list.some((r) => folder === r || folder.startsWith(`${r}/`));

/** Checkboxes for folders, indented by depth. A ticked folder includes its
 *  subfolders, so those show ticked and can't be unticked on their own. */
function FolderChecks({
  options,
  selected,
  onToggle,
  testPrefix,
  missingNote,
}: {
  options: string[];
  selected: string[];
  onToggle: (folder: string, on: boolean) => void;
  testPrefix: string;
  missingNote?: (folder: string) => string | null;
}) {
  if (!options.length) return <p className="text-xs text-muted-foreground pl-6">This nest has no folders yet.</p>;
  return (
    <div className="max-h-48 overflow-y-auto rounded-md border px-2 py-1.5 ml-6 space-y-0.5">
      {options.map((f) => {
        const inherited = !selected.includes(f) && within(f, selected);
        return (
          <label
            key={f}
            className="flex items-center gap-2 text-sm cursor-pointer"
            style={{ paddingLeft: `${depth(f) * 1}rem` }}
          >
            <input
              type="checkbox"
              className="accent-primary"
              checked={selected.includes(f) || inherited}
              disabled={inherited}
              onChange={(e) => onToggle(f, e.target.checked)}
              data-testid={`${testPrefix}-${f}`}
            />
            <span className={inherited ? "text-muted-foreground" : ""}>{f.split("/").pop()}</span>
            {missingNote?.(f) && <span className="text-[11px] text-amber-600">{missingNote(f)}</span>}
          </label>
        );
      })}
    </div>
  );
}

export function LookSection({ form, update, prefilled, folders }: SectionProps) {
  // Folders saved earlier that the nest no longer has still show, so the
  // owner can see (and untick) them.
  const options = useMemo(() => [...new Set([...folders, ...form.read])].sort(), [folders, form.read]);
  return (
    <Question title="What should it look at?" hint="It can only read documents inside what you pick here.">
      <Choice
        name="read"
        checked={form.readAll}
        onChange={() => update((f) => ({ ...f, readAll: true }), "scope.read")}
        testId="metacognition-read-all"
      >
        The whole nest
      </Choice>
      <Choice
        name="read"
        checked={!form.readAll}
        onChange={() => update((f) => ({ ...f, readAll: false }), "scope.read")}
        testId="metacognition-read-some"
      >
        Only these folders
      </Choice>
      {!form.readAll && (
        <FolderChecks
          options={options}
          selected={form.read}
          onToggle={(folder, on) => update((f) => toggleReadFolder(f, folder, on), "scope.read")}
          testPrefix="metacognition-read-folder"
          missingNote={(f) => (folders.includes(f) ? null : "not in this nest any more")}
        />
      )}
      <FromDoc why={prefilled["scope.read"]} />
    </Question>
  );
}

export function ChangeSection({ form, update, prefilled, folders }: SectionProps) {
  const options = useMemo(() => {
    const all = [...new Set([...folders, ...form.read, ...form.propose])].sort();
    return form.readAll ? all : all.filter((f) => within(f, form.read));
  }, [folders, form.read, form.propose, form.readAll]);
  const setMode = (proposeMode: FormState["proposeMode"]) => update((f) => ({ ...f, proposeMode }), "scope.propose");
  return (
    <Question
      title="What may it change?"
      hint="Every change is a suggestion that waits for a reviewer. It never publishes anything itself."
    >
      <Choice name="propose" checked={form.proposeMode === "none"} onChange={() => setMode("none")} testId="metacognition-propose-none">
        Nothing — it only leaves comments
      </Choice>
      <Choice name="propose" checked={form.proposeMode === "reads"} onChange={() => setMode("reads")} testId="metacognition-propose-reads">
        It may suggest edits to anything it looks at
      </Choice>
      <Choice
        name="propose"
        checked={form.proposeMode === "folders"}
        onChange={() => setMode("folders")}
        testId="metacognition-propose-folders"
      >
        It may suggest edits only in these folders
      </Choice>
      {form.proposeMode === "folders" && (
        <FolderChecks
          options={options}
          selected={form.propose}
          onToggle={(folder, on) =>
            update(
              (f) => ({ ...f, propose: on ? [...new Set([...f.propose, folder])] : f.propose.filter((p) => p !== folder) }),
              "scope.propose",
            )
          }
          testPrefix="metacognition-propose-folder"
        />
      )}
      <FromDoc why={prefilled["scope.propose"]} />
    </Question>
  );
}

export function EffortSection({ form, update }: SectionProps) {
  const current = presetOf(form.caps);
  return (
    <Question title="How much can it do each run?">
      <div className="flex flex-wrap gap-1.5" role="radiogroup">
        {(Object.keys(PRESETS) as Effort[]).map((e) => (
          <Button
            key={e}
            type="button"
            size="sm"
            variant={current === e ? "default" : "outline"}
            role="radio"
            aria-checked={current === e}
            className="h-7 text-xs"
            onClick={() => update((f) => ({ ...f, caps: { ...PRESETS[e] } }))}
            data-testid={`metacognition-effort-${e}`}
          >
            {EFFORT_LABEL[e]}
          </Button>
        ))}
        {current === "custom" && (
          <span className="h-7 px-2.5 inline-flex items-center rounded-md border border-dashed text-xs" title="Set under Advanced">
            Custom
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground" data-testid="metacognition-effort-label">
        {EFFORT_LABEL[current]}: {effortText(form.caps)}.
      </p>
    </Question>
  );
}

const CAP_FIELDS: Array<{ key: keyof Caps; label: string; min: number; max: number; step?: number }> = [
  { key: "max_steps", label: "Turns per run", min: 1, max: 50 },
  { key: "max_proposals", label: "Suggestions per run", min: 0, max: 20 },
  { key: "max_comments", label: "Comments per run", min: 0, max: 20 },
  { key: "max_seconds", label: "Seconds per run", min: 10, max: 1800 },
  { key: "max_tokens", label: "Tokens per run", min: 10000, max: 2000000, step: 10000 },
];

export function AdvancedSection({ form, update, prefilled }: SectionProps) {
  // Open from the start when the document suggested a feed or MCP server, so
  // the owner sees what was filled in.
  const [open, setOpen] = useState(Boolean(prefilled.feeds || prefilled.mcp_servers));
  const setCap = (key: keyof Caps) => (e: React.ChangeEvent<HTMLInputElement>) =>
    update((f) => ({ ...f, caps: { ...f.caps, [key]: Number(e.target.value) || 0 } }));
  const row = <K extends "feeds" | "mcp">(k: K, i: number, patch: Partial<FormState[K][number]>) =>
    update((f) => ({ ...f, [k]: f[k].map((r, j) => (j === i ? { ...r, ...patch } : r)) }), k === "feeds" ? "feeds" : "mcp_servers");
  const remove = (k: "feeds" | "mcp", i: number) =>
    update((f) => ({ ...f, [k]: f[k].filter((_, j) => j !== i) }), k === "feeds" ? "feeds" : "mcp_servers");
  return (
    <div className="space-y-3">
      <button
        type="button"
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="metacognition-advanced-toggle"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Advanced: exact limits, model, feeds and MCP servers
      </button>
      {open && (
        <div className="space-y-4 pl-4 border-l">
          <div className="grid gap-3 grid-cols-2 sm:grid-cols-5">
            {CAP_FIELDS.map((c) => (
              <div key={c.key} className="space-y-1">
                <Label className="text-xs">{c.label}</Label>
                <Input
                  type="number"
                  min={c.min}
                  max={c.max}
                  step={c.step}
                  value={form.caps[c.key]}
                  onChange={setCap(c.key)}
                  data-testid={`metacognition-cap-${c.key}`}
                />
              </div>
            ))}
          </div>
          <div className="space-y-1 sm:w-1/2">
            <Label className="text-xs">Model (leave empty for the nest's Hootie model)</Label>
            <Input value={form.model} onChange={(e) => update((f) => ({ ...f, model: e.target.value }))} placeholder="claude-sonnet-5" />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Feeds it checks each run</Label>
            {form.feeds.map((r, i) => (
              <div key={i} className="flex gap-2">
                <Input className="w-32" value={r.name} placeholder="news" onChange={(e) => row("feeds", i, { name: e.target.value })} />
                <Input value={r.url} placeholder="https://example.com/feed.xml" onChange={(e) => row("feeds", i, { url: e.target.value })} />
                <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0" title="Remove" onClick={() => remove("feeds", i)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => update((f) => ({ ...f, feeds: [...f.feeds, { name: "", url: "" }] }))}
            >
              <Plus className="h-3.5 w-3.5 mr-1" /> Add a feed
            </Button>
            <FromDoc why={prefilled.feeds} />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">MCP servers it may use</Label>
            {form.mcp.map((r, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[8rem_1fr_1fr_10rem_auto]">
                <Input value={r.name} placeholder="desk" onChange={(e) => row("mcp", i, { name: e.target.value })} />
                <Input value={r.url} placeholder="https://mcp.example.com/mcp" onChange={(e) => row("mcp", i, { url: e.target.value })} />
                <Input
                  value={r.tools}
                  placeholder="Tools it may call: search, get_ticket"
                  onChange={(e) => row("mcp", i, { tools: e.target.value })}
                  data-testid="metacognition-mcp-tools"
                />
                <Input value={r.auth_env} placeholder="MCP_DESK_TOKEN" title="Name of a nest env value holding a bearer token (starts MCP_)" onChange={(e) => row("mcp", i, { auth_env: e.target.value })} />
                <Button type="button" variant="ghost" size="icon" className="h-9 w-9" title="Remove" onClick={() => remove("mcp", i)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => update((f) => ({ ...f, mcp: [...f.mcp, { name: "", url: "", tools: "", auth_env: "" }] }))}
            >
              <Plus className="h-3.5 w-3.5 mr-1" /> Add an MCP server
            </Button>
            <FromDoc why={prefilled.mcp_servers} />
            <p className="text-[11px] text-muted-foreground">
              Only the tools you list can be called. What feeds and MCP tools return is treated as untrusted data, and
              the agent can only act on it by suggesting a change.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** The questions, in order. A new section (e.g. who it may notify) goes here. */
const SECTIONS: Array<React.FC<SectionProps>> = [LookSection, ChangeSection, EffortSection, AdvancedSection];

export function MetacognitionForm({
  nestId,
  initial,
  isNew,
  agentDocs,
  onSaved,
  onCancel,
}: {
  nestId: string;
  initial: FormState;
  /** A new setup: prefill from the document, and let the owner pick it. */
  isNew: boolean;
  /** For a new setup: the agent documents not yet set up. */
  agentDocs: Array<{ id: string; title: string }>;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [prefilled, setPrefilled] = useState<Record<string, string>>({});
  const [folders, setFolders] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [noInstructions, setNoInstructions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumps the Advanced section's key so it re-reads "open when prefilled".
  const [fillKey, setFillKey] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    listNestFolderPaths(nestId).then(setFolders, () => setFolders([]));
  }, [nestId]);

  const suggest = async (nodeId: string) => {
    const ticket = ++latest.current;
    setSuggesting(true);
    setError(null);
    try {
      const s = await suggestMetacognitionConfig(nestId, nodeId);
      // A slower answer for a document the owner already switched away from.
      if (ticket !== latest.current) return;
      setForm((f) => applySuggestion({ ...f, node_id: nodeId }, s).form);
      // The hints depend on the suggestion alone, not on the form.
      setPrefilled(applySuggestion(initial, s).prefilled);
      setNoInstructions(s.instructions === "none");
      setFillKey((k) => k + 1);
    } catch (err) {
      if (ticket === latest.current) setError(err instanceof Error ? err.message : "Could not read the agent document");
    } finally {
      if (ticket === latest.current) setSuggesting(false);
    }
  };

  // A new setup starts from the document's own instructions.
  useEffect(() => {
    if (isNew && initial.node_id) void suggest(initial.node_id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update: SectionProps["update"] = (fn, field) => {
    setForm(fn);
    if (field) {
      setPrefilled((p) => {
        if (!(field in p)) return p;
        const { [field]: _gone, ...rest } = p;
        return rest;
      });
    }
  };

  const problems = formProblems(form);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveMetacognitionAgent(nestId, form.node_id, configFromForm(form));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  const props: SectionProps = { form, update, prefilled, folders };
  return (
    <div className="rounded-lg border p-4 space-y-4" data-testid="metacognition-form">
      <div
        className="rounded-md bg-violet-50 dark:bg-violet-950/40 px-3 py-2 text-sm text-violet-900 dark:text-violet-100"
        data-testid="metacognition-summary"
      >
        {summarize(configFromForm(form))}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>Agent document</Label>
          {isNew ? (
            <select
              value={form.node_id}
              onChange={(e) => {
                const id = e.target.value;
                setForm((f) => ({ ...f, node_id: id }));
                void suggest(id);
              }}
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              data-testid="metacognition-doc"
            >
              {agentDocs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          ) : (
            <div className="text-sm">{agentDocs.find((d) => d.id === form.node_id)?.title ?? form.node_id.replace(/^nodes\//, "")}</div>
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-1.5 text-xs"
              disabled={suggesting || !form.node_id}
              onClick={() => void suggest(form.node_id)}
              title="Fill the form in again from what the agent document's approved instructions say"
              data-testid="metacognition-resuggest"
            >
              {suggesting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Wand2 className="h-3.5 w-3.5 mr-1" />}
              Re-suggest from document
            </Button>
          </div>
          {noInstructions && (
            <p className="text-[11px] text-amber-600">
              This document has no approved instructions yet, so there was little to go on. Approve it to get a better
              suggestion.
            </p>
          )}
        </div>
        <div className="flex items-end gap-2">
          <Switch checked={form.enabled} onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))} />
          <span className="text-sm">{form.enabled ? "On" : "Off"}</span>
        </div>
        <div className="space-y-1">
          <Label>What should it be called?</Label>
          <Input
            value={form.name}
            onChange={(e) => update((f) => ({ ...f, name: e.target.value }), "persona.name")}
            placeholder="Archivist"
            data-testid="metacognition-name"
          />
          <FromDoc why={prefilled["persona.name"]} />
        </div>
        <div className="space-y-1">
          <Label>Its picture (an emoji or up to 4 letters)</Label>
          <Input
            value={form.avatar}
            onChange={(e) => update((f) => ({ ...f, avatar: e.target.value }), "persona.avatar")}
            placeholder="e.g. 🦉 (optional)"
          />
          <FromDoc why={prefilled["persona.avatar"]} />
        </div>
      </div>

      {SECTIONS.map((Section, i) => (
        <Section key={Section === AdvancedSection ? `adv-${fillKey}` : i} {...props} />
      ))}

      {problems.length > 0 && (
        <ul className="text-xs text-amber-700 dark:text-amber-400 list-disc pl-5" data-testid="metacognition-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={saving || problems.length > 0 || !form.node_id} data-testid="metacognition-save">
          {saving && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
