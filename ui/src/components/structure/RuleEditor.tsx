/**
 * One folder rule of a nest. Owners and admins edit it; everyone else reads
 * it in plain words and can still try a title or folder name against it.
 * Every verdict comes from the server's check API; this form only shapes the
 * draft.
 */
import { useEffect, useId, useState } from "react";
import { Trash2, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import * as api from "../../lib/api";
import type { StructureFolderConfig } from "../../lib/api";
import { FILE_NAME_PRESETS, FOLDER_NAME_PRESETS } from "../../lib/structure-draft";

const NONE = "__none__";
/** Error and verdict text: AA contrast at small sizes, light and dark. */
const BAD = "text-red-700 dark:text-red-400";
const GOOD = "text-green-700 dark:text-green-400";

interface Props {
  nestId: string;
  pattern: string;
  rule: StructureFolderConfig;
  templates: string[];
  /** Required sections per template, for the plain-words summary. */
  templateSections: Record<string, string[]>;
  types: string[];
  /** Read-only: the rule is shown in words; the Try boxes still work. */
  readOnly: boolean;
  /** Server field errors, keyed like `folders.<pattern>.file_name`. */
  fieldErrors: Record<string, string>;
  onChange: (patch: Partial<StructureFolderConfig>) => void;
  /** False when another rule already has that path. */
  onRename: (to: string) => boolean;
  onRemove: () => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

function FieldError({ id, message }: { id?: string; message?: string }) {
  return message ? (
    <p id={id} className={`text-xs ${BAD}`}>
      {message}
    </p>
  ) : null;
}

/** Debounced server check of one name against one format. */
function useCheck(
  nestId: string,
  body: Parameters<typeof api.checkStructure>[1] | null,
): api.StructureCheckResult | null {
  const [result, setResult] = useState<api.StructureCheckResult | null>(null);
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!body) {
      setResult(null);
      return;
    }
    let ignore = false;
    const t = setTimeout(() => {
      api
        .checkStructure(nestId, body)
        .then((r) => !ignore && setResult(r))
        .catch(() => !ignore && setResult(null));
    }, 300);
    return () => {
      ignore = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nestId, key]);
  return result;
}

