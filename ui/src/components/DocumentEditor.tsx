/** DocumentEditor — create/edit view; `nodeId === "new"` → POST, else PATCH. Server enforces 403. */
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
  Users,
} from "lucide-react";
import {
  MarkdownEditor,
  slugFromNodeId,
  type MarkdownEditorHandle,
} from "./MarkdownEditor";
import { DocumentViewer } from "./DocumentViewer";
import { ShareNestDialog } from "./ShareNestDialog";
import { SubmitForReviewModal, ReviewActions, ExternalEditBanner } from "./governance";
import type { PendingChange } from "../lib/api";
import { DocumentPickerModal } from "./DocumentPickerModal";
import { useAuth } from "../auth/AuthContext";
import type { BreadcrumbEntry } from "../App";
import { Fragment } from "react";

/** HTML if it starts with a tag; else markdown. */
function looksLikeHtml(s: string): boolean {
  if (!s) return false;
  return /^\s*</.test(s);
}

/** Canonicalize HTML for dirty-tracking (TipTap re-emits don't byte-match server load). */
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
  /** Owner skips the reviewer-role requirement; self-approving their own
   *  submission still requires the nest's allow_self_approve flag. */
  isOwner?: boolean;
  onBack: () => void;
  onSaved?: (savedNodeId: string) => void;
  /** Open another document; `currentTitle` feeds breadcrumb push. */
  onNavigateDocument?: (
    nestId: string,
    nodeId: string,
    currentTitle?: string,
  ) => void;
  /** Tag chip click → filter nest list by tag. */
  onTagClick?: (tag: string) => void;
  /** Broken `[[Title]]` click → create-with-title. */
  onCreateDocument?: (nestId: string, title: string) => void;
  /** Pre-fill title when nodeId === "new" (wiki-create flow). */
  initialTitle?: string;
  /** Prior wiki-link hops, oldest first; rendered as clickable chips. */
  breadcrumb?: BreadcrumbEntry[];
  /** Jump to ancestor at `index`; drops entries after it. */
  onJumpBreadcrumb?: (index: number) => void;
}

