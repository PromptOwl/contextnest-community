/**
 * One folder rule of a nest, edited in place. Every verdict — does this rule
 * compile, does a title fit — comes from the server's check API; this form
 * only shapes the draft.
 */
import { useEffect, useState } from "react";
import { Trash2, X, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import * as api from "../../lib/api";
import type { StructureFolderConfig, StructureRules } from "../../lib/api";
import { FILE_NAME_PRESETS, FOLDER_NAME_PRESETS } from "../../lib/structure-draft";

const NONE = "__none__";

interface Props {
  nestId: string;
  pattern: string;
  rule: StructureFolderConfig;
  /** The whole draft, so the live checks judge what would be saved. */
  draft: StructureRules;
  /** Whether the caller may edit (and so check a draft); otherwise saved rules are checked. */
  canManage: boolean;
  templates: string[];
  types: string[];
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

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-xs text-destructive">{message}</p> : null;
}

/** Debounced server check of one title or folder name against the draft. */
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
    <p className={`flex items-start gap-1.5 text-sm ${ok ? "text-green-700 dark:text-green-400" : "text-destructive"}`}>
      {ok ? <Check className="mt-0.5 h-4 w-4 shrink-0" /> : <X className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{text}</span>
    </p>
  );
}

export function RuleEditor({
  nestId,
  pattern,
  rule,
  draft,
  canManage,
  templates,
  types,
  fieldErrors,
  onChange,
  onRename,
  onRemove,
}: Props) {
  const err = (field: string) => fieldErrors[`folders.${pattern}.${field}`];
  const [path, setPath] = useState(pattern);
  useEffect(() => setPath(pattern), [pattern]);
  const [title, setTitle] = useState("");
  const [folderName, setFolderName] = useState("");
  const [newFile, setNewFile] = useState("");
  // A folder name is tried only where the rule's path ends in a {name}.
  const namedLeaf = pattern.endsWith("}");

  const rules = canManage ? draft : undefined;
  const titleCheck = useCheck(nestId, title.trim() ? { rules, tests: [{ folder: pattern, title }] } : null);
  const tried = pattern.replace(/\{[^/{}]*\}$/, folderName.trim());
  const folderCheck = useCheck(nestId, namedLeaf && folderName.trim() ? { rules, folders: [tried] } : null);

  // The title box judges the name; the folder's own path is tried below it.
  const titleResult = titleCheck?.results[0];
  const nameProblems = titleResult?.violations.filter((v) => v.code === "FILE_NAME") ?? [];
  const folderResult = folderCheck?.folders[0];
  const folderProblems = folderResult?.violations.filter((v) => v.path === folderResult.folder) ?? [];

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

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <Label htmlFor="rule-path">Folder path</Label>
          <Input
            id="rule-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onBlur={commitPath}
            onKeyDown={(e) => e.key === "Enter" && commitPath()}
            className="font-mono"
            aria-invalid={!!others.length}
          />
          <p className="text-xs text-muted-foreground">
            Use <code>{"{name}"}</code> for a level whose name varies, e.g. <code>{"clients/{client}/meetings"}</code>.
          </p>
        </div>
        <Button variant="outline" size="sm" className="text-destructive" onClick={onRemove}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Remove rule
        </Button>
      </div>
      {others.map(([k, m]) => (
        <FieldError key={k} message={m} />
      ))}

      <Section title="What can be added here">
        <div className="flex flex-wrap gap-x-4 gap-y-2">
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
        <FieldError message={err("types")} />
      </Section>

      {namedLeaf && (
        <Section title="Folder names">
          <NameFormat
            value={rule.folder_name ?? ""}
            presets={FOLDER_NAME_PRESETS}
            onChange={(v) => onChange({ folder_name: v })}
            invalid={!!err("folder_name")}
          />
          <FieldError message={err("folder_name")} />
          <div className="space-y-1.5 rounded-md border bg-muted/30 p-3">
            <Label htmlFor="try-folder" className="text-xs">Try a folder name</Label>
            <Input id="try-folder" value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder="acme-042" className="bg-background" />
            {folderResult &&
              (folderProblems.length ? (
                folderProblems.map((v, i) => <Verdict key={i} ok={false} text={v.message} />)
              ) : (
                <Verdict ok text={`${folderResult.folder}/ fits`} />
              ))}
          </div>
        </Section>
      )}

      <Section title="File names">
        <NameFormat
          value={rule.file_name ?? ""}
          presets={FILE_NAME_PRESETS}
          onChange={(v) => onChange({ file_name: v })}
          invalid={!!err("file_name")}
        />
        <FieldError message={err("file_name")} />
        <div className="space-y-1.5 rounded-md border bg-muted/30 p-3">
          <Label htmlFor="try-title" className="text-xs">Try a title</Label>
          <Input id="try-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="2026-10-07 Kickoff with Acme" className="bg-background" />
          {titleResult &&
            (nameProblems.length ? (
              nameProblems.map((v, i) => <Verdict key={i} ok={false} text={v.message} />)
            ) : (
              <Verdict ok text={`Saved as ${titleResult.slug}.md`} />
            ))}
          <p className="text-xs text-muted-foreground">Checked by the server, exactly as it will enforce.</p>
        </div>
      </Section>

      <div className="grid gap-5 sm:grid-cols-2">
        <Section title="New files start from">
          <Select value={rule.template ?? NONE} onValueChange={(v) => onChange({ template: v === NONE ? undefined : v })}>
            <SelectTrigger aria-invalid={!!err("template")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No template</SelectItem>
              {templates.map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError message={err("template")} />
        </Section>
        <Section title="Required">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox className="mt-0.5" checked={!!rule.required} onCheckedChange={(v) => onChange({ required: !!v })} />
            <span>Create with its parent folder, and keep it while the parent exists</span>
          </label>
          <FieldError message={err("required")} />
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
              <SelectTrigger className="h-8 w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No template</SelectItem>
                {templates.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
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
              <X className="h-4 w-4" />
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
          <Input value={newFile} onChange={(e) => setNewFile(e.target.value)} placeholder="overview" className="h-8 w-48" aria-label="Required file name" />
          <Button type="submit" variant="outline" size="sm" disabled={!newFile.trim()}>
            Add file
          </Button>
        </form>
        <FieldError message={err("files")} />
      </Section>
    </div>
  );
}

/** A name format: one-click presets, or a token pattern / `/regex/` typed in. */
function NameFormat({
  value,
  presets,
  onChange,
  invalid,
}: {
  value: string;
  presets: readonly { label: string; value: string }[];
  onChange: (v: string) => void;
  invalid: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <Button
            key={p.label}
            type="button"
            size="sm"
            variant={value === p.value ? "secondary" : "outline"}
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
        className="font-mono"
        aria-invalid={invalid}
      />
    </div>
  );
}
