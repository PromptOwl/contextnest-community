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
  ArrowLeft,
  Loader2,
  Save,
  AlertCircle,
  Send,
  X,
} from "lucide-react";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "./MarkdownEditor";
import {
  SubmitForReviewModal,
  ReviewActions,
  ExternalEditBanner,
} from "./governance";
import type { PendingChange } from "../lib/api";
import { DocumentPickerModal } from "./DocumentPickerModal";
import { useAuth } from "../auth/AuthContext";

interface DocumentEditorProps {
  nestId: string;
  nestName: string;
  nodeId: string | "new";
  onBack: () => void;
  onSaved?: (savedNodeId: string) => void;
  /** Open a different document — invoked when the user clicks an
   *  internal `nest://` link inside the editor. */
  onNavigateDocument?: (nestId: string, nodeId: string) => void;
}

export function DocumentEditor({
  nestId,
  nestName,
  nodeId,
  onBack,
  onSaved,
  onNavigateDocument,
}: DocumentEditorProps) {
  const isNew = nodeId === "new";
  const { adminStatus } = useAuth();
  const currentEmail = adminStatus?.me?.email?.toLowerCase() ?? "";
  const [canReviewHerePerm, setCanReviewHerePerm] = useState(false);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [baseVersion, setBaseVersion] = useState<number | undefined>(undefined);
  const [status, setStatus] = useState<string | null>(null);
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  const [stewardshipEnabled, setStewardshipEnabled] = useState(false);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [showDocPicker, setShowDocPicker] = useState(false);

  const editorRef = useRef<MarkdownEditorHandle | null>(null);

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Approve/reject is reviewer-only by product rule (editors/viewers/owners
  // get hidden, even though server still enforces). Resolve from this
  // node's stewards so a per-document reviewer is honored even when the
  // user has no nest-wide row.
  useEffect(() => {
    if (isNew || !nodeId || !currentEmail) {
      setCanReviewHerePerm(false);
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
        setCanReviewHerePerm(!!mine && mine.role === "reviewer" && mine.canApprove);
      } catch {
        if (!cancelled) setCanReviewHerePerm(false);
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
      setTitle(node?.title ?? "");
      setContent(node?.content ?? "");
      setTags(Array.isArray(node?.tags) ? node.tags : []);
      setBaseVersion(node?.version);
      setStatus(node?.status ?? null);
      setPendingChange((node as any)?.pendingChange ?? null);
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

  const canSave = useMemo(
    () =>
      !isLocked &&
      title.trim().length > 0 &&
      content.trim().length > 0 &&
      !saving,
    [isLocked, title, content, saving],
  );

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
  }, [tagInput, tags]);

  const removeTag = (t: string) => setTags(tags.filter((x) => x !== t));

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        const res = await api.createNode(nestId, {
          title: title.trim(),
          content,
          tags,
        });
        const newId = res?.node?.id;
        onSaved?.(newId ?? "");
      } else {
        const res = await api.updateNode(
          nestId,
          nodeId,
          {
            title: title.trim(),
            content,
            tags,
          },
          baseVersion,
        );
        // Server publishes through the engine which bumps the version
        // beyond what UI knew. Pick up the new number so the next save
        // sends a matching X-Base-Version and doesn't 409.
        const nextVersion =
          (res as any)?.version ?? (res as any)?.node?.version;
        if (typeof nextVersion === "number") {
          setBaseVersion(nextVersion);
        }
        onSaved?.(nodeId);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
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
  const canReviewHere =
    !isNew && status === "pending_review" && canReviewHerePerm;

  // Submit-for-Review only makes sense on an existing draft when the
  // nest has stewardship enabled. Pending/approved/rejected docs hide
  // the button (re-submit on edit creates a new draft → button returns).
  const canSubmitForReview =
    !isNew && stewardshipEnabled && status === "draft";

  const handleDocLinkInsert = (node: { id: string; title: string }) => {
    // Insert as `[[Title]]` so the stored markdown stays portable —
    // Hootie/CLI/MCP all parse the same syntax. The WikiLink extension
    // handles styling and navigation at render time.
    editorRef.current?.insertWikiLink(node.title);
  };

  const handleWikiLinkClick = async (title: string, id: string | null) => {
    // Live link from the existence-check cache — jump straight in.
    if (id) {
      onNavigateDocument?.(nestId, id);
      return;
    }
    // Cache miss: resolve title → id at click time so links keep
    // working when the user typed `[[Foo]]` before Foo was created.
    try {
      const { nodes } = await api.searchNodes(nestId, title);
      const exact = (nodes as Array<{ id: string; title: string }>).find(
        (n) => n.title.toLowerCase() === title.toLowerCase(),
      );
      if (exact) onNavigateDocument?.(nestId, exact.id);
    } catch {
      /* nothing useful to do — link stays broken */
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
            onClick={onBack}
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
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canSubmitForReview && (
            <Button
              variant="outline"
              onClick={() => setShowSubmitModal(true)}
              data-testid="document-editor-submit"
            >
              <Send className="h-4 w-4 mr-2" />
              Submit for Review
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
          {!isLocked && (
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

          {/* Title */}
          <div>
            <label className="block mb-1 text-sm font-medium">
              Title <span className="text-destructive">*</span>
            </label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Document title"
              disabled={isLocked}
              data-testid="document-editor-title"
            />
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
                disabled={isLocked}
                data-testid="document-editor-tag-input"
              />
              <Button
                type="button"
                variant="outline"
                onClick={addTag}
                disabled={isLocked || !tagInput.trim()}
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
                    {!isLocked && (
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

          {/* Editor */}
          <div>
            <label className="block mb-1 text-sm font-medium">
              Content <span className="text-destructive">*</span>
            </label>
            <MarkdownEditor
              ref={editorRef}
              content={content}
              onChange={setContent}
              onSave={handleSave}
              nestId={nestId}
              editable={!isLocked}
              onRequestDocLink={() => setShowDocPicker(true)}
              onWikiLinkClick={handleWikiLinkClick}
              placeholder="Start writing..."
            />
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
