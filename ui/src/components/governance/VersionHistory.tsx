/**
 * VersionHistory — ported from packages/ui-components/src/DocumentViewer/VersionHistory.tsx
 * Adapted: `versions` and callbacks passed as props (no server-action imports).
 */
import React, { useState } from "react";
import { History, RotateCcw, ArrowLeft, ChevronRight, Loader2, CheckCircle2, XCircle, Eye } from "lucide-react";
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
import { DiffViewer } from "./DiffViewer";
import { unifiedDiff } from "./diff-util";
import { DocumentViewer } from "../DocumentViewer";

export interface Version {
  version: number;
  content?: string;
  /**
   * This version's change log — the unified diff taking the previous version to
   * this one, as stored by the engine. Absent for a keyframe (a full snapshot,
   * so there is no patch) and for v1.
   */
  diff?: string;
  editedBy: string;
  editedAt: string;
  changeNote?: string;
  status: "draft" | "pending_review" | "approved" | "published" | "rejected";
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
  /**
   * How the preview pane renders a version's full body. "markdown" (default)
   * renders through DocumentViewer; "source" shows the raw text in a <pre> —
   * used for HTML artifacts, whose body is not markdown. Diffs are raw-text
   * either way.
   */
  previewAs?: "markdown" | "source";
  /**
   * Optional "view rendered" hook: the caller renders this version in its own
   * surface (e.g. the artifact iframe, pinned to ?v=N). Shown in the preview
   * pane for non-current versions.
   */
  onView?: (versionNumber: number) => void;
  /**
   * Fetch one version's full body, on demand. The list ships change logs rather
   * than N full bodies, so a body is loaded only when the user asks for full
   * content or a comparison against current. Resolve null when that version's
   * chain no longer reconstructs. Omit to disable those two modes.
   */
  onLoadContent?: (versionNumber: number) => Promise<string | null>;
  className?: string;
}

/** What the preview pane shows for the selected version. */
type PreviewMode = "changes" | "content" | "vs-current";

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

// Long ids (e.g. review-request UUIDs) shortened to head…tail for readability.
function truncateId(id: string) {
  return id.length > 20 ? `${id.slice(0, 8)}…${id.slice(-7)}` : id;
}

interface ParsedNote {
  action?: { label: string; rejected: boolean };
  restoredFrom?: number;
  requestId?: string;
  note?: string;
}

// Split a changeNote like "Approved review request <uuid>" into a labelled
// action + the bare request id so each can render on its own line. A
// "Restored from version N" note is surfaced as its own labelled marker so
// the row reads as a restore of version N, not just another edit.
function parseChangeNote(changeNote?: string): ParsedNote {
  if (!changeNote) return {};
  const restore = changeNote.match(/^Restored from version\s+(\d+)/i);
  if (restore) {
    return { restoredFrom: Number(restore[1]) };
  }
  const m = changeNote.match(/^(Approved|Rejected)\s+review\s+request\s+(\S+)/i);
  if (m) {
    const rejected = m[1].toLowerCase() === "rejected";
    return {
      action: { label: rejected ? "Review Rejected" : "Review Approved", rejected },
      requestId: m[2],
    };
  }
  return { note: changeNote };
}