function Verdict({ ok, text }: { ok: boolean; text: string }) {
  return (
    <p className={`flex items-start gap-1.5 text-sm ${ok ? GOOD : BAD}`}>
      {ok ? <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
      <span>{text}</span>
    </p>
  );
}

/** The rule in words, for people who read rather than edit it. */
function Summary({ pattern, rule, templateSections }: { pattern: string; rule: StructureFolderConfig; templateSections: Record<string, string[]> }) {
  const parts: string[] = [];
  parts.push(rule.types?.length ? `Takes only: ${rule.types.join(", ")}` : "Takes any type");
  if (rule.folder_name) parts.push(`folder names look like ${rule.folder_name}`);
  if (rule.file_name) parts.push(`file names look like ${rule.file_name} — the name comes from the title`);
  if (rule.template) {
    const keep = templateSections[rule.template] ?? [];
    parts.push(`new files start from ${rule.template}${keep.length ? ` and must keep ${keep.join(", ")}` : ""}`);
  }
  if (rule.required) parts.push("created with its parent folder, and kept while the parent exists");
  const files = Object.keys(rule.files ?? {});
  if (files.length) parts.push(`must contain ${files.join(", ")}`);
  return (
    <div className="rounded-md border bg-muted/30 p-3 text-sm">
      <p className="font-medium">
        In <code>{pattern}/</code>
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
        {parts.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </div>
  );
}

export function RuleEditor({
  nestId,
  pattern,
  rule,
  templates,
  templateSections,
  types,
  readOnly,
  fieldErrors,
  onChange,
  onRename,
  onRemove,
}: Props) {
  const uid = useId();
  const errId = (field: string) => `${uid}-${field}-error`;
  const err = (field: string) => fieldErrors[`folders.${pattern}.${field}`];
  const described = (field: string) => (err(field) ? { "aria-describedby": errId(field), "aria-invalid": true as const } : {});
  const [path, setPath] = useState(pattern);
  useEffect(() => setPath(pattern), [pattern]);
  const [title, setTitle] = useState("");
  const [folderName, setFolderName] = useState("");
  const [newFile, setNewFile] = useState("");
  // A folder name is tried only where the rule's path ends in a {name}.
  const namedLeaf = pattern.endsWith("}");

  // Each box tries a name against the format being edited — judged by the
  // server alone, whatever folder it ends up in.
  const titleCheck = useCheck(nestId, title.trim() ? { tests: [{ title, file_name: rule.file_name ?? "" }] } : null);
  const folderCheck = useCheck(
    nestId,
    namedLeaf && folderName.trim() ? { tests: [{ name: folderName, folder_name: rule.folder_name ?? "" }] } : null,
  );
  const titleResult = titleCheck?.results[0];
  const folderResult = folderCheck?.results[0];
  const generatedNote = " — the title has no a–z letters or digits, so the file gets a generated name";

  const others = Object.entries(fieldErrors).filter(
    ([k]) => k.startsWith(`folders.${pattern}`) && !["types", "folder_name", "file_name", "template", "files", "required"].some((f) => k === `folders.${pattern}.${f}`),
  );

  const commitPath = () => {
    const to = path.trim().replace(/^\/+|\/+$/g, "");
    if (to === pattern) return;
    if (!onRename(to)) setPath(pattern);
  };

  const files = Object.entries(rule.files ?? {});
  const setFiles = (next: Record<string, { template?: string; type?: string } | null>) => onChange({ files: next });

  const tryTitle = (
    <div className="space-y-1.5 rounded-md border bg-muted/30 p-3">
      <Label htmlFor={`${uid}-try-title`} className="text-xs">
        Try a title
      </Label>
      <Input
        id={`${uid}-try-title`}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="e.g. 2026-10-07 Kickoff with Acme"
        className="bg-background"
      />
      <div role="status" aria-live="polite">
        {titleResult &&
          (titleResult.violations.length ? (
            titleResult.violations.map((v, i) => (
              <Verdict key={i} ok={false} text={`${v.message}${titleResult.generated ? generatedNote : ""}`} />
            ))
          ) : (
            <Verdict ok text={`Saved as ${titleResult.slug}.md${titleResult.generated ? generatedNote : ""}`} />
          ))}
      </div>
      <p className="text-xs text-muted-foreground">Checked by the server, exactly as it will enforce.</p>
    </div>
  );

  const tryFolder = namedLeaf && (
    <div className="space-y-1.5 rounded-md border bg-muted/30 p-3">
      <Label htmlFor={`${uid}-try-folder`} className="text-xs">
        Try a folder name
      </Label>
      <Input
        id={`${uid}-try-folder`}
        value={folderName}
        onChange={(e) => setFolderName(e.target.value)}
        placeholder="e.g. acme-042"
        className="bg-background"
      />
      <div role="status" aria-live="polite">
        {folderResult &&
          (folderResult.violations.length ? (
            folderResult.violations.map((v, i) => <Verdict key={i} ok={false} text={v.message} />)
          ) : (
            <Verdict ok text={`${folderResult.slug}/ fits`} />
          ))}
      </div>
    </div>
  );

  if (readOnly) {
    return (
      <div className="space-y-4">
        <Summary pattern={pattern} rule={rule} templateSections={templateSections} />
        {tryFolder}
        {tryTitle}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor={`${uid}-path`}>Folder path</Label>
          <Input
            id={`${uid}-path`}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onBlur={commitPath}
            onKeyDown={(e) => e.key === "Enter" && commitPath()}
            className="font-mono"
            aria-invalid={others.length > 0}
            aria-describedby={`${uid}-path-hint`}
          />
          <p id={`${uid}-path-hint`} className="text-xs text-muted-foreground">
            Use <code>{"{name}"}</code> for a level whose name varies, e.g. <code>{"clients/{client}/meetings"}</code>.
          </p>
        </div>
        <Button variant="outline" size="sm" className={BAD} onClick={onRemove}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Remove rule
        </Button>
      </div>
      {others.map(([k, m]) => (
        <FieldError key={k} message={m} />
      ))}

      <Section title="What can be added here">
        <div className="flex flex-wrap gap-x-4 gap-y-2" role="group" aria-label="Allowed types" {...described("types")}>
          {types.map((t) => {
            const on = rule.types?.includes(t) ?? false;
            return (
              <label key={t} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  checked={on}
                  onCheckedChange={(v) => {
                    const next = v ? [...(rule.types ?? []), t] : (rule.types ?? []).filter((x) => x !== t);
                    onChange({ types: next.length ? next : undefined });
                  }}
                />
                {t}
              </label>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">None ticked: any type.</p>
        <FieldError id={errId("types")} message={err("types")} />
      </Section>

      {namedLeaf && (
        <Section title="Folder names">
          <NameFormat
            label="Folder name format"
            value={rule.folder_name ?? ""}
            presets={FOLDER_NAME_PRESETS}
            onChange={(v) => onChange({ folder_name: v })}
            error={err("folder_name") ? errId("folder_name") : undefined}
          />
          <FieldError id={errId("folder_name")} message={err("folder_name")} />
          {tryFolder}
        </Section>
      )}

      <Section title="File names">
        <NameFormat
          label="File name format"
          value={rule.file_name ?? ""}
          presets={FILE_NAME_PRESETS}
          onChange={(v) => onChange({ file_name: v })}
          error={err("file_name") ? errId("file_name") : undefined}
        />
        <FieldError id={errId("file_name")} message={err("file_name")} />
        {tryTitle}
      </Section>

      <div className="grid gap-5 sm:grid-cols-2">
        <Section title="New files start from">
          <Select value={rule.template ?? NONE} onValueChange={(v) => onChange({ template: v === NONE ? undefined : v })}>
            <SelectTrigger aria-label="Template new files start from" {...described("template")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No template</SelectItem>
              {templates.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
              {rule.template && !templates.includes(rule.template) && (
                <SelectItem value={rule.template}>{rule.template} (not defined)</SelectItem>
              )}
            </SelectContent>
          </Select>
          <FieldError id={errId("template")} message={err("template")} />
        </Section>
        <Section title="Required">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox className="mt-0.5" checked={!!rule.required} onCheckedChange={(v) => onChange({ required: !!v })} />
            <span>Create with its parent folder, and keep it while the parent exists</span>
          </label>
          <FieldError id={errId("required")} message={err("required")} />
        </Section>
      </div>

      <Section title="Required files">
        {files.length === 0 && <p className="text-sm text-muted-foreground">None.</p>}
        {files.map(([leaf, spec]) => (
          <div key={leaf} className="flex flex-wrap items-center gap-2">
            <code className="rounded border px-2 py-1 text-sm">{leaf}</code>
            <span className="text-sm text-muted-foreground">from</span>
            <Select
              value={spec?.template ?? NONE}
              onValueChange={(v) => setFiles({ ...rule.files, [leaf]: { ...spec, template: v === NONE ? undefined : v } })}
            >
              <SelectTrigger className="h-8 w-48" aria-label={`Template for required file ${leaf}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No template</SelectItem>
                {templates.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              aria-label={`Remove required file ${leaf}`}
              onClick={() => {
                const { [leaf]: _gone, ...rest } = rule.files ?? {};
                setFiles(rest);
              }}
            >
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        ))}
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const leaf = newFile.trim();
            if (!leaf || rule.files?.[leaf] !== undefined) return;
            setFiles({ ...rule.files, [leaf]: {} });
            setNewFile("");
          }}
        >
          <Input value={newFile} onChange={(e) => setNewFile(e.target.value)} placeholder="e.g. overview" className="h-8 w-48" aria-label="Required file name" />
          <Button type="submit" variant="outline" size="sm" disabled={!newFile.trim()}>
            Add file
          </Button>
        </form>
        <FieldError id={errId("files")} message={err("files")} />
      </Section>
    </div>
  );
}

/** A name format: one-click presets, or a token pattern / `/regex/` typed in. */
function NameFormat({
  label,
  value,
  presets,
  onChange,
  error,
}: {
  label: string;
  value: string;
  presets: readonly { label: string; value: string }[];
  onChange: (v: string) => void;
  /** The id of the error describing this field, when there is one. */
  error?: string;
}) {
  const hintId = useId();
  // Names are derived from titles and folder names, so a regex sees lowercase
  // kebab-case: `/[A-Z]+/` can never match (docs/prds/structure-rules.md §3.3).
  const isRegex = value.trim().startsWith("/");
  const describedBy = [error, isRegex ? hintId : undefined].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={`${label} presets`}>
        {presets.map((p) => (
          <Button
            key={p.label}
            type="button"
            size="sm"
            variant={value === p.value ? "default" : "outline"}
            aria-pressed={value === p.value}
            className="h-7"
            onClick={() => onChange(p.value)}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Any name — or a pattern like {date}-{slug}, or /regex/"
        className={`font-mono ${error ? "border-red-600 dark:border-red-400" : ""}`}
        aria-label={label}
        aria-invalid={!!error}
        aria-describedby={describedBy}
      />
      {isRegex && (
        <p id={hintId} className="text-xs text-muted-foreground">
          A /regex/ is matched against the name as it is stored: lowercase letters, digits and "-".
        </p>
      )}
    </div>
  );
}
