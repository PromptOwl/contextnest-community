import { toast } from "sonner";
import * as api from "../../lib/api";
import { ReasonDialog } from "../governance";

/** Rename or move a folder (admins/owners). The new path is the folder's whole
 *  path: change the last segment to rename, the parent to move. */
export function FolderMoveDialog({
  nestId,
  folder,
  onClose,
  onDone,
}: {
  nestId: string;
  folder: { path: string; label: string };
  onClose: () => void;
  onDone: (newPath: string) => void;
}) {
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Rename or move "${folder.label}"`}
      description="Everything inside moves with it — ids, history, review state and links are kept. Change the last part to rename it, or the path before it to move it, e.g. archive/acme."
      label="New path"
      placeholder={folder.path}
      confirmLabel="Rename / move"
      onConfirm={async (to) => {
        const { folder: next, moved } = await api.moveFolder(nestId, folder.path, to);
        toast.success(`Moved to ${next} — ${moved.length} document${moved.length === 1 ? "" : "s"}`);
        onDone(next);
      }}
    />
  );
}
