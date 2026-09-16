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
import { useQueryClient } from "@tanstack/react-query";
import { reads } from "../lib/queries";
import type { AnnotationThread } from "../lib/api";
import { extractText, buildAnchor } from "../lib/artifact-text";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
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
  ArrowLeft, Loader2, MessageSquare, MessageSquarePlus, ExternalLink, RefreshCw,
  Eye, Highlighter, Check, RotateCcw, Send, History, Code2, X, FileText,
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
  /** Scroll this comment thread into view once threads load (activity-feed /
   *  ?thread= deep link). */
  initialThreadId?: string;
  onBack: () => void;
  /** The artifact was turned back into a markdown document — the host page
   *  re-reads the node and renders the editor instead. */
  onTurnedInto?: () => void;
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
  initialThreadId,
  onBack,
  onTurnedInto,
}: ArtifactViewerProps) {
  const [mode, setMode] = useState<"preview" | "annotate" | "edit">("preview");
  // The annotations rail, like the document page's comments rail: closed by
  // default, opened by its top-bar toggle, by a ?thread deep link, or by
  // switching to Annotate (which exists to write one).
  const [commentsOpen, setCommentsOpen] = useState(!!initialThreadId);
  useEffect(() => {
    if (mode === "annotate") setCommentsOpen(true);
  }, [mode]);
  // "Turn into document" — the reverse of DocumentEditor's Turn into… The
  // HTML body is kept; the markdown editor shows it as source to rework.
  const [confirmTurnInto, setConfirmTurnInto] = useState(false);
  const [turningInto, setTurningInto] = useState(false);
  const turnIntoDocument = async () => {
    setTurningInto(true);
    try {
      await api.updateNode(nestId, nodeId, { type: "document" });
      toast.success("Turned into a document");
      setConfirmTurnInto(false);
      onTurnedInto?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to convert");
    } finally {
      setTurningInto(false);
    }
  };
  const qc = useQueryClient();
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
  const editDirty = nodeMeta != null && editDraft !== nodeMeta.content;
  // Restore also writes a new version, so the same pending_review lock
  // applies — the banner's "Restore this version" must gate like the history
  // modal's button (VersionHistory's restoreLocked). Derived from whichever
  // signal is loaded: the fetched node (edit mode), or the versions list's
  // current row — always present when a version is pinned, since pinning
  // goes through the history modal.
  const restoreLocked =
    isLocked ||
    (versionData != null &&
      versionData.versions.find(
        (v) => v.version === versionData.currentVersion,
      )?.status === "pending_review");

  // Pending new-comment composition.
  const [selection, setSelection] = useState<
    { start: number; end: number; quote: string } | null
  >(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");

  const preRef = useRef<HTMLPreElement | null>(null);
  // A pinned historical version wins over the served snapshot. `iframeKey`
  // doubles as a cache-buster: it bumps on every save/reload/restore, so the
  // remounted iframe refetches instead of showing the browser's cached copy of
  // the same URL (the served body changes under the same URL after a save).
  const hostedUrl = api.hostedArtifactUrl(
    nestId,
    nodeId,
    viewingVersion ?? snapshot,
    iframeKey,
  );

  const loadVersions = useCallback(async () => {
    try {
      setVersionData(await qc.fetchQuery(reads.nodeVersions(nestId, nodeId)));
    } catch (e: any) {
      setVersionData(null);
      toast.error(e?.message || "Failed to load version history");
    }
  }, [nestId, nodeId]);

  // Leaving Edit source with unsaved changes prompts first, then drops the
  // draft so the confirm is honest (native confirm matches the app's other
  // destructive prompts). Guards Back, the mode toggle, history, and "View
  // rendered".
  const guardEditLeave = useCallback(
    (leave: () => void) => {
      if (mode === "edit" && editDirty) {
        if (!window.confirm("Discard unsaved source changes?")) return;
        if (nodeMeta) setEditDraft(nodeMeta.content);
      }
      leave();
    },
    [mode, editDirty, nodeMeta],
  );

  // Opening history from Edit mode must clear the unsaved-source guard first:
  // a restore fired from the modal nulls nodeMeta, and if mode were still
  // "edit" the source pane would strand on stale draft with Save wedged off.
  const openVersions = useCallback(() => {
    guardEditLeave(() => {
      setShowVersions(true);
      void loadVersions();
    });
  }, [guardEditLeave, loadVersions]);

  // Warn on tab close / reload while an unsaved source draft exists.
  useEffect(() => {
    if (!editDirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [editDirty]);

  // Pin a historical version into the iframe, read-only.
  const viewVersion = useCallback(
    (v: number) => {
      guardEditLeave(() => {
        setShowVersions(false);
        setViewingVersion(v);
        setMode("preview");
        setIframeKey((k) => k + 1);
      });
    },
    [guardEditLeave],
  );

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
      setShowVersions(false);
      // A restore can fire from the history modal while the source editor is
      // open; drop to preview so the edit pane can't linger over the now-null
      // node body (Save would wedge off and the textarea show stale draft).
      setMode("preview");
      // Serve the server's current default again and drop caches that now
      // describe the pre-restore body.
      setSnapshot(null);
      setExtractedText("");
      setNodeMeta(null);
      setEditDraft("");
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
      const { node } = await qc.fetchQuery(reads.node(nestId, nodeId));
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

  // Cancel is an exit like any other — prompt on unsaved changes so it matches
  // Back / the mode toggle rather than silently discarding.
  const cancelEdit = useCallback(() => {
    guardEditLeave(() => setMode("preview"));
  }, [guardEditLeave]);

  const loadThreads = useCallback(async () => {
    setLoadingThreads(true);
    try {
      const { threads } = await qc.fetchQuery(reads.nodeAnnotations(nestId, nodeId));
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

  // Feed deep-link: once threads load and the target exists, scroll its card
  // into view in the rail. Consumed once — later reloads (replies, resolves)
  // must not re-yank the scroll position.
  const initialThreadConsumedRef = useRef(false);
  useEffect(() => {
    if (!initialThreadId || initialThreadConsumedRef.current || loadingThreads) {
      return;
    }
    if (!threads.some((t) => t.id === initialThreadId)) return;
    initialThreadConsumedRef.current = true;
    requestAnimationFrame(() => {
      document
        .getElementById(`annotation-thread-${initialThreadId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, [threads, loadingThreads, initialThreadId]);

  // Lazily fetch + extract the artifact text the first time the user enters
  // Annotate mode (also feeds the snapshot badge if the prop was unknown).
  const ensureText = useCallback(async () => {
    if (extractedText || textLoading) return;
    setTextLoading(true);
    try {
      const { html, snapshot: served } = await api.fetchArtifactHtml(
        nestId, nodeId, snapshot, iframeKey,
      );
      setExtractedText(extractText(html));
      if (served != null) setSnapshot(served);
    } catch (e: any) {
      toast.error(e?.message || "Failed to load artifact text");
    } finally {
      setTextLoading(false);
    }
  }, [extractedText, textLoading, nestId, nodeId, snapshot, iframeKey]);

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
    <div className="flex min-h-full flex-col">
      {/* Top bar — the same sticky h-12 bar the document page has. */}
      <div className="sticky top-0 z-30 flex h-12 items-center justify-between gap-3 border-b bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-3">
        <div className="flex items-center gap-2 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => guardEditLeave(onBack)}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-sm font-medium truncate">{title || nodeId}</h1>
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
              onClick={() => guardEditLeave(() => setMode("preview"))}
            >
              <Eye className="h-4 w-4" /> Preview
            </button>
            <button
              type="button"
              className={cn(
                "px-3 h-full inline-flex items-center gap-1.5 text-sm disabled:opacity-50",
                !canEdit && "rounded-r-md",
                mode === "annotate" ? "bg-muted" : "hover:bg-muted/50",
              )}
              disabled={viewingVersion != null}
              title={
                viewingVersion != null
                  ? "Return to the current version to annotate"
                  : undefined
              }
              onClick={() => guardEditLeave(() => setMode("annotate"))}
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
          {!viewOnly && !reviewerOnly && onTurnedInto && (
            <Button
              variant="outline"
              size="icon"
              title={editDirty ? "Save or discard the source edits first" : "Turn into a document"}
              disabled={editDirty}
              onClick={() => setConfirmTurnInto(true)}
              data-testid="artifact-turn-into-document"
            >
              <FileText className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant={commentsOpen ? "secondary" : "outline"}
            size="icon"
            title={commentsOpen ? "Hide annotations" : "Show annotations"}
            aria-pressed={commentsOpen}
            onClick={() => setCommentsOpen((o) => !o)}
            data-testid="artifact-comments-toggle"
            className="relative"
          >
            <MessageSquare className="h-4 w-4" />
            {openThreads.length > 0 && (
              <span className="absolute -right-1 -top-1 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
                {openThreads.length}
              </span>
            )}
          </Button>
          <a href={hostedUrl} target="_blank" rel="noopener noreferrer">
            <Button variant="outline" size="icon" title="Open in new tab">
              <ExternalLink className="h-4 w-4" />
            </Button>
          </a>
        </div>
      </div>

      {/* Body: the artifact in a padded column, the annotations rail beside it
          when open — the document page's layout. */}
      <div className="flex flex-1 flex-col items-stretch lg:flex-row lg:items-start">
        {/* Artifact pane */}
        <div className="flex min-w-0 flex-1 flex-col px-5 py-6 sm:px-10 sm:py-8 min-h-[calc(100vh-7rem)]">
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
                    disabled={restoreLocked}
                    title={
                      restoreLocked
                        ? "Locked while awaiting steward review — resolve the review first"
                        : undefined
                    }
                    onClick={() => setConfirmRestore(viewingVersion)}
                  >
                    <RotateCcw className="h-3 w-3 mr-1" />
                    {restoreLocked
                      ? "Locked — review pending"
                      : "Restore this version"}
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
            <div className="flex-1 flex flex-col">
              <div className="mb-3 text-xs text-muted-foreground">
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
                    className="flex-1 w-full min-h-[60vh] rounded-lg border bg-background p-4 font-mono text-sm leading-relaxed resize-y shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <div className="sticky bottom-0 z-20 mt-auto -mx-5 flex items-center justify-between gap-2 border-t bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-10">
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
              className="w-full flex-1 min-h-[70vh] rounded-lg border bg-white"
            />
          ) : (
            <div className="flex-1 flex flex-col min-h-[70vh] rounded-lg border bg-background">
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

        {/* Annotations rail — beside the artifact, the document page's rail
            shape; hidden (not unmounted) when closed so threads stay loaded. */}
        <aside
          className={`w-full shrink-0 border-t lg:w-80 lg:border-t-0 lg:border-l lg:sticky lg:top-12 lg:self-start lg:max-h-[calc(100vh-3rem)] flex flex-col min-h-0 max-h-[70vh]${commentsOpen ? "" : " hidden"}`}
          data-testid="artifact-comments-rail"
          aria-hidden={!commentsOpen}
        >
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
        </aside>
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
          onLoadContent={async (v) =>
            (await api.getNodeVersionContent(nestId, nodeId, v)).content
          }
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
      <Dialog open={confirmTurnInto} onOpenChange={(o) => { if (!turningInto) setConfirmTurnInto(o); }}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Turn into a document?</DialogTitle>
            <DialogDescription>
              The HTML stays as the body, opened in the markdown editor's source
              view for you to rework. It stops being hosted as a page until it
              is turned back into an artifact.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmTurnInto(false)} disabled={turningInto}>
              Cancel
            </Button>
            <Button onClick={() => void turnIntoDocument()} disabled={turningInto} data-testid="artifact-turn-into-confirm">
              {turningInto ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Turn into document
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
      id={`annotation-thread-${thread.id}`}
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
