/**
 * VersionHistory — ported from packages/ui-components/src/DocumentViewer/VersionHistory.tsx
 * Adapted: `versions` and callbacks passed as props (no server-action imports).
 */
import React, { useState } from "react";
import { History, RotateCcw, Eye, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

export interface Version {
  version: number;
  content?: string;
  editedBy: string;
  editedAt: string;
  changeNote?: string;
  status: "draft" | "pending_review" | "approved" | "rejected";
  /** Email of the steward who approved or rejected this version, when one
   *  has resolved a review. Drives the "approved by …" hint in the row. */
  resolvedBy?: string;
  resolutionStatus?: "approved" | "rejected" | string;
}

interface VersionHistoryProps {
  versions: Version[];
  currentVersion: number;
  approvedVersion?: number | null;
  loading?: boolean;
  onRestore?: (versionNumber: number) => Promise<void>;
  className?: string;
}

function formatDate(dateStr: string) {
  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function VersionHistory({
  versions,
  currentVersion,
  approvedVersion,
  loading = false,
  onRestore,
  className,
}: VersionHistoryProps) {
  const [previewVersion, setPreviewVersion] = useState<Version | null>(null);
  const [restoreVersion, setRestoreVersion] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);

  const handleRestore = async () => {
    if (!restoreVersion || !onRestore) return;
    setRestoring(true);
    try {
      await onRestore(restoreVersion);
      setRestoreVersion(null);
    } finally {
      setRestoring(false);
    }
  };

  if (loading) {
    return (
      <Card className={className}>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <History className="h-4 w-4" />
            Version History
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const currentVersionStatus = versions.find(
    (v) => v.version === currentVersion,
  )?.status;
  const statusBadgeColor =
    currentVersionStatus === "approved"
      ? "bg-green-100 text-green-800 border-green-200"
      : currentVersionStatus === "rejected"
        ? "bg-red-100 text-red-800 border-red-200"
        : currentVersionStatus === "pending_review"
          ? "bg-amber-100 text-amber-800 border-amber-200"
          : "bg-muted text-muted-foreground";

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <History className="h-4 w-4" />
          Version History
          {currentVersionStatus && (
            <Badge
              variant="outline"
              className={`text-[10px] ${statusBadgeColor}`}
            >
              {currentVersionStatus.replace("_", " ")}
            </Badge>
          )}
          <Badge variant="secondary" className="text-[10px] ml-auto">
            v{currentVersion}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {versions.length === 0 ? (
          <div className="text-center py-4 text-sm text-muted-foreground">
            No version history
          </div>
        ) : (
          <ScrollArea className="max-h-[240px]">
            <div className="space-y-1">
              {versions.map((version) => {
                const isApproved = version.version === approvedVersion;
                return (
                  <div
                    key={version.version}
                    className={`flex items-center justify-between p-2 rounded hover:bg-muted/50 group ${
                      isApproved ? "bg-green-50 border border-green-200" : ""
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium flex items-center gap-2">
                        Version {version.version}
                        {isApproved && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-green-700">
                            <CheckCircle2 className="h-3 w-3" /> AI-active
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground break-words">
                        {formatDate(version.editedAt)} · {version.editedBy}
                        {version.changeNote && ` · ${version.changeNote}`}
                      </div>
                      {version.resolvedBy && (
                        <div className="text-xs text-muted-foreground break-words">
                          {version.resolutionStatus === "rejected"
                            ? "Rejected by"
                            : "Approved by"}{" "}
                          <span className="font-medium">
                            {version.resolvedBy}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {version.content && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setPreviewVersion(version)}
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {onRestore && version.version !== currentVersion && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setRestoreVersion(version.version)}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>

      <Dialog open={!!previewVersion} onOpenChange={() => setPreviewVersion(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>Version {previewVersion?.version} Preview</DialogTitle>
            <DialogDescription>
              {previewVersion && formatDate(previewVersion.editedAt)}
              {previewVersion?.changeNote && ` · ${previewVersion.changeNote}`}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-[50vh]">
            <pre className="text-sm whitespace-pre-wrap font-mono p-4 bg-muted/30 rounded">
              {previewVersion?.content || "(no content)"}
            </pre>
          </ScrollArea>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewVersion(null)}>
              Close
            </Button>
            {onRestore && previewVersion && previewVersion.version !== currentVersion && (
              <Button
                onClick={() => {
                  setRestoreVersion(previewVersion.version);
                  setPreviewVersion(null);
                }}
              >
                <RotateCcw className="h-4 w-4 mr-2" />
                Restore This Version
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!restoreVersion} onOpenChange={() => setRestoreVersion(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore Version {restoreVersion}?</DialogTitle>
            <DialogDescription>
              This will create a new version with the content from version {restoreVersion}. Your current content will be saved in the version history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRestoreVersion(null)} disabled={restoring}>
              Cancel
            </Button>
            <Button onClick={handleRestore} disabled={restoring}>
              {restoring ? "Restoring..." : "Restore"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
