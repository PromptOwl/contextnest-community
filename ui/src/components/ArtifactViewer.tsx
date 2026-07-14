/**
 * ArtifactViewer — renders a hosted HTML artifact (slide deck / dashboard /
 * infographic) in a sandboxed iframe and lets reviewers annotate it.
 *
 * The loop this closes: an agent emits a rich HTML artifact → a human
 * highlights text and leaves anchored comments → those threads project into a
 * derived markdown node the nest already pulls → the next iteration reads the
 * feedback.
 *
 * Two isolation layers guard the untrusted HTML:
 *   1. the iframe `sandbox` attribute WITHOUT `allow-same-origin` (opaque
 *      origin — no access to host cookies/storage/session), and
 *   2. the server's strict `Content-Security-Policy: sandbox …` header.
 *
 * Because the iframe is opaque-origin, the parent can't read selections inside
 * it. Annotations are therefore made in a separate "Annotate" pane over the
 * artifact's *extracted text* (the same text the nest indexes), per the W3C
 * TextQuote anchor model.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import type { AnnotationThread } from "../lib/api";
import { extractText, buildAnchor } from "../lib/artifact-text";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { VersionHistoryModal, type VersionHistoryData } from "./governance";
import {
  ArrowLeft, Loader2, MessageSquarePlus, ExternalLink, RefreshCw,
  Eye, Highlighter, Check, RotateCcw, Send, History, Code2, X,
} from "lucide-react";
import { toast } from "sonner";

/** The node kind this viewer handles (mirrors server ARTIFACT_NODE_TYPE). */
export const ARTIFACT_NODE_TYPE = "artifact";

interface ArtifactViewerProps {
  nestId: string;
  nodeId: string;
  title: string;
  /** The approved/served snapshot version, if known (for the badge). */
  snapshotVersion?: number | null;
  currentEmail?: string;
  /**
   * Caller has no write access (mirrors DocumentEditor's isViewOnly).
   * Hides restore and source editing; history stays readable.
   */
  viewOnly?: boolean;
  /**
   * Reviewer-scoped steward without editor rights (DocumentEditor's
   * isReviewerOnly). May restore (a governance action the server gates)
   * but not free-edit the source — same split DocumentEditor applies.
   */
  reviewerOnly?: boolean;
  onBack: () => void;
}

function fmtTime(s: string): string {
  // Server stores `YYYY-MM-DD HH:MM:SS` (UTC). Render compactly.
  return s?.replace("T", " ").replace(/\.\d+Z?$/, "").slice(0, 16) || s;
}

