/**
 * What in this nest does not fit its saved rules today. Existing content is
 * grandfathered: it stays readable and editable, so this is a to-do list,
 * not an error — each row says what is wrong and offers the fix it can.
 */
import { useState } from "react";
import { ExternalLink, FolderOpen, FolderPlus, FilePlus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import * as api from "../../lib/api";
import type { StructureViolation } from "../../lib/api";
import { placesOf } from "../../lib/structure-draft";

/** Each code in words, in the order a person would fix them. */
const GROUPS: Array<{ code: string; title: string }> = [
  { code: "FOLDER_NOT_ALLOWED", title: "Folders the structure doesn't allow" },
  { code: "FOLDER_NAME", title: "Folders named differently from their rule" },
  { code: "MISSING_FOLDER", title: "Required folders that don't exist yet" },
  { code: "MISSING_FILE", title: "Required files that don't exist yet" },
  { code: "TYPE_NOT_ALLOWED", title: "Documents of a type their folder doesn't take" },
  { code: "FILE_NAME", title: "Documents named differently from their folder's format" },
  { code: "MISSING_SECTION", title: "Documents missing a required heading" },
];

/** Codes whose path is a document (the rest are folders). */
const DOCUMENT_CODES = new Set(["FILE_NAME", "TYPE_NOT_ALLOWED", "MISSING_SECTION"]);

const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
const titleOf = (leaf: string) => leaf.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function ComplianceTab({
  nestId,
  nestName,
  violations,
  loading,
  dirty,
  canEdit,
  templates,
  openDocument,
  openFolder,
  onChanged,
}: {
  nestId: string;
  nestName: string;
  violations: StructureViolation[] | undefined;
  loading: boolean;
  dirty: boolean;
  /** Can create documents and folders here (the fix actions). */
  canEdit: boolean;
  /** Saved templates by name, for "Create from template". */
  templates: Record<string, { body: string }>;
  openDocument: (nodeId: string) => void;
  openFolder: (folder: string) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  if (loading || !violations) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Loading the compliance report">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-10 animate-pulse rounded bg-muted" />
        ))}
      </div>
    );
  }

  const run = async (key: string, task: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await task();
      toast.success(done);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const createFromTemplate = async (path: string) => {
    const folder = parentOf(path);
    const leaf = path.split("/").pop() ?? path;
    const { resolved } = await api.getStructure(nestId, { folder });
    const template = resolved?.files?.[leaf]?.template;
    const body = (template && templates[template]?.body) || `# ${titleOf(leaf)}\n`;
    await api.createNode(nestId, { title: titleOf(leaf), content: body, folder });
  };

  const actionFor = (v: StructureViolation) => {
    const key = `${v.code}:${v.path}`;
    const spinning = busy === key ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null;
    if (DOCUMENT_CODES.has(v.code)) {
      return (
        <Button variant="outline" size="sm" className="h-8" onClick={() => openDocument(`nodes/${v.path}`)}>
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden />
          Open
        </Button>
      );
    }
    if (v.code === "MISSING_FOLDER" && canEdit) {
      return (
        <Button variant="outline" size="sm" className="h-8" disabled={!!busy} onClick={() => run(key, () => api.createFolder(nestId, v.path), `Created ${v.path}/`)}>
          {spinning ?? <FolderPlus className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
          Create folder
        </Button>
      );
    }
    if (v.code === "MISSING_FILE" && canEdit) {
      return (
        <Button variant="outline" size="sm" className="h-8" disabled={!!busy} onClick={() => run(key, () => createFromTemplate(v.path), `Created ${v.path} as a draft`)}>
          {spinning ?? <FilePlus className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
          Create from template
        </Button>
      );
    }
    const folder = v.code === "MISSING_FILE" || v.code === "MISSING_FOLDER" ? parentOf(v.path) : v.path;
    return (
      <Button variant="outline" size="sm" className="h-8" onClick={() => openFolder(folder)}>
        <FolderOpen className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        Show folder
      </Button>
    );
  };

  const groups = GROUPS.map((g) => ({ ...g, rows: violations.filter((v) => v.code === g.code) })).filter((g) => g.rows.length > 0);
  const other = violations.filter((v) => !GROUPS.some((g) => g.code === v.code));
  if (other.length) groups.push({ code: "OTHER", title: "Other problems", rows: other });

  return (
    <div className="space-y-4">
      {dirty && <p className="text-xs text-muted-foreground">This reflects the saved rules, not your unsaved changes.</p>}
      {violations.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">Everything in {nestName} fits its rules.</div>
      ) : (
        <>
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <p className="font-medium">
              {violations.length} problem{violations.length === 1 ? "" : "s"} in {placesOf(violations)} place{placesOf(violations) === 1 ? "" : "s"}
            </p>
            <p className="text-muted-foreground">
              Existing content stays readable and editable. Fix what you can here; new writes must follow the rules once they are enforced.
            </p>
          </div>
          {groups.map((g) => (
            <section key={g.code} aria-labelledby={`compliance-${g.code}`} className="space-y-2">
              <h3 id={`compliance-${g.code}`} className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                {g.title}
                <code className="rounded bg-red-50 px-1.5 py-0.5 text-xs font-normal text-red-800 dark:bg-red-950 dark:text-red-200">{g.code}</code>
                <span className="text-xs font-normal text-muted-foreground">{g.rows.length}</span>
              </h3>
              <ul className="divide-y rounded-lg border">
                {g.rows.map((v, i) => (
                  <li key={`${v.path}:${i}`} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="break-all font-mono text-xs">{v.path}</p>
                      <p className="text-sm">{v.message}</p>
                    </div>
                    <div className="shrink-0">{actionFor(v)}</div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
