import { toast } from "sonner";
import * as api from "../../lib/api";
import { ReasonDialog } from "../governance";

export type FolderDeleteTarget = { path: string; label: string; total: number };

/** Admins delete a folder (and every doc under it) outright; everyone else
 *  raises a request. Shared by the Documents tree and the Overview index. */
export function FolderDeleteDialog({
  nestId,
  folder,
  canManage,
  onClose,
  onDone,
}: {
  nestId: string;
  folder: FolderDeleteTarget;
  canManage: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const docs = `${folder.total} document${folder.total === 1 ? "" : "s"}`;
  return (
    <ReasonDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={canManage ? `Delete "${folder.label}"?` : `Request deletion of "${folder.label}"`}
      description={
        folder.total === 0
          ? canManage
            ? "This folder is empty — deleting it just removes it from the tree."
            : "A nest admin reviews this. The folder is empty, so nothing else is removed."
          : canManage
            ? `This deletes all ${docs} in this folder and its subfolders, with their history, comments and annotations. It cannot be undone.`
            : `A nest admin reviews this. Honouring it deletes all ${docs} in this folder. Nothing is removed yet.`
      }
      // Admins confirm; a request must say why.
      label={canManage ? undefined : "Why should it be deleted?"}
      placeholder="e.g. superseded by the new API docs"
      confirmLabel={canManage ? "Delete folder" : "Request deletion"}
      destructive={canManage}
      onConfirm={async (reason) => {
        if (canManage) {
          const { deleted } = await api.deleteFolder(nestId, folder.path);
          toast.success(
            deleted === 0
              ? `Deleted ${folder.label}`
              : `Deleted ${folder.label} — ${deleted} document${deleted === 1 ? "" : "s"}`,
          );
        } else {
          await api.requestTargetDeletion(nestId, "folder", folder.path, reason);
          toast.success("Deletion requested — a nest admin will review it");
        }
        onDone();
      }}
    />
  );
}
