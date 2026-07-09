/**
 * VersionHistoryModal — the Dialog shell around {@link VersionHistory}.
 *
 * DocumentEditor and NestView both open the exact same version-history
 * dialog; this component is the single source for its width, layout, header,
 * loading state, and VersionHistory wiring. Callers supply only what differs:
 * open/close state, the title, the loaded version data, and the restore
 * handler (omit `onRestore` to render read-only).
 */
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { VersionHistory, type Version } from "./VersionHistory";

export interface VersionHistoryData {
  versions: Version[];
  currentVersion: number;
  approvedVersion: number | null;
}

interface VersionHistoryModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Loaded versions, or null while still fetching (shows a spinner). */
  versionData: VersionHistoryData | null;
  /** Restore a version. Omit to render the history read-only. */
  onRestore?: (version: number) => Promise<void>;
}

export function VersionHistoryModal({
  open,
  onClose,
  title,
  versionData,
  onRestore,
}: VersionHistoryModalProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[860px] max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {versionData ? (
          <VersionHistory
            className="flex-1 min-h-0 overflow-hidden"
            versions={versionData.versions}
            currentVersion={versionData.currentVersion}
            approvedVersion={versionData.approvedVersion}
            onRestore={onRestore}
          />
        ) : (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Loading versions…
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default VersionHistoryModal;
