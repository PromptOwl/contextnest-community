/**
 * ImportFolderModal — import a folder the user picks via the OS folder dialog.
 *
 * Uses a webkitdirectory <input>: clicking it opens the native folder picker,
 * the browser reads the chosen directory, and we collect each markdown /
 * governance file's relative path + content and upload them to POST
 * /nests/import. The server writes them into the workspace, so import works
 * whether or not the server runs on the user's machine.
 *
 * We deliberately avoid showDirectoryPicker (File System Access API): it asks
 * for a read-WRITE disk handle, which triggers the browser's heavy "allow this
 * site to view and copy files?" permission prompt. The input only reads +
 * uploads, so the browser shows the milder "upload N files?" confirmation.
 * Neither prompt can be fully suppressed — both are browser security gates.
 */
import { useState, useRef } from "react";
import JSZip from "jszip";
import * as api from "../lib/api";
import type { ImportedFile } from "../lib/api";
import { splitExportedMarkdown } from "../lib/markdown-split";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Loader2, FolderInput } from "lucide-react";

interface ImportFolderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImported: () => void;
}

// Text files we ingest: documents + engine governance history. Binary assets
// (images, etc.) are skipped — they'd bloat the JSON upload and aren't nodes.
const TEXT_FILE = /\.(md|markdown|ya?ml|txt|json)$/i;

// A path segment we never recurse into. `.versions` (engine version history)
// and `.context` (nest config.yaml) are exceptions — we preserve them on
// import so history + config travel with the content. `_suggestions` is the
// engine's per-doc staged-suggestion store — a nest's own derived governance
// state that must NOT ride along (it would surface as phantom external edits).
function isSkippedDir(name: string): boolean {
  if (name === ".versions" || name === ".context") return false;
  return name.startsWith(".") || name === "node_modules" || name === "_suggestions";
}

// Engine/agent files that ride along but never become documents — mirrors
// FlatNestStorage discovery so the modal's "will import" count matches what
// the server actually registers.
const META_FILES = new Set([
  "INDEX.md", "CONTEXT.md", "CLAUDE.md", "GEMINI.md", "AGENTS.md", "QWEN.md",
]);

/** How many collected files will actually become documents. The upload also
 *  carries .versions history + yaml/txt/json, none of which are docs, so the
 *  raw file count badly overstates what gets imported. */
function countImportableDocs(files: ImportedFile[]): number {
  return files.filter((f) => {
    const segs = f.path.split("/");
    const name = segs[segs.length - 1];
    if (!name.endsWith(".md")) return false; // discovery keys off .md only
    if (META_FILES.has(name)) return false;
    return !segs.some((s) => s.startsWith(".") || s === "node_modules");
  }).length;
}

/** Walk a FileSystemDirectoryHandle, collecting text files with relative paths. */
async function collectFromHandle(
  dir: any,
  prefix: string,
  out: ImportedFile[],
): Promise<void> {
  for await (const entry of dir.values()) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") {
      if (isSkippedDir(entry.name)) continue;
      await collectFromHandle(entry, rel, out);
    } else if (TEXT_FILE.test(entry.name)) {
      const file = await entry.getFile();
      out.push({ path: rel, content: await file.text() });
    }
  }
}

/** Expand a nest .zip (exported from another host) into the same ImportedFile[]
 *  a picked folder produces — its inner text files at their zip-internal paths.
 *  Lets the import reuse POST /nests/import with no bundle-specific endpoint. */
async function expandZip(file: File, out: ImportedFile[]): Promise<void> {
  const zip = await JSZip.loadAsync(file);
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const segs = entry.name.split("/");
    if (segs.some(isSkippedDir) || !TEXT_FILE.test(segs[segs.length - 1])) continue;
    out.push({ path: entry.name, content: await entry.async("string") });
  }
}

