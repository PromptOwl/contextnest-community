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
import * as api from "../lib/api";
import type { ImportedFile } from "../lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

// A path segment we never recurse into. `.versions` is the exception — it
// carries engine history we want to preserve on import.
function isSkippedDir(name: string): boolean {
  if (name === ".versions") return false;
  return name.startsWith(".") || name === "node_modules";
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
  const [folderName, setFolderName] = useState("");
  const [files, setFiles] = useState<ImportedFile[] | null>(null);
  const [name, setName] = useState("");
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    setFolderName("");
    setFiles(null);
    setName("");
    setError(null);
    setScanning(false);
    setImporting(false);
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

  const handleImport = async () => {
    if (!files) return;
    setImporting(true);
    setError(null);
    try {
      await api.importNest(name.trim() || folderName, files);
      onImported();
      handleClose();
    } catch (err: any) {
      console.error("[ImportFolderModal] import failed", err);
      setError(err?.message || "Import failed");
      setImporting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderInput className="h-5 w-5" />
            Import a folder
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Choose a folder from your computer. Its markdown files are uploaded
            into a new nest — your original folder is left untouched, and the
            nest can be shared with collaborators.
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

          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={pickFolder} disabled={scanning || importing}>
              {scanning ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <FolderInput className="h-4 w-4 mr-2" />
              )}
              Choose folder
            </Button>
            {files && (
              <span className="text-sm text-muted-foreground truncate">
                <span className="font-medium text-foreground">{folderName}</span>
                {" — "}
                {files.length} file{files.length === 1 ? "" : "s"}
              </span>
            )}
          </div>

          <div className="space-y-1">
            <Label>Nest name</Label>
            <Input
              placeholder={folderName || "My Folder"}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

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