export function VersionHistory({
  versions,
  currentVersion,
  approvedVersion,
  loading = false,
  onRestore,
  previewAs = "markdown",
  onView,
  onLoadContent,
  className,
}: VersionHistoryProps) {
  const [previewVersion, setPreviewVersion] = useState<Version | null>(null);
  const [restoreVersion, setRestoreVersion] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  // Default to this version's own change log — what changed in it, the way a
  // commit reads. Full body and vs-current each cost a server reconstruction,
  // so they load only when asked for.
  const [mode, setMode] = useState<PreviewMode>("changes");
  const [bodies, setBodies] = useState<Record<number, string | null>>({});
  // Requests in flight, so a re-render or a second click can't double-fetch.
  const inflight = React.useRef<Set<number>>(new Set());

  const ensureBody = React.useCallback(
    (versionNumber: number) => {
      if (!onLoadContent) return;
      if (versionNumber in bodies || inflight.current.has(versionNumber)) return;
      inflight.current.add(versionNumber);
      onLoadContent(versionNumber)
        .then((content) =>
          setBodies((b) => ({ ...b, [versionNumber]: content })),
        )
        .catch(() => setBodies((b) => ({ ...b, [versionNumber]: null })))
        .finally(() => inflight.current.delete(versionNumber));
    },
    [onLoadContent, bodies],
  );

  // A version already carrying its body (older callers pass content inline)
  // needs no fetch.
  const bodyOf = (v: Version): string | null | undefined =>
    v.content ?? bodies[v.version];

  const openPreview = (v: Version) => {
    setPreviewVersion(v);
    // No stored change log (v1, or a keyframe) — nothing to show but the body.
    if (v.diff) {
      setMode("changes");
    } else {
      setMode("content");
      ensureBody(v.version);
    }
  };

  const showMode = (next: PreviewMode) => {
    setMode(next);
    if (!previewVersion) return;
    if (next === "content") ensureBody(previewVersion.version);
    if (next === "vs-current") {
      ensureBody(previewVersion.version);
      ensureBody(currentVersion);
    }
  };

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
  const currentEntry = versions.find((v) => v.version === currentVersion);
  const currentContent = currentEntry
    ? (currentEntry.content ?? bodies[currentVersion])
    : undefined;
  // Restore writes a new version, which the server rejects with 423 while a
  // review is open. Disable the restore affordances so the user never hits
  // that error — they must resolve the review first.
  const restoreLocked = currentVersionStatus === "pending_review";
  const statusBadgeColor =
    currentVersionStatus === "approved" || currentVersionStatus === "published"
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
              className={`text-[10px] capitalize ${statusBadgeColor}`}
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
        {previewVersion ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2"
                onClick={() => {
                  setPreviewVersion(null);
                  setMode("changes");
                }}
              >
                <ArrowLeft className="h-4 w-4 mr-1" /> Back
              </Button>
              <div className="flex items-center gap-1">
                {onView && previewVersion.version !== currentVersion && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7"
                    title="Render this version in the viewer"
                    onClick={() => onView(previewVersion.version)}
                  >
                    <Eye className="h-4 w-4 mr-1" /> View rendered
                  </Button>
                )}
                {previewVersion.diff && (
                  <Button
                    variant={mode === "changes" ? "secondary" : "outline"}
                    size="sm"
                    className="h-7"
                    onClick={() => showMode("changes")}
                  >
                    Changes
                  </Button>
                )}
                <Button
                  variant={mode === "content" ? "secondary" : "outline"}
                  size="sm"
                  className="h-7"
                  onClick={() => showMode("content")}
                >
                  Full content
                </Button>
                {previewVersion.version !== currentVersion && (
                  <Button
                    variant={mode === "vs-current" ? "secondary" : "outline"}
                    size="sm"
                    className="h-7"
                    onClick={() => showMode("vs-current")}
                  >
                    vs current
                  </Button>
                )}
                {onRestore && previewVersion.version !== currentVersion && (
                  <Button
                    size="sm"
                    className="h-7"
                    disabled={restoreLocked}
                    title={
                      restoreLocked
                        ? "Locked while awaiting steward review — resolve the review first"
                        : undefined
                    }
                    onClick={() => {
                      setRestoreVersion(previewVersion.version);
                      setPreviewVersion(null);
                    }}
                  >
                    <RotateCcw className="h-4 w-4 mr-1" />
                    {restoreLocked ? "Locked — review pending" : "Restore"}
                  </Button>
                )}
              </div>
            </div>
            <div>
              <div className="text-sm font-semibold flex items-center gap-2">
                Version {previewVersion.version}
                {previewVersion.version === approvedVersion && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-green-700">
                    <CheckCircle2 className="h-3 w-3" /> AI-active
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {formatDate(previewVersion.editedAt)} · {previewVersion.editedBy}
                {previewVersion.changeNote && ` · ${previewVersion.changeNote}`}
              </div>
            </div>
            <ScrollArea className="h-[60vh] max-h-[440px] pr-2">
              {(() => {
                const body = bodyOf(previewVersion);
                const waiting = body === undefined;

                // This version's own change log — stored by the engine, so it
                // renders with no reconstruction and no client-side diffing.
                if (mode === "changes" && previewVersion.diff) {
                  return (
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground px-1">
                        Changes in v{previewVersion.version} (from v
                        {previewVersion.version - 1})
                      </div>
                      <DiffViewer patch={previewVersion.diff} className="max-h-none" />
                    </div>
                  );
                }

                if (mode === "vs-current") {
                  if (waiting || currentContent === undefined) {
                    return (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                      </div>
                    );
                  }
                  if (body === null || currentContent === null) {
                    return (
                      <div className="text-sm text-muted-foreground p-4">
                        (no content)
                      </div>
                    );
                  }
                  return (
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground px-1">
                        Diff: v{previewVersion.version} → current (v{currentVersion})
                      </div>
                      <DiffViewer
                        patch={unifiedDiff(body, currentContent)}
                        className="max-h-none"
                      />
                    </div>
                  );
                }

                if (waiting) {
                  return (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                    </div>
                  );
                }
                if (body && previewAs === "source") {
                  return (
                    <pre className="whitespace-pre-wrap break-words bg-muted/30 rounded px-4 py-3 text-xs font-mono leading-relaxed">
                      {body}
                    </pre>
                  );
                }
                if (body) {
                  return (
                    <DocumentViewer
                      content={body}
                      className="min-h-0 max-h-none overflow-visible bg-muted/30 rounded px-4 py-3"
                    />
                  );
                }
                return (
                  <div className="text-sm text-muted-foreground p-4">
                    (no content)
                  </div>
                );
              })()}
            </ScrollArea>
          </div>
        ) : versions.length === 0 ? (
          <div className="text-center py-4 text-sm text-muted-foreground">
            No version history
          </div>
        ) : (
          <ScrollArea className="h-[60vh] max-h-[480px] pr-2">
            <div className="space-y-1">
              {versions.map((version) => {
                const isApproved = version.version === approvedVersion;
                const parsed = parseChangeNote(version.changeNote);
                return (
                  <div
                    key={version.version}
                    role="button"
                    tabIndex={0}
                    onClick={() => openPreview(version)}
                    className={`flex items-center justify-between p-2 rounded hover:bg-muted/50 cursor-pointer group ${
                      isApproved ? "bg-green-50 border border-green-200" : ""
                    }`}
                  >
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <div className="text-sm font-medium flex items-center gap-2">
                        Version {version.version}
                        {parsed.restoredFrom !== undefined && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-blue-700">
                            <RotateCcw className="h-3 w-3" /> Restored from v
                            {parsed.restoredFrom}
                          </span>
                        )}
                        {isApproved && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-green-700">
                            <CheckCircle2 className="h-3 w-3" /> AI-active
                          </span>
                        )}
                      </div>
                      {parsed.action && (
                        <div
                          className={`text-xs font-medium flex items-center gap-1 ${
                            parsed.action.rejected
                              ? "text-red-700"
                              : "text-green-700"
                          }`}
                        >
                          {parsed.action.rejected ? (
                            <XCircle className="h-3 w-3" />
                          ) : (
                            <CheckCircle2 className="h-3 w-3" />
                          )}
                          {parsed.action.label}
                        </div>
                      )}
                      {parsed.note && (
                        <div className="text-xs text-foreground/80 break-words">
                          {parsed.note}
                        </div>
                      )}
                      <div className="text-xs text-muted-foreground break-words">
                        By:{" "}
                        <span className="font-medium text-foreground/80">
                          {version.editedBy}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatDate(version.editedAt)}
                      </div>
                      {version.resolvedBy && (
                        <div className="text-xs text-muted-foreground break-words">
                          {version.resolutionStatus === "rejected"
                            ? "Rejected by"
                            : "Approved by"}
                          :{" "}
                          <span className="font-medium text-foreground/80">
                            {version.resolvedBy}
                          </span>
                        </div>
                      )}
                      {parsed.requestId && (
                        <div className="text-xs text-muted-foreground font-mono">
                          Review Request: {truncateId(parsed.requestId)}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {onRestore && version.version !== currentVersion && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                          disabled={restoreLocked}
                          title={
                            restoreLocked
                              ? "Locked while awaiting steward review — resolve the review first"
                              : "Restore this version"
                          }
                          onClick={(e) => {
                            e.stopPropagation();
                            setRestoreVersion(version.version);
                          }}
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>

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
