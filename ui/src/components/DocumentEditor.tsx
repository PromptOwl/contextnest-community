/**
 * DocumentEditor — full-page document create/edit view.
 *
 * Two modes driven by `nodeId`:
 *   - "new"   → empty title/tags/content. Save calls POST /nests/:id/nodes.
 *   - "<id>"  → loads existing via GET, populates fields. Save calls PATCH.
 *
 * Permission gating mirrors the nest list: server returns 403 if the
 * caller can't write — we surface that error and disable the form. We
 * don't attempt to pre-fetch the user's role from the client because the
 * server is the source of truth.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Loader2,
  Save,
  AlertCircle,
  Send,
  X,
  Pencil,
  ExternalLink,
} from "lucide-react";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "./MarkdownEditor";
import { DocumentViewer } from "./DocumentViewer";
import { SubmitForReviewModal, ReviewActions, ExternalEditBanner } from "./governance";
import type { PendingChange } from "../lib/api";
import { DocumentPickerModal } from "./DocumentPickerModal";
import { useAuth } from "../auth/AuthContext";

/** Treat content as HTML when it visibly starts with an HTML tag.
 *  Anything else (markdown, plain text, empty) goes through the
 *  markdown renderer. Markdown can legally contain inline HTML, but
 *  documents that start with `<` are overwhelmingly going to be the
 *  TipTap-saved kind. */
function looksLikeHtml(s: string): boolean {
  if (!s) return false;
  return /^\s*</.test(s);
}

/** Canonicalize HTML for dirty-tracking. Server-loaded markup and the
 *  HTML TipTap re-emits after a no-op edit cycle (type-then-delete)
 *  almost never match byte-for-byte — whitespace, attribute order,
 *  empty `<p>` collapsing. Parsing through DOMParser + serializing
 *  via innerHTML normalizes both sides so semantic equality compares
 *  as equal. */
function normalizeHtml(s: string): string {
  if (!s) return "";
  if (typeof DOMParser === "undefined") return s.trim();
  try {
    const doc = new DOMParser().parseFromString(s, "text/html");
    return (doc.body.innerHTML || "").replace(/\s+/g, " ").trim();
  } catch {
    return s.trim();
  }
}

interface DocumentEditorProps {
  nestId: string;
  nestName: string;
  nodeId: string | "new";
  /** Caller owns this nest. Enables the inline approve/reject affordance
   *  on owner-authored pending reviews — server allows owner self-approve
   *  (see canUserApprove in stewardship-service.ts, CU-86ahn99dg). */
  isOwner?: boolean;
  onBack: () => void;
  onSaved?: (savedNodeId: string) => void;
  /** Open a different document — invoked when the user clicks an
   *  internal `nest://` link inside the editor. */
  onNavigateDocument?: (nestId: string, nodeId: string) => void;
  /** Create a new document — invoked when the user clicks a
   *  `[[Title]]` that doesn't resolve to an existing doc.
   *  Obsidian / MediaWiki convention: broken link → create-with-title. */
  onCreateDocument?: (nestId: string, title: string) => void;
  /** When `nodeId === "new"` and this is set, pre-fill the title state.
   *  Used by the wikilink-create flow to land the user in an editor
   *  that's already started rather than fully blank. */
  initialTitle?: string;
}

