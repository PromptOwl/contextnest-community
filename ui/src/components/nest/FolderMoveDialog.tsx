import { useState } from "react";
import { FolderInput, Loader2 } from "lucide-react";
import { toast } from "sonner";
import * as api from "../../lib/api";
import { checkFolderPath } from "../../lib/folder-path";
import { prettyFolderPath } from "../FolderTree";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

/** Rename or move a folder (admins/owners). Pick the parent folder from the
 *  nest's existing folders and edit the name; the new path is parent + name. */
export function FolderMoveDialog({
  nestId,
  folder,
  folders,
  onClose,
  onDone,
}: {
  nestId: string;
  folder: { path: string; label: string };
  /** Every folder path in the nest. */
  folders: string[];
  onClose: () => void;
  onDone: (newPath: string) => void;
}) {
  const segments = folder.path.split("/");
  const [parent, setParent] = useState(segments.slice(0, -1).join("/"));
  const [name, setName] = useState(segments[segments.length - 1]);
  const [busy, setBusy] = useState(false);

  // A folder can't move into itself or one of its own sub-folders.
  const parents = folders.filter((f) => f !== folder.path && !f.startsWith(folder.path + "/"));
  const check = checkFolderPath(parent ? `${parent}/${name}` : name);
  const unchanged = check.path === folder.path;
  const taken = !unchanged && folders.includes(check.path);
  const error = check.error ?? (taken ? `A folder named "${check.label}" already exists.` : null);

  const submit = async () => {
    setBusy(true);
    try {
      const { folder: next, moved } = await api.moveFolder(nestId, folder.path, check.path);
      toast.success(`Moved to ${next} — ${moved.length} document${moved.length === 1 ? "" : "s"}`);
      onDone(next);
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't move the folder");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Rename or move "{folder.label}"</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Everything inside moves with it — ids, history, review state and links are kept.
        </p>
        <label className="text-sm font-medium" htmlFor="folder-move-name">Name</label>
        <Input
          id="folder-move-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="folder-move-name"
        />
        <label className="text-sm font-medium">Move to</label>
        <Select value={parent === "" ? "__root__" : parent} onValueChange={(v) => setParent(v === "__root__" ? "" : v)}>
          <SelectTrigger data-testid="folder-move-parent">
            <SelectValue placeholder="Choose a folder" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__root__">Nest root</SelectItem>
            {parents.map((f) => (
              <SelectItem key={f} value={f}>{prettyFolderPath(f)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            New location: <code className="font-mono">{check.label || "Nest root"}</code>
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button disabled={busy || unchanged || !check.path || !!error} onClick={submit}>
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FolderInput className="h-4 w-4 mr-2" />}
            Rename / move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