export function DocumentEditor({
  nestId,
  nestName,
  nodeId,
  isOwner = false,
  onBack,
  onSaved,
  onNavigateDocument,
  onTagClick,
  onCreateDocument,
  initialTitle,
  breadcrumb,
  onJumpBreadcrumb,
}: DocumentEditorProps) {
  const isNew = nodeId === "new";
  const { adminStatus, isAdmin } = useAuth();
  const currentEmail = adminStatus?.me?.email?.toLowerCase() ?? "";
  // Inline sharing from the document view — "add folks to a context where
  // you're reading it" instead of bouncing back to the nest. Same dialog
  // and owner/admin gate as NestView (the server requires admin on
  // /collaborators and /visibility). New, unsaved docs have no shareable
  // nest target distinct from the nest list, so only offer it once we're
  // looking at a real nest the caller can administer.
  const canShare = isOwner || isAdmin;
  const [showShare, setShowShare] = useState(false);
  // Caller's resolved steward role for this node (null = none / not a steward).
  // Drives read-only gating for reviewer/viewer roles on Save + Submit.
  const [myNodeRoles, setMyNodeRoles] = useState<string[]>([]);
  // Caller's nest-wide scoped steward rows (from GET /nests/:id). Needed for
  // NEW docs, where there's no node yet to resolve a per-node role against.
  const [myStewards, setMyStewards] = useState<
    Array<{ role: string; scope: string }>
  >([]);

  const [title, setTitle] = useState(isNew && initialTitle ? initialTitle : "");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [baseVersion, setBaseVersion] = useState<number | undefined>(undefined);
  const [status, setStatus] = useState<string | null>(null);
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  // Submitter of the active pending review (null when not pending).
  // Drives SoD on the inline approve/reject: the user who submitted
  // the review can't approve it themselves — server enforces the same
  // rule and 403s if you try, but hiding the affordance avoids the
  // user clicking through an error.
  const [pendingReviewBy, setPendingReviewBy] = useState<string | null>(null);
  const [stewardshipEnabled, setStewardshipEnabled] = useState(false);
  // When on, the submitter may approve their own pending review (per-nest
  // self-approve bypass). Off = separation of duties enforced for everyone.
  const [allowSelfApprove, setAllowSelfApprove] = useState(false);
  // Caller's nest-level permission (GET /nests/:id). 'read' = no write access
  // (public reader OR a read-only collaborator); 'write'/'admin'/'owner' can
  // edit. null until loaded.
  const [permission, setPermission] = useState<string | null>(null);
  // Read-only when the caller's nest permission is 'read' and they hold no
  // per-node steward row. Any editor/reviewer node row overrides this so a
  // steward scoped to this doc still gets their affordances.
  const isReadOnly = permission === "read";
  // Authoring a NEW doc can't resolve a per-node role (no node yet), so gate
  // on nest-wide capability: owner/admin, a write+ collaborator, or a
  // nest-scope editor steward. Mirrors NestView's "New Document" gate.
  const canAuthorNew =
    isOwner ||
    isAdmin ||
    permission === "owner" ||
    permission === "admin" ||
    permission === "write" ||
    myStewards.some((s) => s.role === "editor" && s.scope === "nest");
  const isViewOnly = isNew
    ? !canAuthorNew
    : isReadOnly && myNodeRoles.length === 0;
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [showDocPicker, setShowDocPicker] = useState(false);
  // CU-86ahmvmex: existing docs default to view mode; new docs to edit.
  const [mode, setMode] = useState<"view" | "edit">(isNew ? "edit" : "view");

  const editorRef = useRef<MarkdownEditorHandle | null>(null);

  // Last loaded/saved snapshot; drives isDirty for the leave-confirm path.
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
  // User-edited flag; raw diff is unreliable because TipTap normalizes loaded HTML.
  const [touched, setTouched] = useState(false);

  // Settings → Submit-for-Review visibility; permission → read-only gate.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [settings, meta] = await Promise.all([
          api.getNestSettings(nestId).catch(() => ({ stewardship_enabled: false, allow_self_approve: false })),
          api.getNest(nestId).catch(() => null),
        ]);
        if (cancelled) return;
        setStewardshipEnabled(!!settings.stewardship_enabled);
        setAllowSelfApprove(!!settings.allow_self_approve);
        setPermission(meta?.permission ?? null);
        setMyStewards(((meta as any)?.myStewards ?? []) as Array<{
          role: string;
          scope: string;
        }>);
      } catch {
        /* non-fatal */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nestId]);

  // Resolve per-node steward role; null = no special permissions.
  useEffect(() => {
    if (isNew || !nodeId || !currentEmail) {
      setMyNodeRoles([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { stewards } = await api.getNodeStewards(nestId, nodeId);
        if (cancelled) return;
        const mine = (stewards as any[]).filter(
          (s) => (s.email || "").toLowerCase() === currentEmail,
        );
        setMyNodeRoles(mine.map((s) => s.role));
      } catch {
        if (!cancelled) setMyNodeRoles([]);
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
      // Coerce to strings — YAML frontmatter can parse `title: 123` as a
      // number, and `title.trim()` later would throw "trim is not a function".
      const loadedTitle = node?.title == null ? "" : String(node.title);
      const loadedContent = node?.content == null ? "" : String(node.content);
      const loadedTags = Array.isArray(node?.tags)
        ? node.tags.map((t: unknown) => String(t))
        : [];
      setTitle(loadedTitle);
      setContent(loadedContent);
      setTags(loadedTags);
      setBaseVersion(node?.version);
      setStatus(node?.status ?? null);
      setPendingChange((node as any)?.pendingChange ?? null);
      setPendingReviewBy(
        ((node as any)?.pendingReviewBy as string | null | undefined) ?? null,
      );
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

  // A pending-review doc is LOCKED: the server rejects edits/deletes with
  // 423 while a review is open (nodes/routes). Plain drafts stay editable —
  // only status==='pending_review' locks, so the editor flows normally until
  // a review is actually requested.
  const isLocked = status === "pending_review";

  // Fields read-only when locked or outside edit mode; "Start Editing" or
  // dblclick opts in (drafts only — a locked doc can't enter edit).
  const fieldsDisabled = isLocked || mode !== "edit";

  const canSave = useMemo(
    () =>
      title.trim().length > 0 &&
      content.trim().length > 0 &&
      !saving,
    [title, content, saving],
  );

  // Dirty = touched AND diff vs snapshot (normalized to absorb TipTap reformat).
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
    // Split on whitespace/comma; strip leading "#" (stored bare).
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
      // Engine bumps version on publish; pick it up so next save's X-Base-Version matches.
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

  // Pending nav stashed behind unsaved-changes confirm; runs after Save/Discard.
  const [leaveIntent, setLeaveIntent] = useState<{
    label: string;
    run: () => void;
  } | null>(null);

  // Single save path; afterSave continuation feeds onSaved or stashed intent.
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

  // Silent debounced autosave — fires on a typing pause and on click-out
  // (editor blur). No spinner, no "saving…" so the always-editable surface
  // never flickers. Skips new docs (a silent create is surprising),
  // locked/reviewer/view-only sessions, and clean state. autosaveRef is
  // reassigned every render so the debounce timer always runs the latest
  // closure (current title/content/tags).
  const autosaveTimer = useRef<number | null>(null);
  const autosaveRef = useRef<() => void>(() => {});
  autosaveRef.current = async () => {
    if (isNew || saving) return;
    if (isLocked || isReviewerOnly || isViewOnly) return;
    if (title.trim().length === 0 || content.trim().length === 0) return;
    if (!isDirty) return;
    try {
      await persistCurrent();
    } catch {
      /* stay dirty; the manual Save path surfaces the error */
    }
  };
  const scheduleAutosave = useCallback(() => {
    if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = window.setTimeout(() => {
      autosaveTimer.current = null;
      void autosaveRef.current();
    }, 1200);
  }, []);
  const flushAutosave = useCallback(() => {
    if (autosaveTimer.current) {
      window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = null;
    }
    void autosaveRef.current();
  }, []);
  useEffect(
    () => () => {
      if (autosaveTimer.current) window.clearTimeout(autosaveTimer.current);
    },
    [],
  );

  // Confirm before unmount when dirty; read-only sessions skip the prompt.
  const confirmLeave = (label: string, run: () => void) => {
    if (!isDirty || isReviewerOnly) {
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
    // Reload → status flips to pending_review, button hides.
    await loadNode();
  };

  // Inline reviewer actions; server still enforces permission.
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
  const hasReviewerRole = myNodeRoles.includes("reviewer");
  const hasEditorRole = myNodeRoles.includes("editor");

  // Mirrors server-side canUserApprove:
  //   admin (collaborator/steward) -> approve anything
  //   reviewer steward             -> approve
  //   bare owner                   -> ONLY when the nest allows self-approve
  // SoD: you can't approve a review YOU submitted — unless you're the owner
  // and the nest allows self-approve (the seeding switch).
  const isOwnSubmission =
    !!pendingReviewBy &&
    !!currentEmail &&
    pendingReviewBy.toLowerCase() === currentEmail;
  const hasAdminApprove =
    isAdmin || permission === "admin" || myNodeRoles.includes("admin");
  const canApproveCapability =
    hasAdminApprove || hasReviewerRole || (isOwner && allowSelfApprove);
  const canReviewHere =
    !isNew &&
    status === "pending_review" &&
    canApproveCapability &&
    (!isOwnSubmission || (isOwner && allowSelfApprove));

  // Read-only when the caller's only steward rows are reviewer/viewer
  // (no editor row anywhere). Editors author content; reviewers just
  // approve/reject; viewers just read. A user with editor + reviewer is
  // NOT read-only — keep edit affordances open for them.
  const isReviewerOnly = !isOwner && myNodeRoles.length > 0 && !hasEditorRole;

  // Always-editable surface ("buttery editor"): anyone who can edit drops
  // straight into the live editor instead of view → click → edit, which
  // remounts DocumentViewer→MarkdownEditor and loses the caret/reflows.
  // Read-only sessions (view-only / locked / reviewer) keep the rendered view.
  useEffect(() => {
    if (loading || mode === "edit") return;
    if (!isViewOnly && !isLocked && !isReviewerOnly) setMode("edit");
  }, [loading, isViewOnly, isLocked, isReviewerOnly, mode]);

  // A doc can become locked while already in edit mode (e.g. the user just
  // submitted it for review). Kick back to read-only view so the editor
  // surface, Save button and dblclick-to-edit are all disabled.
  useEffect(() => {
    if (isLocked && mode === "edit") setMode("view");
  }, [isLocked, mode]);

  // Submit-for-Review only on existing drafts with stewardship enabled.
  const canSubmitForReview =
    !isNew && stewardshipEnabled && status === "draft" && !isReviewerOnly;

  const handleDocLinkInsert = (node: { id: string; title: string }) => {
    editorRef.current?.insertWikiLink(slugFromNodeId(node.id), node.title);
  };

  const handleWikiLinkClick = async (linkTitle: string, id: string | null) => {
    // Cached hit → leave-confirm then nav.
    if (id) {
      confirmLeave(
        `open "${linkTitle}"`,
        () => onNavigateDocument?.(nestId, id, title),
      );
      return;
    }
    // Resolve target as id, title, or slug.
    try {
      const { nodes } = await api.listNodes(nestId);
      const list = nodes as Array<{ id: string; title: string }>;
      const lower = linkTitle.toLowerCase();
      const bareSlug = slugFromNodeId(linkTitle).toLowerCase();
      const exact = list.find(
        (n) =>
          n.id.toLowerCase() === lower ||
          n.title.toLowerCase() === lower ||
          slugFromNodeId(n.id).toLowerCase() === bareSlug,
      );
      if (exact) {
        confirmLeave(
          `open "${exact.title}"`,
          () => onNavigateDocument?.(nestId, exact.id, title),
        );
        return;
      }
      // Block create for reviewer/viewer/public-reader (no authoring).
      if (isReviewerOnly || isViewOnly) {
        setError(
          `"${linkTitle}" doesn't exist in this nest. You only have view access — ask someone with edit rights to add it.`,
        );
        return;
      }
      confirmLeave(
        `create "${linkTitle}"`,
        () => onCreateDocument?.(nestId, linkTitle),
      );
    } catch {
      // Search failed; don't auto-create on top of error.
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
          {/* Chain: nest > ancestors… > doc. Chip click truncates chain. */}
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <span className="text-sm text-muted-foreground truncate">
              {nestName}
            </span>
            {breadcrumb?.map((entry, i) => (
              <Fragment key={`${entry.nestId}/${entry.nodeId}/${i}`}>
                <span className="text-muted-foreground shrink-0">›</span>
                <button
                  type="button"
                  onClick={() =>
                    confirmLeave(`go to "${entry.title}"`, () =>
                      onJumpBreadcrumb?.(i),
                    )
                  }
                  className="text-sm text-muted-foreground hover:text-foreground hover:underline underline-offset-2 truncate max-w-[160px]"
                  title={entry.title}
                  data-testid={`document-editor-breadcrumb-${i}`}
                >
                  {entry.title}
                </button>
              </Fragment>
            ))}
            <span className="text-muted-foreground shrink-0">›</span>
            <h3
              className="text-sm font-bold text-foreground truncate mb-0 leading-none"
              data-testid="document-editor-header-title"
            >
              {title || (isNew ? "New document" : "Untitled")}
            </h3>
            {!isNew && status && <StatusBadge status={status} />}
            {!isNew && !stewardshipEnabled && status === "published" && (
              <span
                className="px-1.5 py-0.5 rounded text-xs bg-green-50 text-green-700 border border-green-200"
                title="Stewardship off — saving auto-publishes."
              >
                Auto-published
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Write/review affordances hidden for public reader. */}
          {canShare && (
            <Button
              variant="outline"
              onClick={() => setShowShare(true)}
              data-testid="document-editor-share"
              title="Share this nest — visibility and collaborators"
            >
              <Users className="h-4 w-4 mr-2" />
              Share
            </Button>
          )}
          {!isViewOnly && canSubmitForReview && (
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
          {!isViewOnly && canReviewHere && (
            <ReviewActions
              documentTitle={title}
              version={baseVersion ?? 1}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          )}
          {!isViewOnly && !isReviewerOnly && !isLocked && (
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
                This document is locked while it awaits steward review. Editing
                is disabled until the review is approved or rejected.
              </AlertDescription>
            </Alert>
          )}

          {/* Notion-style h1 in view mode; Input in edit mode. */}
          <div>
            {mode === "view" && !isNew ? (
              <h1
                className="text-3xl font-bold leading-tight text-foreground"
                data-testid="document-editor-title"
              >
                {title || "Untitled"}
              </h1>
            ) : (
              // Borderless, h1-styled title input so the always-editable page
              // reads like a document, not a form. Placeholder stands in for
              // the old "Title *" label; Save stays gated on a non-empty title.
              <Input
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setTouched(true);
                }}
                placeholder="Untitled"
                disabled={fieldsDisabled}
                data-testid="document-editor-title"
                className="border-0 px-0 h-auto py-0 text-3xl font-bold leading-tight shadow-none focus-visible:ring-0 placeholder:text-muted-foreground/40"
              />
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
                  // Space/comma/Enter all commit (pasted "#one #two" or "tag, tag").
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
                {tags.map((t) => {
                  // View mode: chip click → filter nest by tag. Edit mode: X removes.
                  const tagClickable = mode === "view" && !!onTagClick;
                  return (
                    <span
                      key={t}
                      onClick={
                        tagClickable
                          ? (e) => {
                            e.stopPropagation();
                            onTagClick!(t);
                          }
                          : undefined
                      }
                      className={
                        "inline-flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-xs" +
                        (tagClickable ? " cursor-pointer hover:bg-secondary/80" : "")
                      }
                      title={tagClickable ? `Filter nest by ${t}` : undefined}
                    >
                      {t}
                      {!fieldsDisabled && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeTag(t);
                          }}
                          className="hover:text-destructive"
                          aria-label={`Remove ${t}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          {/* Dblclick → edit unless locked/reviewer/public-viewer. */}
          <div
            onClick={() => {
              if (isViewOnly || isLocked) return;
              if (mode === "view" && !isReviewerOnly) {
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
                  // TipTap onUpdate fires only on real user input here.
                  setTouched(true);
                  scheduleAutosave();
                }}
                onSave={handleSave}
                onBlur={flushAutosave}
                nestId={nestId}
                editable={!fieldsDisabled}
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

      {showShare && (
        <ShareNestDialog
          nestId={nestId}
          nestName={nestName}
          onClose={() => setShowShare(false)}
          onChanged={() => {
            /* Sharing changes don't alter this document's content; nothing
               to reload here. The nest list re-reads on next visit. */
          }}
        />
      )}
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

    </div>
  );
}

export default DocumentEditor;

// Status pill next to doc title; loud colours flag pending_review.
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