export function DocumentEditor({
  nestId,
  nestName,
  nodeId,
  isOwner = false,
  onBack,
  onSaved,
  onNavigateDocument,
  onCreateDocument,
  initialTitle,
}: DocumentEditorProps) {
  const isNew = nodeId === "new";
  const { adminStatus } = useAuth();
  const currentEmail = adminStatus?.me?.email?.toLowerCase() ?? "";
  // Caller's resolved steward role for this node (null = none / not a steward).
  // Drives read-only gating + the inline reviewer affordance. We derive
  // the "can review here?" answer from this single source instead of
  // tracking a redundant boolean.
  const [myNodeRole, setMyNodeRole] = useState<string | null>(null);

  const [title, setTitle] = useState(isNew && initialTitle ? initialTitle : "");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [baseVersion, setBaseVersion] = useState<number | undefined>(undefined);
  const [status, setStatus] = useState<string | null>(null);
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  // Peek-modal state for wiki-link clicks. Clicking `[[Title]]` used to
  // navigate away from the editor, which silently discarded any unsaved
  // edits. Now we open a read-only preview in-place; "Open in editor"
  // is the explicit affordance for actually leaving the page. The
  // `loading` field is folded in so the modal can render a spinner
  // without a separate state hook tracking the same lifecycle.
  const [previewDoc, setPreviewDoc] = useState<{
    id: string;
    title: string;
    content: string;
    loading: boolean;
  } | null>(null);
  const [stewardshipEnabled, setStewardshipEnabled] = useState(false);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [showDocPicker, setShowDocPicker] = useState(false);
  // Per CU-86ahmvmex: existing docs open in view mode by default so the
  // user actually sees rendered markdown. New docs go straight to edit.
  // The user can flip via the toolbar button.
  const [mode, setMode] = useState<"view" | "edit">(isNew ? "edit" : "view");

  const editorRef = useRef<MarkdownEditorHandle | null>(null);

  // Snapshot of the last loaded/saved state. Drives `isDirty` so the
  // wiki-link nav paths know whether they need to persist the current
  // doc before unmounting the editor — without it, clicking through a
  // `[[link]]` silently discarded any pending edits.
  const initialSnapshotRef = useRef<{
    title: string;
    content: string;
    tags: string[];
  }>({
    title: isNew && initialTitle ? initialTitle : "",
    content: "",
    tags: [],
  });

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Explicit "user actually edited something" flag. Drives `isDirty`
  // instead of a raw state-vs-snapshot diff: TipTap normalizes loaded
  // HTML on mount (whitespace, attribute order), so the diff alone
  // flips dirty on every edit-mode toggle even when the user hasn't
  // typed a single character. Flipping this only on real input events
  // keeps the unsaved-changes prompt from firing on no-op opens.
  const [touched, setTouched] = useState(false);

  // Load existing doc + nest settings in parallel. Settings drive
  // whether the "Submit for Review" button surfaces.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await api
          .getNestSettings(nestId)
          .catch(() => ({ stewardship_enabled: false }));
        if (cancelled) return;
        setStewardshipEnabled(!!settings.stewardship_enabled);
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nestId]);

  // Resolve the caller's per-node steward role. Drives the inline
  // reviewer affordance, the reviewer/viewer read-only gating, and the
  // wiki-create block. Falls back to null on miss / failure so callers
  // can treat "no row" as "no special permissions".
  useEffect(() => {
    if (isNew || !nodeId || !currentEmail) {
      setMyNodeRole(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { stewards } = await api.getNodeStewards(nestId, nodeId);
        if (cancelled) return;
        const mine = (stewards as any[]).find(
          (s) => (s.email || "").toLowerCase() === currentEmail,
        );
        setMyNodeRole(mine?.role ?? null);
      } catch {
        if (!cancelled) setMyNodeRole(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isNew, nestId, nodeId, currentEmail]);

  const loadNode = useCallback(async () => {
    if (isNew) return;
    setLoading(true);
    try {
      const { node } = await api.getNode(nestId, nodeId);
      const loadedTitle = node?.title ?? "";
      const loadedContent = node?.content ?? "";
      const loadedTags = Array.isArray(node?.tags) ? node.tags : [];
      setTitle(loadedTitle);
      setContent(loadedContent);
      setTags(loadedTags);
      setBaseVersion(node?.version);
      setStatus(node?.status ?? null);
      setPendingChange((node as any)?.pendingChange ?? null);
      initialSnapshotRef.current = {
        title: loadedTitle,
        content: loadedContent,
        tags: loadedTags,
      };
      setTouched(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [isNew, nestId, nodeId]);

  useEffect(() => {
    if (isNew) return;
    loadNode();
  }, [isNew, loadNode]);

  // Lock the editor while a review is pending. The server would reject
  // edits via the steward workflow anyway, but locking client-side
  // avoids the user typing a long draft only to discover they couldn't
  // save it. Cancelling the review (future feature) would unlock here.
  const isLocked = status === "pending_review";

  // Fields (title, tags, content) are read-only outside of edit mode.
  // New docs default to edit, existing docs default to view — user must
  // explicitly opt-in via the "Start Editing" header button or a
  // double-click on the content area.
  const fieldsDisabled = isLocked || mode !== "edit";

  const canSave = useMemo(
    () =>
      !isLocked &&
      title.trim().length > 0 &&
      content.trim().length > 0 &&
      !saving,
    [isLocked, title, content, saving],
  );

  // Dirty only when the user has actually interacted with an input AND
  // the state diverges from the loaded/saved snapshot. The `touched`
  // gate avoids the spurious-dirty case where switching to edit mode
  // re-emits a normalized version of the same content without any
  // real change. The content comparison normalizes HTML on both sides
  // so a type-then-delete cycle reverts to "not dirty" — TipTap's
  // re-emitted markup wouldn't byte-match the server-loaded form
  // otherwise.
  const isDirty = useMemo(() => {
    if (!touched) return false;
    const snap = initialSnapshotRef.current;
    if (title.trim() !== snap.title.trim()) return true;
    if (normalizeHtml(content) !== normalizeHtml(snap.content)) return true;
    if (tags.length !== snap.tags.length) return true;
    for (let i = 0; i < tags.length; i++) {
      if (tags[i] !== snap.tags[i]) return true;
    }
    return false;
  }, [touched, title, content, tags]);

  const addTag = useCallback(() => {
    // Split on whitespace OR comma so users can paste "#one #two" or
    // "one, two" and get two tags. Strip every leading "#" — common
    // convention is hash-prefixed but the stored value is bare.
    const tokens = tagInput
      .split(/[\s,]+/)
      .map((t) => t.trim().replace(/^#+/, ""))
      .filter(Boolean);
    if (tokens.length === 0) return;
    const next = [...tags];
    for (const t of tokens) {
      if (!next.includes(t)) next.push(t);
    }
    setTags(next);
    setTagInput("");
    setTouched(true);
  }, [tagInput, tags]);

  const removeTag = (t: string) => {
    setTags(tags.filter((x) => x !== t));
    setTouched(true);
  };

  const persistCurrent = async (): Promise<{
    ok: boolean;
    savedId?: string;
  }> => {
    const payload = { title: title.trim(), content, tags };
    let savedId: string | undefined;
    if (isNew) {
      const res = await api.createNode(nestId, payload);
      savedId = (res as any)?.node?.id;
    } else {
      const res = await api.updateNode(nestId, nodeId, payload, baseVersion);
      // Server publishes through the engine which bumps the version
      // beyond what UI knew. Pick up the new number so the next save
      // sends a matching X-Base-Version and doesn't 409.
      const nextVersion =
        (res as any)?.version ?? (res as any)?.node?.version;
      if (typeof nextVersion === "number") setBaseVersion(nextVersion);
      savedId = nodeId;
    }
    initialSnapshotRef.current = {
      title: payload.title,
      content,
      tags: [...tags],
    };
    setTouched(false);
    return { ok: true, savedId };
  };

  // Pending navigation gated behind the unsaved-changes confirm. We
  // stash the user's intent and only run it after Save / Discard.
  const [leaveIntent, setLeaveIntent] = useState<{
    label: string;
    run: () => void;
  } | null>(null);

  // Single save path. `afterSave` is the optional continuation — used
  // by both the header Save button (→ onSaved) and the leave-confirm
  // dialog (→ run the stashed nav intent). Centralising the
  // saving/error/canSave plumbing keeps both flows in lockstep.
  const runSave = async (afterSave: (savedId: string) => void) => {
    if (!canSave) {
      setError(
        isNew
          ? "Add a title and content before saving."
          : "Current document can't be saved — fix errors before leaving.",
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { savedId } = await persistCurrent();
      afterSave(savedId ?? "");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => runSave((savedId) => onSaved?.(savedId));

  // Wraps every action that unmounts the editor (back, wiki-link nav,
  // broken-link create). If the doc is dirty we surface a confirm
  // dialog; otherwise the intent runs straight through. Read-only
  // sessions skip the prompt — the user couldn't have produced edits.
  const confirmLeave = (label: string, run: () => void) => {
    if (
      !isDirty ||
      isLocked ||
      myNodeRole === "reviewer" ||
      myNodeRole === "viewer"
    ) {
      run();
      return;
    }
    setLeaveIntent({ label, run });
  };

  const handleLeaveSave = () =>
    runSave(() => {
      const intent = leaveIntent?.run;
      setLeaveIntent(null);
      intent?.();
    });

  const handleLeaveDiscard = () => {
    if (!leaveIntent) return;
    const intent = leaveIntent.run;
    setLeaveIntent(null);
    intent();
  };

  const handleSubmitForReview = async (note: string, priority: string) => {
    if (isNew) return;
    await api.submitForReview(nestId, nodeId, note, priority);
    setShowSubmitModal(false);
    // Reload so status flips to pending_review and the button hides.
    await loadNode();
  };

  // Reviewer actions surfaced inline so an assigned steward doesn't need to
  // bounce back to the nest list to action the document they just opened.
  // Server enforces permission; we just expose the affordance when the doc
  // is awaiting review.
  const handleApprove = async (note?: string) => {
    if (isNew) return;
    await api.approveNode(nestId, nodeId, note);
    await loadNode();
  };
  const handleReject = async (note: string) => {
    if (isNew) return;
    await api.rejectNode(nestId, nodeId, note);
    await loadNode();
  };
  // Owner short-circuit mirrors server-side canUserApprove: nest owner can
  // approve any pending review, including their own submissions (the
  // seeding flow). Reviewer stewards still need a row to get the affordance.
  const canReviewHere =
    !isNew &&
    status === "pending_review" &&
    (myNodeRole === "reviewer" || isOwner);

  // Reviewers + viewers are read-only on the docs they govern — reviewers
  // approve/reject, viewers just read; neither authors content. Hide Save
  // + Submit-for-Review whenever the caller's resolved role on this node
  // is reviewer or viewer, regardless of status. Editors/owners (no
  // steward row or role === "editor") are unaffected.
  const isReviewerOnly =
    myNodeRole === "reviewer" || myNodeRole === "viewer";

  // Submit-for-Review only makes sense on an existing draft when the
  // nest has stewardship enabled. Pending/approved/rejected docs hide
  // the button (re-submit on edit creates a new draft → button returns).
  const canSubmitForReview =
    !isNew && stewardshipEnabled && status === "draft" && !isReviewerOnly;

  const handleDocLinkInsert = (node: { id: string; title: string }) => {
    // Insert as `[[Title]]` so the stored markdown stays portable —
    // Hootie/CLI/MCP all parse the same syntax. The WikiLink extension
    // handles styling and navigation at render time.
    editorRef.current?.insertWikiLink(node.title);
  };

  const openPreviewById = async (resolvedId: string, fallbackTitle: string) => {
    setPreviewDoc({
      id: resolvedId,
      title: fallbackTitle,
      content: "",
      loading: true,
    });
    try {
      const { node } = await api.getNode(nestId, resolvedId);
      setPreviewDoc({
        id: resolvedId,
        title: node?.title ?? fallbackTitle,
        content: node?.content ?? "",
        loading: false,
      });
    } catch {
      // Fetch failed — keep the placeholder so the user sees the modal
      // and a "(could not load)" body. They can still open in editor
      // for a full reload.
      setPreviewDoc({
        id: resolvedId,
        title: fallbackTitle,
        content: "",
        loading: false,
      });
    }
  };

  const handleWikiLinkClick = async (title: string, id: string | null) => {
    // Live link from the existence-check cache — open a peek modal so
    // any unsaved edits in the current doc are preserved. The old
    // behavior navigated away and discarded them.
    if (id) {
      await openPreviewById(id, title);
      return;
    }
    // Cache miss: resolve title → id at click time so links keep
    // working when the user typed `[[Foo]]` before Foo was created.
    try {
      const { nodes } = await api.searchNodes(nestId, title);
      const exact = (nodes as Array<{ id: string; title: string }>).find(
        (n) => n.title.toLowerCase() === title.toLowerCase(),
      );
      if (exact) {
        await openPreviewById(exact.id, exact.title);
        return;
      }
      // Broken link: title doesn't resolve. Block create for
      // reviewer / viewer roles — they don't have authoring rights,
      // and silently routing them to the new-doc page is misleading
      // (the server would reject the save anyway).
      if (isReviewerOnly) {
        setError(
          `"${title}" doesn't exist in this nest. Reviewers and viewers can't create new documents — ask an editor to add it.`,
        );
        return;
      }
      // Confirm with the user before leaving — current doc may have
      // unsaved edits we'd otherwise discard.
      confirmLeave(
        `create "${title}"`,
        () => onCreateDocument?.(nestId, title),
      );
    } catch {
      // Search itself failed (network / server error). Don't auto-create
      // on top of an error; the link stays broken until the next click.
    }
  };

  return (
    <div className="md:py-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-6 mt-14 md:mt-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => confirmLeave("go back", onBack)}
            data-testid="document-editor-back"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground truncate">
              {nestName}
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <h3 className="text-xl font-semibold truncate mb-0">
                {title || (isNew ? "New document" : "Untitled")}
              </h3>
              {!isNew && status && <StatusBadge status={status} />}
              {!isNew && !stewardshipEnabled && status === "approved" && (
                <span
                  className="px-1.5 py-0.5 rounded text-xs bg-green-50 text-green-700 border border-green-200"
                  title="Stewardship is off for this nest, so saving publishes immediately and the document is AI-readable."
                >
                  Auto-published
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canSubmitForReview && (
            <Button
              variant="outline"
              onClick={() => setShowSubmitModal(true)}
              data-testid="document-editor-submit"
              title="With stewardship on, &quot;publishing&quot; in this nest means submitting for steward approval."
            >
              <Send className="h-4 w-4 mr-2" />
              Publish (requires approval)
            </Button>
          )}
          {canReviewHere && (
            <ReviewActions
              documentTitle={title}
              version={baseVersion ?? 1}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          )}
          {!isLocked && !isReviewerOnly && (
            mode === "edit" ? (
              <Button
                onClick={handleSave}
                disabled={!canSave}
                data-testid="document-editor-save"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                {isNew ? "Create" : "Save"}
              </Button>
            ) : (
              <Button
                onClick={() => setMode("edit")}
                data-testid="document-editor-start-edit"
              >
                <Pencil className="h-4 w-4 mr-2" />
                Start Editing
              </Button>
            )
          )}
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />
          Loading document...
        </div>
      ) : (
        <div className="space-y-4">
          {!isNew && pendingChange && (
            <ExternalEditBanner
              nestId={nestId}
              nodeId={nodeId}
              pending={pendingChange}
              onResolved={() => {
                setPendingChange(null);
                loadNode();
              }}
            />
          )}

          {isLocked && (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                This document is awaiting steward review. Editing is locked
                until the review is resolved.
              </AlertDescription>
            </Alert>
          )}

          {/* Title — render as a Notion-style h1 in view mode so the page
              reads as a document, not a form. Switches to an Input in
              edit mode. The surrounding click-to-edit wrapper picks up
              clicks on the h1 and flips mode. */}
          <div>
            {mode === "view" && !isNew ? (
              <h1
                className="text-3xl font-bold leading-tight text-foreground"
                data-testid="document-editor-title"
              >
                {title || "Untitled"}
              </h1>
            ) : (
              <>
                <label className="block mb-1 text-sm font-medium">
                  Title <span className="text-destructive">*</span>
                </label>
                <Input
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setTouched(true);
                  }}
                  placeholder="Document title"
                  disabled={fieldsDisabled}
                  data-testid="document-editor-title"
                />
              </>
            )}
          </div>

          {/* Tags */}
          <div>
            <label className="block mb-1 text-sm font-medium">Tags</label>
            <div className="flex items-center gap-2">
              <Input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  // Space/comma/Enter all commit — supports pasted
                  // "#one #two", typed "tag, tag", or single-tag entry.
                  if (e.key === "Enter" || e.key === "," || e.key === " ") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                placeholder='Press Enter or space. Try "#api #v2" or "api, v2"'
                disabled={fieldsDisabled}
                data-testid="document-editor-tag-input"
              />
              <Button
                type="button"
                variant="outline"
                onClick={addTag}
                disabled={fieldsDisabled || !tagInput.trim()}
              >
                Add
              </Button>
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-xs"
                  >
                    {t}
                    {!fieldsDisabled && (
                      <button
                        type="button"
                        onClick={() => removeTag(t)}
                        className="hover:text-destructive"
                        aria-label={`Remove ${t}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* View or edit. View is a read-only markdown renderer (the doc
              body stays byte-for-byte the same on disk). Edit is the
              TipTap surface — its save path is unchanged by this PR.
              Double-click anywhere in the content area is an alternate
              entry into edit mode (the header "Start Editing" button is
              the primary one). Skip the flip when locked or when the
              caller is reviewer/viewer-only — those users have no edit
              path regardless. */}
          <div
            onDoubleClick={() => {
              if (mode === "view" && !isLocked && !isReviewerOnly) {
                setMode("edit");
              }
            }}
          >
            <label className="block text-sm font-medium mb-1">
              Content <span className="text-destructive">*</span>
            </label>
            {mode === "view" && !looksLikeHtml(content) ? (
              <div className="border rounded-lg bg-background shadow-sm min-h-[300px] cursor-text">
                <DocumentViewer
                  content={content}
                  onWikiLinkClick={(title) =>
                    handleWikiLinkClick(title, null)
                  }
                />
              </div>
            ) : (
              <MarkdownEditor
                ref={editorRef}
                content={content}
                onChange={(next) => {
                  setContent(next);
                  // Edit-mode TipTap fires onUpdate on real doc changes,
                  // not on programmatic setContent (we pass
                  // emitUpdate:false there) and not on setEditable. So
                  // any onChange here is a genuine user input.
                  setTouched(true);
                }}
                onSave={handleSave}
                nestId={nestId}
                editable={!isLocked && mode === "edit"}
                onRequestDocLink={() => setShowDocPicker(true)}
                onWikiLinkClick={handleWikiLinkClick}
                placeholder="Start writing..."
              />
            )}
          </div>
        </div>
      )}

      {!isNew && (
        <SubmitForReviewModal
          isOpen={showSubmitModal}
          onClose={() => setShowSubmitModal(false)}
          documentTitle={title}
          currentVersion={baseVersion ?? 1}
          onSubmit={handleSubmitForReview}
        />
      )}

      <DocumentPickerModal
        isOpen={showDocPicker}
        onClose={() => setShowDocPicker(false)}
        nestId={nestId}
        excludeNodeId={isNew ? undefined : nodeId}
        onSelect={handleDocLinkInsert}
      />

      {leaveIntent && (
        <Dialog open onOpenChange={() => setLeaveIntent(null)}>
          <DialogContent className="sm:max-w-[460px]">
            <DialogHeader>
              <DialogTitle>Unsaved changes</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground py-2">
              You have unsaved changes in this document. Save them before
              you {leaveIntent.label}, or discard to leave without saving.
            </p>
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setLeaveIntent(null)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                onClick={handleLeaveDiscard}
                disabled={saving}
              >
                Discard
              </Button>
              <Button onClick={handleLeaveSave} disabled={saving}>
                {saving ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                Save & leave
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {previewDoc && (
        <Dialog open onOpenChange={() => setPreviewDoc(null)}>
          <DialogContent className="sm:max-w-[700px] max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle className="pr-8">{previewDoc.title}</DialogTitle>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto rounded-md border">
              {previewDoc.loading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : previewDoc.content ? (
                looksLikeHtml(previewDoc.content) ? (
                  <MarkdownEditor
                    key={previewDoc.id}
                    content={previewDoc.content}
                    onChange={() => {}}
                    editable={false}
                  />
                ) : (
                  <DocumentViewer content={previewDoc.content} />
                )
              ) : (
                <p className="text-sm text-muted-foreground p-4">
                  (no content)
                </p>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setPreviewDoc(null)}
              >
                Close
              </Button>
              <Button
                disabled={saving}
                onClick={() => {
                  if (!previewDoc) return;
                  const targetId = previewDoc.id;
                  const targetTitle = previewDoc.title;
                  // Close the peek modal first so the leave-confirm
                  // dialog isn't stacked on top of it.
                  setPreviewDoc(null);
                  confirmLeave(
                    `open "${targetTitle}"`,
                    () => onNavigateDocument?.(nestId, targetId),
                  );
                }}
              >
                <ExternalLink className="h-4 w-4 mr-2" />
                Open in editor
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export default DocumentEditor;

// Status pill rendered next to the document title. Colours intentionally
// loud (especially "pending_review") so users notice immediately that
// the document is awaiting steward action and don't try to resubmit.
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    draft: {
      label: "Draft",
      cls: "bg-muted text-muted-foreground",
    },
    pending_review: {
      label: "Pending review",
      cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    },
    approved: {
      label: "Approved",
      cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    },
    published: {
      label: "Published",
      cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    },
    rejected: {
      label: "Rejected",
      cls: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
    },
    external_edit_pending: {
      label: "External edit",
      cls: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300",
    },
  };
  const info = map[status];
  if (!info) return null;
  return (
    <span
      className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${info.cls}`}
      data-testid={`document-status-${status}`}
    >
      {info.label}
    </span>
  );
}
