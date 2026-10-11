/**
 * The nest's templates: the body new files start from, and the headings a
 * file must keep. Whether a required section is a heading in the body is the
 * server's warning to give, not this form's.
 */
import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { StructureRules } from "../../lib/api";
import { folderPatterns, removeTemplate, renameTemplate, setTemplate } from "../../lib/structure-draft";
import { toast } from "sonner";

interface Props {
  draft: StructureRules;
  setDraft: (next: StructureRules) => void;
  selected: string | null;
  setSelected: (name: string | null) => void;
  fieldErrors: Record<string, string>;
  canManage: boolean;
}

export function TemplatesTab({ draft, setDraft, selected, setSelected, fieldErrors, canManage }: Props) {
  const names = Object.keys(draft.templates ?? {}).sort();
  const [adding, setAdding] = useState("");
  const current = selected && draft.templates?.[selected] !== undefined ? selected : names[0] ?? null;

  const add = () => {
    const name = adding.trim();
    if (!name) return;
    if (draft.templates?.[name] !== undefined) {
      toast.error(`There is already a template called ${name}.`);
      return;
    }
    setDraft(setTemplate(draft, name, { body: "", required_sections: [] }));
    setSelected(name);
    setAdding("");
  };

  return (
    <div className="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
      <div className="space-y-2 rounded-lg border p-3">
        <p className="px-1 text-sm font-semibold">Templates</p>
        {names.length === 0 && <p className="px-1 text-sm text-muted-foreground">No templates yet.</p>}
        {names.map((n) => {
          const uses = folderPatterns(draft).filter((p) => draft.folders?.[p]?.template === n).length;
          return (
            <button
              key={n}
              type="button"
              onClick={() => setSelected(n)}
              aria-pressed={n === current}
              className={`w-full rounded-md border px-2.5 py-2 text-left text-sm ${
                n === current ? "border-primary/30 bg-primary/5" : "border-transparent hover:bg-muted"
              }`}
            >
              <span className="block font-medium">{n}</span>
              <span className="block text-xs text-muted-foreground">
                {uses ? `Used by ${uses} folder rule${uses === 1 ? "" : "s"}` : "Not used by a folder rule"}
              </span>
            </button>
          );
        })}
        {canManage && (
          <form
            className="flex gap-2 pt-1"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="meeting-note" className="h-8" aria-label="New template name" />
            <Button type="submit" size="sm" variant="outline" disabled={!adding.trim()}>
              Add
            </Button>
          </form>
        )}
      </div>
      {current ? (
        <TemplateEditor
          key={current}
          name={current}
          draft={draft}
          setDraft={setDraft}
          onRenamed={setSelected}
          fieldErrors={fieldErrors}
        />
      ) : (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          A template is the body new files in a folder start from, plus the headings they must keep.
        </div>
      )}
    </div>
  );
}

function TemplateEditor({
  name,
  draft,
  setDraft,
  onRenamed,
  fieldErrors,
}: {
  name: string;
  draft: StructureRules;
  setDraft: (next: StructureRules) => void;
  onRenamed: (name: string | null) => void;
  fieldErrors: Record<string, string>;
}) {
  const t = draft.templates?.[name] ?? {};
  const [label, setLabel] = useState(name);
  const [section, setSection] = useState("");
  useEffect(() => setLabel(name), [name]);
  const sections = t.required_sections ?? [];
  const errs = Object.entries(fieldErrors).filter(([k]) => k.startsWith(`templates.${name}`));
  const usedBy = folderPatterns(draft).filter((p) => draft.folders?.[p]?.template === name);

  const commitName = () => {
    const to = label.trim();
    if (to === name) return;
    const next = renameTemplate(draft, name, to);
    if (!next) {
      setLabel(name);
      toast.error(to ? `There is already a template called ${to}.` : "A template needs a name.");
      return;
    }
    setDraft(next);
    onRenamed(to);
  };

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor="template-name">Name</Label>
          <Input
            id="template-name"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => e.key === "Enter" && commitName()}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          onClick={() => {
            setDraft(removeTemplate(draft, name));
            onRenamed(null);
          }}
        >
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Remove template
        </Button>
      </div>
      <div className="space-y-1">
        <Label htmlFor="template-body">Body</Label>
        <Textarea
          id="template-body"
          rows={8}
          className="font-mono text-sm"
          value={t.body ?? ""}
          onChange={(e) => setDraft(setTemplate(draft, name, { body: e.target.value }))}
          placeholder={"## Attendees\n\n## Decisions\n\n## Action items\n"}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="template-section">Required sections</Label>
        <div className="flex flex-wrap items-center gap-1.5">
          {sections.map((s) => (
            <span key={s} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-sm text-primary">
              {s}
              <button
                type="button"
                aria-label={`Remove required section ${s}`}
                className="rounded-full hover:bg-primary/20"
                onClick={() => setDraft(setTemplate(draft, name, { required_sections: sections.filter((x) => x !== s) }))}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
          <Input
            id="template-section"
            value={section}
            onChange={(e) => setSection(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              const s = section.trim();
              if (s && !sections.includes(s)) setDraft(setTemplate(draft, name, { required_sections: [...sections, s] }));
              setSection("");
            }}
            placeholder="Type a heading, then Enter"
            className="h-8 w-56"
          />
        </div>
        <p className="text-xs text-muted-foreground">Files started from this template must keep these headings.</p>
      </div>
      {errs.map(([k, m]) => (
        <p key={k} className="text-xs text-destructive">{m}</p>
      ))}
      <p className="text-xs text-muted-foreground">
        {usedBy.length ? <>Used by {usedBy.map((p) => <code key={p} className="mr-1">{p}</code>)}</> : "No folder rule uses it yet."}
      </p>
    </div>
  );
}