/** Collect text files from a webkitdirectory <input> FileList (fallback path). */
async function collectFromInput(list: FileList): Promise<ImportedFile[]> {
  const out: ImportedFile[] = [];
  for (const file of Array.from(list)) {
    // webkitRelativePath = "<chosenFolder>/sub/dir/file.md" — drop the root.
    const parts = file.webkitRelativePath.split("/");
    parts.shift();
    const rel = parts.join("/");
    if (!rel || parts.some(isSkippedDir) || !TEXT_FILE.test(file.name)) continue;
    out.push({ path: rel, content: await file.text() });
  }
  return out;
}

export function ImportFolderModal({ isOpen, onClose, onImported }: ImportFolderModalProps) {
  const [mode, setMode] = useState<"folder" | "file">("folder");
  const [folderName, setFolderName] = useState("");
  const [files, setFiles] = useState<ImportedFile[] | null>(null);
  const [name, setName] = useState("");
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setMode("folder");
    setFolderName("");
    setFiles(null);
    setName("");
    setError(null);
    setScanning(false);
    setImporting(false);
    setProgress(null);
  };

  // Switching source clears any prior selection so a stale folder pick can't be
  // imported after the user flips to "File / .zip" (or vice-versa).
  const switchMode = (next: "folder" | "file") => {
    if (next === mode) return;
    setMode(next);
    setFiles(null);
    setFolderName("");
    setError(null);
  };

  const handleClose = () => {
    if (importing) return;
    reset();
    onClose();
  };

  // Native System folder dialog. Prefers showDirectoryPicker (Chromium); falls
  // back to a webkitdirectory <input> (other browsers).
  const pickFolder = async () => {
    setError(null);
    const picker = (window as any).showDirectoryPicker;
    if (typeof picker !== "function") {
      inputRef.current?.click();
      return;
    }
    let handle: any;
    try {
      handle = await picker();
    } catch (err: any) {
      if (err?.name === "AbortError") return; // user cancelled
      console.error("[ImportFolderModal] showDirectoryPicker failed", err);
      setError("Couldn't open that folder");
      return;
    }
    setScanning(true);
    try {
      const out: ImportedFile[] = [];
      await collectFromHandle(handle, "", out);
      setFolderName(handle.name);
      setFiles(out);
      setName((n) => n || handle.name);
    } catch (err: any) {
      console.error("[ImportFolderModal] scan failed", err);
      setError("Couldn't read that folder");
    } finally {
      setScanning(false);
    }
  };

  const onInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list || !list.length) return;
    setScanning(true);
    setError(null);
    try {
      const root = list[0].webkitRelativePath.split("/")[0] || "Imported";
      const out = await collectFromInput(list);
      setFolderName(root);
      setFiles(out);
      setName((n) => n || root);
    } catch (err: any) {
      console.error("[ImportFolderModal] scan failed", err);
      setError("Couldn't read that folder");
    } finally {
      setScanning(false);
      e.target.value = ""; // allow re-picking the same folder
    }
  };

  // Separate file picker — a webkitdirectory input is folder-only (greys out
  // files in the OS dialog), so importing an exported bundle or loose docs
  // needs its own file input. Accepts a nest .zip (expanded) and/or plain
  // markdown/text files. Same collected-files shape, same import flow below.
  const onFilesChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    // Snapshot the FileList BEFORE clearing the input — `e.target.files` is a
    // live reference, so resetting value first would empty it and drop the pick.
    const picked = e.target.files ? Array.from(e.target.files) : [];
    if (!picked.length) return;
    setScanning(true);
    setError(null);
    try {
      const out: ImportedFile[] = [];
      let label = "Imported";
      for (const file of picked) {
        if (file.name.toLowerCase().endsWith(".zip")) {
          await expandZip(file, out);
          label = file.name.replace(/\.zip$/i, "") || label;
        } else if (/\.(md|markdown)$/i.test(file.name)) {
          // A whole-nest markdown export splits into its documents; a normal
          // single doc passes through as one file.
          for (const f of splitExportedMarkdown(await file.text(), file.name)) {
            out.push(f);
          }
        } else if (TEXT_FILE.test(file.name)) {
          out.push({ path: file.name, content: await file.text() });
        }
      }
      setFolderName(label);
      setFiles(out);
      setName((n) => n || label);
    } catch (err: any) {
      console.error("[ImportFolderModal] file read failed", err);
      setError("Couldn't read that selection");
    } finally {
      setScanning(false);
      e.target.value = ""; // reset AFTER use so the same file can be re-picked
    }
  };

  const handleImport = async () => {
    if (!files) return;
    setImporting(true);
    setProgress(null);
    setError(null);
    try {
      await api.importNest(name.trim() || folderName, files, (done, total) =>
        setProgress({ done, total }),
      );
      onImported();
      handleClose();
    } catch (err: any) {
      console.error("[ImportFolderModal] import failed", err);
      setError(err?.message || "Import failed");
      setImporting(false);
      setProgress(null);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderInput className="h-5 w-5" />
            Import into a new nest
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Import a folder from your computer, or a nest <code>.zip</code> (or
            markdown files) exported from another host. Files are uploaded into a
            new nest — your originals are left untouched.
          </p>

          {/* Hidden webkitdirectory input — fallback when showDirectoryPicker
              is unavailable. The non-standard attrs are set via ref below. */}
          <input
            ref={(el) => {
              inputRef.current = el;
              if (el) {
                el.setAttribute("webkitdirectory", "");
                el.setAttribute("directory", "");
              }
            }}
            type="file"
            multiple
            className="hidden"
            onChange={onInputChange}
          />
          {/* Separate file input — a nest .zip or loose markdown/text files.
              Folder (webkitdirectory) inputs can't select files, so this is its
              own input. */}
          <input
            ref={zipInputRef}
            type="file"
            multiple
            accept=".zip,.md,.markdown,.yaml,.yml,.txt,.json"
            className="hidden"
            onChange={onFilesChange}
          />

          <div className="space-y-2">
            {/* Source picker — one full-width action follows the choice. */}
            <div className="flex gap-2" role="radiogroup" aria-label="Import source">
              {([
                { id: "folder", label: "Folder" },
                { id: "file", label: "File / .zip" },
              ] as const).map((opt) => (
                <label
                  key={opt.id}
                  className={`flex flex-1 items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer transition-colors ${
                    mode === opt.id
                      ? "border-primary bg-primary/5 text-foreground"
                      : "border-border text-muted-foreground hover:bg-secondary/50"
                  }`}
                >
                  <input
                    type="radio"
                    name="import-source"
                    className="accent-primary"
                    checked={mode === opt.id}
                    onChange={() => switchMode(opt.id)}
                    disabled={scanning || importing}
                  />
                  {opt.label}
                </label>
              ))}
            </div>

            <Button
              className="w-full"
              variant="outline"
              onClick={
                mode === "folder"
                  ? pickFolder
                  : () => { setError(null); zipInputRef.current?.click(); }
              }
              disabled={scanning || importing}
            >
              {scanning ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <FolderInput className="h-4 w-4 mr-2" />
              )}
              {mode === "folder" ? "Choose folder" : "Choose .zip or files"}
            </Button>

            {files && (() => {
              const docs = countImportableDocs(files);
              return (
                <p className="break-words text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{folderName}</span>
                  {" — "}
                  {docs} document{docs === 1 ? "" : "s"}
                  <span className="text-xs"> · {files.length} file{files.length === 1 ? "" : "s"} scanned</span>
                </p>
              );
            })()}
          </div>

          <div className="space-y-1">
            <Label>Nest name</Label>
            <Input
              placeholder={folderName || "My Folder"}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {importing && (
            <div className="space-y-1">
              <Progress
                value={progress && progress.total > 0
                  ? Math.round((progress.done / progress.total) * 100)
                  : undefined}
              />
              <p className="text-xs text-muted-foreground">
                {progress
                  ? `Registering ${progress.done} of ${progress.total} documents…`
                  : "Uploading and preparing…"}
              </p>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={importing}>
            Cancel
          </Button>
          <Button onClick={handleImport} disabled={!files || scanning || importing}>
            {importing ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <FolderInput className="h-4 w-4 mr-2" />
            )}
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
