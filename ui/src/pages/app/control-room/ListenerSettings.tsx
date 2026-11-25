/** Control room → Agents → Update: a Slack listener's own settings. Blank = the default. */
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { listSurfacesBindings, updateSurfacesListener, type SurfacesBinding, type SurfacesJudgeTuning } from "../../../lib/api";

export const FIELDS = [
  { key: "name", label: "Name", hint: "Blank: the channel's name, nest agent and its id", min: 0, max: 0 },
  { key: "avatar", label: "Picture", hint: "An emoji or up to 4 letters", min: 0, max: 0 },
  { key: "model", label: "Model", hint: "Blank: the server's judge model", min: 0, max: 0 },
  { key: "max_output_tokens", label: "Max output tokens", hint: "500 to 8000. Blank: 1500. Reasoning models need more", min: 500, max: 8000 },
  { key: "temperature", label: "Temperature", hint: "0 to 1. Blank: 0. Dropped when the model refuses it", min: 0, max: 1 },
  { key: "timeout_seconds", label: "Time limit (seconds)", hint: "60 to 300. Blank: 120", min: 60, max: 300 },
  { key: "max_turns", label: "Steps per run", hint: "2 to 8. Blank: 4", min: 2, max: 8 },
  { key: "max_items", label: "Suggestions per run", hint: "1 to 3. Blank: 3", min: 1, max: 3 },
] as const;
type Form = Record<(typeof FIELDS)[number]["key"], string> & { folders: string[] | null };
const TEXT = new Set<string>(["name", "avatar", "model"]);

/** The typed form as settings, or the first problem in words. */
export function tuningFromForm(f: Form): { tuning: SurfacesJudgeTuning } | { problem: string } {
  const text = (v: string) => v.trim() || null;
  const out: SurfacesJudgeTuning = { name: text(f.name), avatar: text(f.avatar), model: text(f.model), folders: f.folders, max_turns: null, max_items: null, max_output_tokens: null, temperature: null, timeout_seconds: null };
  if (f.folders && !f.folders.length) return { problem: "Choose at least one folder." };
  for (const d of FIELDS) {
    if (d.key === "name" || d.key === "avatar" || d.key === "model" || !f[d.key].trim()) continue;
    const n = Number(f[d.key]);
    if (!Number.isFinite(n) || n < d.min || n > d.max || (d.key !== "temperature" && !Number.isInteger(n))) return { problem: `${d.label} must be from ${d.min} to ${d.max}.` };
    out[d.key] = n;
  }
  return { tuning: out };
}

const formOf = (j?: SurfacesJudgeTuning): Form => ({
  name: j?.name ?? "",
  avatar: j?.avatar ?? "",
  folders: j?.folders ?? null,
  max_turns: j?.max_turns?.toString() ?? "",
  max_items: j?.max_items?.toString() ?? "",
  model: j?.model ?? "",
  max_output_tokens: j?.max_output_tokens?.toString() ?? "",
  temperature: j?.temperature?.toString() ?? "",
  timeout_seconds: j?.timeout_seconds?.toString() ?? "",
});
const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function ListenerSettings({ nodeId, nestId }: { nodeId: string; nestId: string | null }) {
  const [binding, setBinding] = useState<SurfacesBinding | null>(null);
  const [form, setForm] = useState<Form>(formOf());
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const b = (await listSurfacesBindings()).find((x) => x.listener_agent_node_id === nodeId && (!nestId || x.nest_id === nestId) && x.status !== "removed");
      if (!b) throw new Error("This listener's channel is no longer connected.");
      setForm(formOf(b.judge));
      setBinding(b);
    } catch (e) {
      toast.error(errText(e, "Couldn't load the settings."));
    } finally {
      setBusy(false);
    }
  };
  const all = binding?.listener_folders ?? [];
  // Every folder ticked is the default, so a folder the starter adds later is included.
  const toggle = (folder: string, on: boolean) =>
    setForm((v) => {
      const next = all.filter((x) => (x === folder ? on : (v.folders ?? all).includes(x)));
      return { ...v, folders: next.length === all.length ? null : next };
    });
  const parsed = tuningFromForm(form);
  const save = async () => {
    if (!binding || "problem" in parsed) return;
    setBusy(true);
    try {
      await updateSurfacesListener(binding.id, parsed.tuning);
      toast.success("Saved. It applies from the next conversation.");
      setBinding(null);
    } catch (e) {
      toast.error(errText(e, "Couldn't save the settings."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="outline" size="sm" className="mt-1.5" onClick={open} disabled={busy} data-testid="cr-listener-update">
        Update
      </Button>
      <Dialog open={!!binding} onOpenChange={(o) => !o && !busy && setBinding(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Update listener{binding?.conversation_name ? ` in #${binding.conversation_name}` : ""}</DialogTitle>
            <DialogDescription>Leave a field blank for the default. Saving applies from the next conversation. Higher limits cost more and take longer.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {FIELDS.map((f) => (
              <div key={f.key} className="space-y-1">
                <Label htmlFor={`listener-${f.key}`}>{f.label}</Label>
                <Input
                  id={`listener-${f.key}`}
                  value={form[f.key]}
                  inputMode={TEXT.has(f.key) ? "text" : "decimal"}
                  disabled={busy}
                  onChange={(e) => setForm((v) => ({ ...v, [f.key]: e.target.value }))}
                />
                <p className="text-sm text-muted-foreground">{f.hint}</p>
              </div>
            ))}
            {all.length > 0 && (
              <fieldset className="space-y-1.5">
                <legend className="text-sm font-medium">Folders it may read and suggest into</legend>
                {all.map((x) => (
                  <label key={x} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={(form.folders ?? all).includes(x)} disabled={busy} onCheckedChange={(c) => toggle(x, c === true)} />
                    {x === "/" ? "Top level of the nest" : x}
                  </label>
                ))}
              </fieldset>
            )}
            {"problem" in parsed && (
              <p className="text-sm text-destructive" role="alert">
                {parsed.problem}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBinding(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy || "problem" in parsed} data-testid="cr-listener-save">
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