export function ArtifactViewer({
  nestId,
  nodeId,
  title,
  snapshotVersion,
  currentEmail,
  viewOnly = false,
  reviewerOnly = false,
  onBack,
}: ArtifactViewerProps) {
  const [mode, setMode] = useState<"preview" | "annotate" | "edit">("preview");
  const [threads, setThreads] = useState<AnnotationThread[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [extractedText, setExtractedText] = useState<string>("");
  const [textLoading, setTextLoading] = useState(false);
  const [snapshot, setSnapshot] = useState<number | null>(snapshotVersion ?? null);
  const [iframeKey, setIframeKey] = useState(0);

  // ── Version history (CU-wdqcpzw3u5) ────────────────────────────────────
  // The server versions every artifact save like any node; this surfaces it.
  const [showVersions, setShowVersions] = useState(false);
  const [versionData, setVersionData] = useState<VersionHistoryData | null>(null);
  // Historical version pinned into the iframe (?v=N), read-only. null = live.
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  // Banner "Restore this version" confirm (the history modal has its own).
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);

  // ── Source editing ──────────────────────────────────────────────────────
  // Node body + version loaded lazily on first entering Edit mode. Saving
  // goes through the normal PATCH path, so governance/review still applies.
  const [nodeMeta, setNodeMeta] = useState<{
    content: string;
    version?: number;
    status: string | null;
  } | null>(null);
  const [nodeLoading, setNodeLoading] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [savingSource, setSavingSource] = useState(false);

  const canRestore = !viewOnly;
  const canEdit = !viewOnly && !reviewerOnly;
  // Pending review locks writes server-side (423) — mirror DocumentEditor
  // and disable the affordances instead of letting the user hit the error.
  const isLocked = nodeMeta?.status === "pending_review";

  // Pending new-comment composition.
  const [selection, setSelection] = useState<
    { start: number; end: number; quote: string } | null
  >(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");

  const preRef = useRef<HTMLPreElement | null>(null);
  // A pinned historical version wins over the served snapshot.
  const hostedUrl = api.hostedArtifactUrl(
    nestId,
    nodeId,
    viewingVersion ?? snapshot,
  );

  const loadVersions = useCallback(async () => {
    try {
      setVersionData(await api.getNodeVersions(nestId, nodeId));
    } catch (e: any) {
      setVersionData(null);
      toast.error(e?.message || "Failed to load version history");
    }
  }, [nestId, nodeId]);

  const openVersions = useCallback(() => {
    setShowVersions(true);
    void loadVersions();
  }, [loadVersions]);

  // Pin a historical version into the iframe, read-only.
  const viewVersion = useCallback((v: number) => {
    setShowVersions(false);
    setViewingVersion(v);
    setMode("preview");
    setIframeKey((k) => k + 1);
  }, []);

  const exitVersionView = useCallback(() => {
    setViewingVersion(null);
    setIframeKey((k) => k + 1);
  }, []);

  // Restore = the same server path DocumentEditor uses: /revert writes the
  // old body as a NEW version ("Restored from version N") through the normal
  // node update, so stewardship/review still applies.
  const performRestore = useCallback(
    async (v: number) => {
      await api.revertToVersion(nestId, nodeId, v);
      toast.success(`Restored from version ${v}`);
      setViewingVersion(null);
      // Serve the server's current default again and drop caches that now
      // describe the pre-restore body.
      setSnapshot(null);
      setExtractedText("");
      setNodeMeta(null);
      setIframeKey((k) => k + 1);
      await loadVersions();
    },
    [nestId, nodeId, loadVersions],
  );

  // Banner restore ("Restore this version" while previewing) — confirmed via
  // the dialog below; the history modal's restore has its own confirm.
  const confirmBannerRestore = useCallback(async () => {
    if (confirmRestore == null) return;
    setRestoring(true);
    try {
      await performRestore(confirmRestore);
      setConfirmRestore(null);
    } catch (e: any) {
      toast.error(e?.message || "Restore failed");
    } finally {
      setRestoring(false);
    }
  }, [confirmRestore, performRestore]);

  // Enter source-edit mode; fetch the node body on first entry (a later
  // re-entry keeps the in-progress draft).
  const enterEdit = useCallback(async () => {
    setViewingVersion(null);
    setMode("edit");
    if (nodeMeta || nodeLoading) return;
    setNodeLoading(true);
    try {
      const { node } = await api.getNode(nestId, nodeId);
      const content = node?.content == null ? "" : String(node.content);
      setNodeMeta({
        content,
        version: node?.version,
        status: node?.status ?? null,
      });
      setEditDraft(content);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load artifact source");
      setMode("preview");
    } finally {
      setNodeLoading(false);
    }
  }, [nodeMeta, nodeLoading, nestId, nodeId]);

  const editDirty = nodeMeta != null && editDraft !== nodeMeta.content;

  // Save through the normal node-update path (same call DocumentEditor makes)
  // so versioning + governance behave exactly like a markdown edit.
  const saveSource = useCallback(async () => {
    if (!nodeMeta || !editDirty || savingSource) return;
    setSavingSource(true);
    try {
      const res: any = await api.updateNode(
        nestId,
        nodeId,
        { content: editDraft },
        nodeMeta.version,
      );
      const nextVersion = res?.version ?? res?.node?.version;
      setNodeMeta({
        content: editDraft,
        version: typeof nextVersion === "number" ? nextVersion : nodeMeta.version,
        status: res?.node?.status ?? nodeMeta.status,
      });
      // Refresh the render + drop the stale extracted text; the served
      // snapshot may lag behind under stewardship (until approved) — that is
      // the governance path working, not a bug.
      setSnapshot(null);
      setExtractedText("");
      setIframeKey((k) => k + 1);
      setMode("preview");
      toast.success(
        typeof nextVersion === "number"
          ? `Saved as version ${nextVersion}`
          : "Artifact saved",
      );
    } catch (e: any) {
      toast.error(e?.message || "Save failed");
    } finally {
      setSavingSource(false);
    }
  }, [nodeMeta, editDirty, savingSource, nestId, nodeId, editDraft]);

  const cancelEdit = useCallback(() => {
    if (nodeMeta) setEditDraft(nodeMeta.content);
    setMode("preview");
  }, [nodeMeta]);

  const loadThreads = useCallback(async () => {
    setLoadingThreads(true);
    try {
      const { threads } = await api.listAnnotations(nestId, nodeId);
      setThreads(threads);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load annotations");
    } finally {
      setLoadingThreads(false);
    }
  }, [nestId, nodeId]);

  useEffect(() => {
    loadThreads();
  }, [loadThreads]);

  // Lazily fetch + extract the artifact text the first time the user enters
  // Annotate mode (also feeds the snapshot badge if the prop was unknown).
  const ensureText = useCallback(async () => {
    if (extractedText || textLoading) return;
    setTextLoading(true);
    try {
      const { html, snapshot: served } = await api.fetchArtifactHtml(
        nestId, nodeId, snapshot,
      );
      setExtractedText(extractText(html));
      if (served != null) setSnapshot(served);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load artifact text");
    } finally {
      setTextLoading(false);
    }
  }, [extractedText, textLoading, nestId, nodeId, snapshot]);

  useEffect(() => {
    if (mode === "annotate") void ensureText();
  }, [mode, ensureText]);

  // Capture a selection inside the extracted-text panel. The panel renders the
  // text as a single text node, so range offsets index directly into it.
  const onTextMouseUp = useCallback(() => {
    const sel = window.getSelection();
    const pre = preRef.current;
    if (!sel || sel.isCollapsed || !pre) {
      setSelection(null);
      return;
    }
    const range = sel.getRangeAt(0);
    if (!pre.contains(range.startContainer) || !pre.contains(range.endContainer)) {
      return;
    }
    const start = Math.min(range.startOffset, range.endOffset);
    const end = Math.max(range.startOffset, range.endOffset);
    const quote = extractedText.slice(start, end).trim();
    if (!quote) {
      setSelection(null);
      return;
    }
    setSelection({ start, end, quote });
  }, [extractedText]);

  const submitThread = useCallback(async () => {
    const body = draft.trim();
    if (!body) return;
    setPosting(true);
    try {
      const anchor =
        selection != null
          ? buildAnchor(extractedText, selection.start, selection.end)
          : null;
      await api.createAnnotation(nestId, nodeId, {
        body,
        anchor,
        snapshotVersion: snapshot,
      });
      setDraft("");
      setSelection(null);
      window.getSelection?.()?.removeAllRanges();
      await loadThreads();
      toast.success("Comment added");
    } catch (e: any) {
      toast.error(e?.message || "Failed to add comment");
    } finally {
      setPosting(false);
    }
  }, [draft, selection, extractedText, nestId, nodeId, snapshot, loadThreads]);

  const submitReply = useCallback(
    async (threadId: string) => {
      const body = replyBody.trim();
      if (!body) return;
      try {
        await api.replyAnnotation(nestId, nodeId, threadId, body);
        setReplyBody("");
        setReplyFor(null);
        await loadThreads();
      } catch (e: any) {
        toast.error(e?.message || "Failed to reply");
      }
    },
    [replyBody, nestId, nodeId, loadThreads],
  );

  const toggleResolved = useCallback(
    async (t: AnnotationThread) => {
      try {
        if (t.status === "open") {
          await api.resolveAnnotation(nestId, nodeId, t.id);
        } else {
          await api.reopenAnnotation(nestId, nodeId, t.id);
        }
        await loadThreads();
      } catch (e: any) {
        toast.error(e?.message || "Failed to update thread");
      }
    },
    [nestId, nodeId, loadThreads],
  );

  const { openThreads, resolvedThreads } = useMemo(() => {
    const open = threads.filter((t) => t.status === "open");
    const resolved = threads.filter((t) => t.status === "resolved");
    return { openThreads: open, resolvedThreads: resolved };
  }, [threads]);

  return (
    <div className="md:py-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 min-w-0">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-xl font-semibold truncate">{title || nodeId}</h1>
          <Badge variant="secondary" className="shrink-0 gap-1">
            Artifact
          </Badge>
          {viewingVersion != null ? (
            <Badge
              variant="outline"
              className="shrink-0 border-amber-300 bg-amber-50 text-amber-800"
              title="Read-only view of a historical version."
            >
              Viewing v{viewingVersion}
            </Badge>
          ) : snapshot != null ? (
            <Badge
              variant="outline"
              className="shrink-0"
              title="Annotations are anchored to this frozen snapshot."
            >
              Snapshot v{snapshot}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center rounded-md border h-9">
            <button
              type="button"
              className={`px-3 h-full rounded-l-md inline-flex items-center gap-1.5 text-sm ${
                mode === "preview" ? "bg-muted" : "hover:bg-muted/50"
              }`}
              onClick={() => setMode("preview")}
            >
              <Eye className="h-4 w-4" /> Preview
            </button>
            <button
              type="button"
              className={`px-3 h-full inline-flex items-center gap-1.5 text-sm disabled:opacity-50 ${
                canEdit ? "" : "rounded-r-md "
              }${mode === "annotate" ? "bg-muted" : "hover:bg-muted/50"}`}
              disabled={viewingVersion != null}
              title={
                viewingVersion != null
                  ? "Return to the current version to annotate"
                  : undefined
              }
              onClick={() => setMode("annotate")}
            >
              <Highlighter className="h-4 w-4" /> Annotate
            </button>
            {canEdit && (
              <button
                type="button"
                className={`px-3 h-full rounded-r-md inline-flex items-center gap-1.5 text-sm ${
                  mode === "edit" ? "bg-muted" : "hover:bg-muted/50"
                }`}
                title="Edit the artifact's raw HTML source"
                onClick={() => void enterEdit()}
              >
                <Code2 className="h-4 w-4" /> Edit source
              </button>
            )}
          </div>
          <Button
            variant="outline"
            size="icon"
            title="Version history"
            onClick={openVersions}
          >
            <History className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            title="Reload artifact"
            onClick={() => setIframeKey((k) => k + 1)}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <a href={hostedUrl} target="_blank" rel="noopener noreferrer">
            <Button variant="outline" size="icon" title="Open in new tab">
              <ExternalLink className="h-4 w-4" />
            </Button>
          </a>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
        {/* Artifact pane */}
        <div className="border rounded-lg overflow-hidden bg-background min-h-[70vh] flex flex-col">
          {viewingVersion != null && (
            <div className="px-3 py-2 border-b bg-amber-50 text-xs text-amber-900 flex items-center justify-between gap-2 flex-wrap">
              <span>
                <span className="font-medium">
                  Viewing version {viewingVersion}
                </span>{" "}
                — read-only historical snapshot.
              </span>
              <span className="flex items-center gap-1.5">
                {canRestore && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs border-amber-300 text-amber-900 hover:bg-amber-100"
                    onClick={() => setConfirmRestore(viewingVersion)}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" /> Restore this version
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs text-amber-900 hover:bg-amber-100"
                  onClick={exitVersionView}
                >
                  <X className="h-3 w-3 mr-1" /> Back to current
                </Button>
              </span>
            </div>
          )}
          {mode === "edit" ? (
            <div className="flex-1 flex flex-col min-h-[70vh]">
              <div className="px-3 py-2 border-b bg-muted/30 text-xs text-muted-foreground">
                {isLocked
                  ? "Locked while awaiting steward review — resolve the review before editing."
                  : "Editing raw HTML source. Saving creates a new version, like any document edit."}
              </div>
              {nodeLoading ? (
                <div className="flex items-center justify-center flex-1 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading source…
                </div>
              ) : (
                <>
                  <textarea
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    readOnly={isLocked}
                    spellCheck={false}
                    placeholder="Paste the artifact's HTML (a self-contained slide deck, dashboard, infographic)…"
                    className="flex-1 w-full min-h-[50vh] bg-background p-3 font-mono text-xs leading-relaxed resize-none focus:outline-none"
                  />
                  <div className="px-3 py-2 border-t flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">
                      {nodeMeta?.version != null ? `Editing v${nodeMeta.version}` : ""}
                      {editDirty ? " · unsaved changes" : ""}
                    </span>
                    <span className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={cancelEdit}
                        disabled={savingSource}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void saveSource()}
                        disabled={
                          isLocked || savingSource || !editDirty || !editDraft.trim()
                        }
                        title={
                          isLocked
                            ? "Locked while awaiting steward review"
                            : undefined
                        }
                      >
                        {savingSource ? (
                          <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                        ) : (
                          <Check className="h-4 w-4 mr-1.5" />
                        )}
                        Save
                      </Button>
                    </span>
                  </div>
                </>
              )}
            </div>
          ) : mode === "preview" ? (
            <iframe
              key={iframeKey}
              src={hostedUrl}
              title={title || nodeId}
              // Defense-in-depth alongside the server's CSP `sandbox` header.
              // No `allow-same-origin` → opaque origin, no host cookie/storage.
              sandbox="allow-scripts allow-popups allow-modals"
              className="w-full flex-1 min-h-[70vh] bg-white"
            />
          ) : (
            <div className="flex-1 flex flex-col min-h-[70vh]">
              <div className="px-3 py-2 border-b bg-muted/30 text-xs text-muted-foreground">
                Select text below to anchor a comment to it. This is the
                artifact's extracted text — the same text the nest indexes.
              </div>
              {textLoading ? (
                <div className="flex items-center justify-center flex-1 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading text…
                </div>
              ) : (
                <pre
                  ref={preRef}
                  onMouseUp={onTextMouseUp}
                  className="flex-1 overflow-auto whitespace-pre-wrap break-words p-4 text-sm leading-relaxed font-sans selection:bg-amber-200"
                >
                  {extractedText || "(no extractable text)"}
                </pre>
              )}
            </div>
          )}
        </div>

        {/* Annotation sidebar */}
        <div className="border rounded-lg bg-background flex flex-col max-h-[78vh]">
          <div className="px-3 py-2 border-b flex items-center justify-between">
            <span className="text-sm font-medium">
              Annotations
              <span className="text-muted-foreground font-normal">
                {" "}· {openThreads.length} open
              </span>
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              title="Refresh"
              onClick={loadThreads}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Composer */}
          <div className="p-3 border-b space-y-2">
            {selection ? (
              <div className="text-xs rounded border-l-2 border-amber-400 bg-amber-50 px-2 py-1 text-amber-900">
                <span className="font-medium">Anchored to:</span>{" "}
                "{selection.quote.length > 80
                  ? selection.quote.slice(0, 80) + "…"
                  : selection.quote}"
                <button
                  type="button"
                  className="ml-2 underline text-amber-700"
                  onClick={() => {
                    setSelection(null);
                    window.getSelection?.()?.removeAllRanges();
                  }}
                >
                  clear
                </button>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                {mode === "annotate"
                  ? "No selection — this will be a whole-artifact comment."
                  : "Switch to Annotate to highlight text, or comment on the whole artifact below."}
              </div>
            )}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a comment…"
              rows={3}
              className="w-full text-sm rounded border px-2 py-1.5 resize-y focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <div className="flex justify-end">
              <Button size="sm" onClick={submitThread} disabled={posting || !draft.trim()}>
                {posting ? (
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                ) : (
                  <MessageSquarePlus className="h-4 w-4 mr-1.5" />
                )}
                Comment
              </Button>
            </div>
          </div>

          {/* Threads */}
          <div className="flex-1 overflow-auto p-3 space-y-3">
            {loadingThreads ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
              </div>
            ) : threads.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-8">
                No annotations yet. Highlight text and leave the first comment.
              </div>
            ) : (
              <>
                {openThreads.map((t) => (
                  <ThreadCard
                    key={t.id}
                    thread={t}
                    currentEmail={currentEmail}
                    replyOpen={replyFor === t.id}
                    replyBody={replyBody}
                    onReplyOpen={() => {
                      setReplyFor(t.id);
                      setReplyBody("");
                    }}
                    onReplyChange={setReplyBody}
                    onReplySubmit={() => submitReply(t.id)}
                    onToggleResolved={() => toggleResolved(t)}
                  />
                ))}
                {resolvedThreads.length > 0 && (
                  <div className="pt-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Resolved
                  </div>
                )}
                {resolvedThreads.map((t) => (
                  <ThreadCard
                    key={t.id}
                    thread={t}
                    currentEmail={currentEmail}
                    replyOpen={replyFor === t.id}
                    replyBody={replyBody}
                    onReplyOpen={() => {
                      setReplyFor(t.id);
                      setReplyBody("");
                    }}
                    onReplyChange={setReplyBody}
                    onReplySubmit={() => submitReply(t.id)}
                    onToggleResolved={() => toggleResolved(t)}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Version history — same modal DocumentEditor opens; artifact bodies
          preview as raw source (they're HTML, not markdown) and "View
          rendered" pins the version into the sandboxed iframe above. */}
      {showVersions && (
        <VersionHistoryModal
          open
          onClose={() => setShowVersions(false)}
          title={title || nodeId}
          versionData={versionData}
          previewAs="source"
          onView={viewVersion}
          onRestore={
            canRestore
              ? async (v) => {
                  try {
                    await performRestore(v);
                  } catch (e: any) {
                    toast.error(e?.message || "Restore failed");
                  }
                }
              : undefined
          }
        />
      )}

      {/* Confirm for the banner's "Restore this version" (the history modal
          carries its own confirm inside VersionHistory). */}
      <Dialog
        open={confirmRestore != null}
        onOpenChange={(o) => !o && setConfirmRestore(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Restore version {confirmRestore}?</DialogTitle>
            <DialogDescription>
              This writes version {confirmRestore}'s HTML as a new version
              through the normal save path — review rules still apply and the
              current content stays in history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmRestore(null)}
              disabled={restoring}
            >
              Cancel
            </Button>
            <Button onClick={() => void confirmBannerRestore()} disabled={restoring}>
              {restoring ? "Restoring…" : "Restore"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ThreadCardProps {
  thread: AnnotationThread;
  currentEmail?: string;
  replyOpen: boolean;
  replyBody: string;
  onReplyOpen: () => void;
  onReplyChange: (v: string) => void;
  onReplySubmit: () => void;
  onToggleResolved: () => void;
}

function ThreadCard({
  thread,
  replyOpen,
  replyBody,
  onReplyOpen,
  onReplyChange,
  onReplySubmit,
  onToggleResolved,
}: ThreadCardProps) {
  const resolved = thread.status === "resolved";
  return (
    <div
      className={`rounded-lg border p-2.5 text-sm ${
        resolved ? "bg-muted/40 opacity-80" : "bg-background"
      }`}
    >
      <div className="flex items-center justify-between mb-1.5">
        <Badge
          variant="outline"
          className={
            resolved
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-amber-200 bg-amber-50 text-amber-700"
          }
        >
          {resolved ? "Resolved" : "Open"}
        </Badge>
        <button
          type="button"
          className="text-xs inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          onClick={onToggleResolved}
          title={resolved ? "Reopen thread" : "Mark resolved"}
        >
          {resolved ? (
            <><RotateCcw className="h-3 w-3" /> Reopen</>
          ) : (
            <><Check className="h-3 w-3" /> Resolve</>
          )}
        </button>
      </div>

      {thread.anchor ? (
        <div className="mb-1.5 text-xs rounded border-l-2 border-amber-300 bg-amber-50/60 px-2 py-1 text-amber-900">
          "{thread.anchor.quote.length > 100
            ? thread.anchor.quote.slice(0, 100) + "…"
            : thread.anchor.quote}"
        </div>
      ) : (
        <div className="mb-1.5 text-xs text-muted-foreground italic">
          Whole-artifact comment
        </div>
      )}

      <ul className="space-y-1.5">
        {thread.comments.map((c) => (
          <li key={c.id}>
            <div className="flex items-baseline gap-2">
              <span className="font-medium text-xs">{c.author}</span>
              <span className="text-[10px] text-muted-foreground">
                {fmtTime(c.createdAt)}
              </span>
            </div>
            <div className="whitespace-pre-wrap break-words">{c.body}</div>
          </li>
        ))}
      </ul>

      {replyOpen ? (
        <div className="mt-2 space-y-1.5">
          <textarea
            value={replyBody}
            onChange={(e) => onReplyChange(e.target.value)}
            placeholder="Reply…"
            rows={2}
            className="w-full text-sm rounded border px-2 py-1 resize-y focus:outline-none focus:ring-1 focus:ring-primary"
            autoFocus
          />
          <div className="flex justify-end">
            <Button size="sm" onClick={onReplySubmit} disabled={!replyBody.trim()}>
              <Send className="h-3.5 w-3.5 mr-1.5" /> Reply
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="mt-1.5 text-xs text-primary hover:underline"
          onClick={onReplyOpen}
        >
          Reply
        </button>
      )}
    </div>
  );
}

export default ArtifactViewer;
