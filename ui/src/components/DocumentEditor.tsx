/** DocumentEditor — create/edit view; `nodeId === "new"` → POST, else PATCH. Server enforces 403. */
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import * as api from "../lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateForPath, keys, reads, useNestMeta, useNestSettings, useNodeStewards } from "../lib/queries";
import { readDraft, writeDraft, clearDraft } from "../lib/draft";
import { setNavGuard, bypassNavGuard } from "../lib/nav-guard";
import { MAX_FOLDER_DEPTH } from "../lib/constants";
import { nestPath } from "../lib/nest-url";
import { useBreadcrumb } from "../lib/breadcrumb";
import {
  clampTagInput,
  newTags,
  normalizeTagInput,
  tagKey,
  TAG_INPUT_MAX_LENGTH,
} from "../lib/tag-policy";
import { relTime, formatServerDate } from "../lib/dates";
import { useRovingFocus } from "../lib/use-roving-focus";
import { resolveEditorAccess } from "../lib/editor-access";
import { isNestArchived } from "../lib/nest-caps";
import {
  nextCommentsOpen,
  readDocPagePrefs,
  writeDocPagePrefs,
} from "../lib/doc-page";
import { NestVisibilityControl } from "./NestVisibilityControl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowLeft, FileWarning, RefreshCw, FolderInput,
  Loader2,
  Save,
  AlertCircle,
  Send,
  Trash2,
  X,
  FolderOpen,
  FolderPlus,
  FileText,
  Bot,
  Zap,
  Wrench,
  Table2,
  Pencil,
  Users,
  Share2,
  Link as LinkIcon,
  History,
  Code2,
  MessageSquare,
  MessageSquarePlus,
  GitCompare,
  ChevronDown,
  Check,
  Copy,
  Star,
  Undo2,
  PanelLeft,
  Globe,
  Building2,
  Lock,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { OverflowMenu, type OverflowAction } from "@/components/ui/overflow-menu";
import { toast } from "sonner";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "./MarkdownEditor";
import { DocumentViewer } from "./DocumentViewer";
import { AuthorshipChips } from "./AuthorshipChips";
import { TableViewer, TableGrid } from "./TableViewer";
import { tableDiffSides } from "../lib/csv-table";
import { TableSourceEditor } from "./TableSourceEditor";
import { ArtifactViewer, ARTIFACT_NODE_TYPE } from "./ArtifactViewer";
import { CodeHighlight } from "./CodeHighlight";
import { prettyFolder, prettyFolderPath } from "./FolderTree";
import { ShareNestDialog } from "./ShareNestDialog";
import { PublishDialog } from "./PublishDialog";
import { ShareTargetDialog } from "./ShareTargetDialog";
import { AnnotationsPanel } from "./AnnotationsPanel";
import {
  buildTextIndex,
  rangeForAnchor,
  setHighlight,
  clearHighlight,
  caretAt,
} from "../lib/anchor-highlight";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SubmitForReviewModal, ReasonDialog, ReviewActions, ExternalEditBanner, VersionHistoryModal, DiffViewer } from "./governance";
import { unifiedDiff } from "./governance/diff-util";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { PendingChange } from "../lib/api";
import { findBacklinks, renameImpactBacklinks, staleAliasLinks } from "../lib/backlinks";
import { relatedDocs } from "../lib/related";
import { copyTextWithToast } from "../lib/clipboard";
import { unlinkedMentions } from "../lib/unlinked-mentions";
import { extractHeadings } from "../lib/toc";
import { validateSchedule } from "../lib/schedule-validation";
import { resolveWikiTarget, previewSnippet, decideWikiLinkAction } from "../lib/wiki-preview";
import { DocumentPickerModal } from "./DocumentPickerModal";
import { useAuth } from "../auth/AuthContext";
import type { BreadcrumbEntry } from "../App";
import { Fragment } from "react";

/** HTML if it starts with a tag; else markdown. */
function looksLikeHtml(s: string): boolean {
  if (!s) return false;
  return /^\s*</.test(s);
}

/** Human label for a Type's body-interpretation class, used by the New
 *  Document Type-switch confirm dialog. */
function bodyKindLabel(kind: "markdown" | "html" | "csv" | "code"): string {
  switch (kind) {
    case "html":
      return "raw HTML (served as a sandboxed page)";
    case "csv":
      return "CSV data";
    case "code":
      return "code (tool source)";
    default:
      return "formatted document prose";
  }
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
  /** Open this nest's document list (breadcrumb nest-name click). */
  onOpenNest?: () => void;
  /** Open the nest list scoped to a folder (breadcrumb folder-segment click). */
  onOpenFolder?: (folder: string) => void;
  /** Broken `[[Title]]` click → create-with-title. */
  onCreateDocument?: (nestId: string, title: string) => void;
  /** Pre-fill title when nodeId === "new" (wiki-create flow). */
  initialTitle?: string;
  /** Pre-file a NEW doc into this folder (folder-tree + buttons). */
  initialFolder?: string;
  /** Open with this comment thread focused — comment mode on, the thread
   *  emphasized in the rail, and its anchored quote scrolled into view.
   *  Set by the nest activity feed / ?thread= deep link. */
  initialThreadId?: string;
  /** Prior wiki-link hops, oldest first; rendered as clickable chips. */
  breadcrumb?: BreadcrumbEntry[];
  /** Jump to ancestor at `index`; drops entries after it. */
  onJumpBreadcrumb?: (index: number) => void;
  /** The page's index rail is hidden; the top bar offers to bring it back. */
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

export function DocumentEditor({
  nestId,
  nestName,
  nodeId,
  initialFolder,
  initialThreadId,
  isOwner = false,
  onBack,
  onSaved,
  onNavigateDocument,
  onTagClick,
  onOpenNest,
  onOpenFolder,
  onCreateDocument,
  initialTitle,
  breadcrumb,
  onJumpBreadcrumb,
  sidebarCollapsed = false,
  onToggleSidebar,
}: DocumentEditorProps) {
  const isNew = nodeId === "new";
  // Type picker: one tab stop, arrows between the choices (see the radiogroup).
  const typeRoving = useRovingFocus<HTMLDivElement>();
  const { adminStatus, isAdmin, workflowPlaneEnabled, typeArtifactEnabled, typeTableEnabled } = useAuth();
  const currentEmail = adminStatus?.me?.email?.toLowerCase() ?? "";
  // Inline sharing from the document view — "add folks to a context where
  // you're reading it" instead of bouncing back to the nest. Same dialog
  // and owner/admin gate as NestView (the server requires admin on
  // /collaborators and /visibility). New, unsaved docs have no shareable
  // nest target distinct from the nest list, so only offer it once we're
  // looking at a real nest the caller can administer.
  // Folded with !isArchived at each use below (isArchived resolves later,
  // off the nest fetch): an archived nest's visibility, sharing and
  // publishing are frozen, so the controls that change them are withheld.
  const canShare = isOwner || isAdmin;
  const [showShare, setShowShare] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  // Share THIS document with one person (a grant), as opposed to the whole
  // nest above. Same owner/admin gate the /grants routes enforce.
  const [showShareDoc, setShowShareDoc] = useState(false);
  const qc = useQueryClient();
  // Permissions are SUBSCRIBED, not snapshotted. Assigning a steward, changing
  // a collaborator or toggling stewardship already invalidates these reads
  // (invalidateForPath in lib/queries), but this screen used to copy them into
  // state on mount — so an open editor kept the rights the caller had when they
  // opened it, and only a page reload showed the change (CU-wdqcpzzmk0).
  const nestMeta = useNestMeta(nestId);
  const nestSettings = useNestSettings(nestId);
  const nodeStewardsQuery = useNodeStewards(nestId, isNew ? undefined : nodeId);
  // Caller's resolved steward role for this node (empty = none / not a steward).
  // Drives read-only gating for reviewer/viewer roles on Save + Submit.
  const myNodeRoles = useMemo(
    () =>
      ((nodeStewardsQuery.data?.stewards ?? []) as any[])
        .filter((s) => (s.email || "").toLowerCase() === currentEmail)
        .map((s) => String(s.role)),
    [nodeStewardsQuery.data, currentEmail],
  );
  // True once the steward-role read has resolved (even to []) — lets the
  // default-comment-mode effect wait for a real answer instead of racing the
  // initial empty array. A new document has no node to resolve against.
  const rolesLoaded = isNew || !nodeStewardsQuery.isLoading;
  // Caller's share grant on THIS document (server-resolved on GET /nodes/:id).
  // A grant is access, not stewardship: it appears in neither `permission` (a
  // grantee always reads as "read" at nest level, whatever their grant says)
  // nor `myNodeRoles`. Without it a write grantee got a read-only editor for
  // the very document they were granted write on.
  const [myGrant, setMyGrant] = useState<"read" | "write" | null>(null);
  const grantCanWrite = myGrant === "write";
  // Caller's nest-wide scoped steward rows (from GET /nests/:id). Needed for
  // NEW docs, where there's no node yet to resolve a per-node role against.
  const myStewards = ((nestMeta.data as any)?.myStewards ?? []) as Array<{
    role: string;
    scope: string;
  }>;

  const [title, setTitle] = useState(isNew && initialTitle ? initialTitle : "");
  // Header breadcrumb: Home › nest › this document (App adds the front).
  useBreadcrumb([{ label: isNew ? "New document" : title.trim() || "Untitled" }]);
  // Folder path under nodes/ for new docs (e.g. "gtm/deals"). Create-only:
  // moving an existing doc is a rename with backlink fallout, handled elsewhere.
  const [folder, setFolder] = useState(initialFolder ?? "");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  // Orchestrator schedule (free-form cron/interval). Only meaningful for
  // runnable node types (agent/skill); ignored/hidden otherwise. "" = none.
  const [schedule, setSchedule] = useState("");
  // Document-scope prime flag: true/false override the nest's prime tags,
  // null means "inherit". Governance, not authoring — owner/admin only, and
  // the server re-checks (assertMayFlagPrime).
  const [prime, setPrime] = useState<boolean | null>(null);
  const loadedPrimeRef = useRef<boolean | null>(null);
  const primeTags = ((nestSettings.data as any)?.prime_tags ?? []) as string[];
  // Node kind. An "artifact" node is rich HTML hosted + annotated, not edited
  // as markdown — once loaded we hand off to ArtifactViewer (see below).
  const [nodeType, setNodeType] = useState<string | null>(null);
  // Version history for the detail view (CU-wdqcpztgwn). Lazily loaded when
  // the user opens the modal — VersionHistory already renders highlighted diffs.
  const [versionData, setVersionData] = useState<{
    versions: any[];
    approvedVersion: number | null;
    currentVersion: number;
    externalEditVerdicts?: api.ExternalEditVerdict[];
  } | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  // Ever-present inline diff: pick a past version from the "Compare" dropdown
  // and the doc area renders current↔vN inline (no modal). diffRendered swaps
  // the unified line-diff for a side-by-side rendered-markdown comparison.
  const [compareVersion, setCompareVersion] = useState<number | null>(null);
  const [diffRendered, setDiffRendered] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [baseVersion, setBaseVersion] = useState<number | undefined>(undefined);
  const [status, setStatus] = useState<string | null>(null);
  // Creator + everyone else with a hand in the doc (version authors ∪
  // document-scope grantees) — server-resolved on GET /nodes/:id.
  const [author, setAuthor] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  // Submitter of the active pending review (null when not pending).
  // Drives SoD on the inline approve/reject: the user who submitted
  // the review can't approve it themselves — server enforces the same
  // rule and 403s if you try, but hiding the affordance avoids the
  // user clicking through an error.
  const [pendingReviewBy, setPendingReviewBy] = useState<string | null>(null);
  const stewardshipEnabled = !!nestSettings.data?.stewardship_enabled;
  // When on, the submitter may approve their own pending review (per-nest
  // self-approve bypass). Off = separation of duties enforced for everyone.
  const allowSelfApprove = !!nestSettings.data?.allow_self_approve;
  // Caller's nest-level permission (GET /nests/:id). 'read' = no write access
  // (public reader OR a read-only collaborator); 'write'/'admin'/'owner' can
  // edit. null until loaded.
  const permission = (nestMeta.data?.permission ?? null) as string | null;
  // Read straight off the same GET /nests/:id response `permission` above
  // comes from, rather than a prop threaded down through App.tsx's View
  // state — the document page is reachable via wiki-link nav, a board/graph
  // card click, quick-open, and deep links, none of which forwarded an
  // isArchived flag, so an archived nest's editor stayed writable everywhere
  // except the one path (Dashboard → nest → doc) that happened to pass it.
  const isArchived = isNestArchived(nestMeta.data?.nest);
  // Every edit/approve affordance below gates on these — see editor-access.ts
  // for the rules and ui/src/lib/editor-access.test.ts for the role matrix.
  const {
    canAuthorNew,
    hasAdminApprove,
    isViewOnly,
    isReviewerOnly,
    canEditContent,
  } = resolveEditorAccess({
    isNew,
    isOwner,
    isAdmin,
    permission,
    nestStewards: myStewards,
    nodeRoles: myNodeRoles,
    grant: myGrant,
    isArchived,
  });
  // Who deletes outright: the nest admin/owner tier, plus the person who wrote
  // the document — asking permission to delete your own work is the wrong
  // default. Everyone else goes through the request path. The server still
  // gates on write permission, so an author downgraded to read-only since gets
  // a 403 rather than a silent delete.
  const authoredByMe =
    !!author &&
    !!adminStatus?.me?.email &&
    author.toLowerCase() === adminStatus.me.email.toLowerCase();
  // !isArchived guards both: an owner/admin caretaker reopening an archived
  // nest still can't delete (or ask to delete) from it, matching the
  // isReadOnly-gated Delete affordances on the nest/document list (NestView).
  const canDeleteDirectly =
    !isArchived &&
    (isOwner ||
      isAdmin ||
      permission === "owner" ||
      permission === "admin" ||
      authoredByMe);
  // Even ASKING for a deletion is an editor's act — a viewer of any kind (a
  // read collaborator, a viewer steward, a read share grantee) doesn't get the
  // action at all. Mirrors canRequestDeletion on the server, which refuses
  // them; hiding it means nobody clicks through a 403 for a request they were
  // never allowed to make.
  const canRequestDeletion =
    !isArchived &&
    (canDeleteDirectly ||
      permission === "write" ||
      grantCanWrite ||
      myNodeRoles.includes("editor") ||
      myStewards.some((s) => s.role === "editor" && s.scope === "nest"));
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [showDeletionModal, setShowDeletionModal] = useState(false);
  // Latest deletion flag on this doc. Pending hides the request button (a
  // second one would 409); declined stays visible with the note so the person
  // who asked sees the verdict instead of the flag just vanishing.
  const [deletionRequest, setDeletionRequest] =
    useState<api.DeletionRequest | null>(null);
  const deletionRequested = deletionRequest?.status === "pending";
  const [showDocPicker, setShowDocPicker] = useState(false);
  // CU-86ahmvmex: existing docs default to view mode; new docs to edit.
  const [mode, setMode] = useState<"view" | "edit">(isNew ? "edit" : "view");
  // Raw markdown source view — `content` is already markdown (the editor
  // serializes via tiptap-markdown), so this is just a textarea over the same
  // state. Editable in edit mode, read-only in view mode.
  const [rawMode, setRawMode] = useState(false);
  // New-document kind picker. "artifact" = paste raw HTML (hosted + annotated);
  // "document" = the normal markdown editor. Only meaningful while isNew.
  const [newType, setNewType] = useState<
    "document" | "artifact" | "agent" | "skill" | "tool" | "table"
  >("document");
  // Type switch that would reinterpret existing content — confirmed before
  // it's applied (see requestTypeChange below).
  const [pendingType, setPendingType] = useState<{
    value: "document" | "artifact" | "agent" | "skill" | "tool" | "table";
    label: string;
  } | null>(null);
  const isArtifactDraft = isNew && newType === "artifact";
  // How a type's body is interpreted — switching within the same class
  // (e.g. Document → Agent, both markdown prose) doesn't change how
  // existing content reads, so only a cross-class switch needs a warning.
  const typeBodyKind = (
    t: "document" | "artifact" | "agent" | "skill" | "tool" | "table",
  ): "markdown" | "html" | "csv" | "code" =>
    t === "artifact" ? "html" : t === "table" ? "csv" : t === "tool" ? "code" : "markdown";
  // New-doc Type switch: warn before applying when there's existing content
  // AND the new type reinterprets it differently (prose vs HTML vs CSV vs
  // code) — nothing to reinterpret on an empty draft, and same-class
  // switches (e.g. Document ↔ Agent) don't change how the body is read.
  const requestTypeChange = (
    value: "document" | "artifact" | "agent" | "skill" | "tool" | "table",
    label: string,
  ) => {
    if (
      value !== newType &&
      content.trim() &&
      typeBodyKind(value) !== typeBodyKind(newType)
    ) {
      setPendingType({ value, label });
      return;
    }
    setNewType(value);
  };
  // The node's kind for editor-surface decisions: the picked kind while
  // drafting, the loaded type once it exists.
  const effectiveType = isNew ? newType : (nodeType ?? "document");
  // Source-only kinds get NO WYSIWYG: a tool's body is code and a table's
  // body is CSV — TipTap's markdown round-trip mangles both. Edit mode is
  // always a monospace source editor; the rich/raw toggle is meaningless.
  const isSourceOnly = effectiveType === "tool" || effectiveType === "table";
  // Runnable = orchestrator-facing node (agent/skill) that carries a schedule.
  // For a new node it's the picked kind; for an existing one it's the loaded
  // type. Drives whether the schedule field shows and is sent on save.
  const isRunnable = isNew
    ? newType === "agent" || newType === "skill"
    : nodeType === "agent" || nodeType === "skill";
  // Orchestrator fetch URL for this nest's runnable nodes — shown inline on
  // agent/skill nodes so the user sees how an external scheduler pulls them.
  const serverOrigin =
    typeof window !== "undefined" ? window.location.origin : "";
  const runnablesUrl = `${serverOrigin}/nests/${nestId}/runnables`;
  const [copiedRunnables, setCopiedRunnables] = useState(false);
  const copyRunnablesUrl = async () => {
    if (!(await copyTextWithToast(runnablesUrl))) return;
    setCopiedRunnables(true);
    setTimeout(() => setCopiedRunnables(false), 1500);
  };
  // Inline anchored comments (annotations) parked beside the doc. commentMode
  // forces the rendered read view + highlight overlay even for editors, so
  // select-to-comment and painted highlights are reachable without TipTap
  // stealing focus. Backed by the same /annotations API the ArtifactViewer uses.
  const [commentMode, setCommentMode] = useState(false);
  const [pendingAnchor, setPendingAnchor] = useState<api.AnnotationAnchor | null>(null);
  const [selPopover, setSelPopover] = useState<{ x: number; y: number } | null>(null);
  // Anchor snapshotted at mouseup (selection is live then); consumed on click.
  const stagedAnchorRef = useRef<api.AnnotationAnchor | null>(null);
  const docViewRef = useRef<HTMLDivElement | null>(null);
  // The body wrapper, whichever control is inside it (rich editor, raw
  // markdown, source, artifact HTML) — Enter from the title lands here.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [anchoredThreads, setAnchoredThreads] = useState<api.AnnotationThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  // The comments rail starts closed — an empty panel beside every document
  // was a third of the width spent on nothing — and remembers the last
  // choice per browser. It opens itself for anything that needs it on
  // screen (see nextCommentsOpen); the panel stays MOUNTED while hidden so
  // thread loading, body highlights and deep-link focus keep working.
  const [commentsOpen, setCommentsOpenState] = useState(
    () => readDocPagePrefs(localStorage).commentsOpen,
  );
  const setCommentsOpen = (open: boolean) => {
    setCommentsOpenState(open);
    writeDocPagePrefs(localStorage, { commentsOpen: open });
  };
  // Outline for the right rail: view mode, markdown body, real structure.
  const outlineHeadings = useMemo(
    () => (mode === "view" && !looksLikeHtml(content) ? extractHeadings(content) : []),
    [mode, content],
  );
  const showOutline = !isNew && outlineHeadings.length >= 3;
  // The deep link forces the rail open only until it has been acted on (the
  // thread focused, or the user closed the rail) — the prop itself lives as
  // long as the page, and re-applying it after a close snapped the rail back.
  const initialThreadConsumedRef = useRef(false);
  useEffect(() => {
    setCommentsOpenState((open) =>
      nextCommentsOpen(open, {
        initialThreadId: initialThreadConsumedRef.current ? null : initialThreadId,
        commentMode,
        pendingAnchor: !!pendingAnchor,
        activeThreadId,
      }),
    );
  }, [initialThreadId, commentMode, pendingAnchor, activeThreadId]);
  const openThreadCount = anchoredThreads.filter((t) => t.status === "open").length;
  const anchorRangesRef = useRef<{ id: string; range: Range }[]>([]);
  const pendingFocusRef = useRef<string | null>(null);

  // Feed deep-link (?thread= / activity-feed click): once the rail has loaded
  // threads (reported via onThreadsChange) and the target exists, flip into
  // comment mode with that thread active. The rail scrolls the active thread
  // into view; pendingFocusRef scrolls the doc to its anchored quote once the
  // rendered view builds highlight ranges. Consumed once — later thread churn
  // (replies, resolves) must not re-yank the view.
  useEffect(() => {
    if (!initialThreadId || initialThreadConsumedRef.current) return;
    const hit = anchoredThreads.find((t) => t.id === initialThreadId);
    if (!hit) return;
    initialThreadConsumedRef.current = true;
    setCommentMode(true);
    setMode("view");
    setActiveThreadId(hit.id);
    if (hit.anchor?.quote) pendingFocusRef.current = hit.id;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchoredThreads, initialThreadId]);

  // Read the current selection inside the rendered doc and, if non-empty,
  // surface a floating "Comment" button at the selection. We build the anchor
  // HERE (mouseup), while the selection is guaranteed live, and stash it in
  // stagedAnchorRef — the button click just consumes it. Deferring the build
  // to the click loses selections the browser collapses over interactive/
  // structured nodes (links render as <a>/<button>, headings as block
  // elements), which is why the button used to do nothing on those.
  const onDocMouseUp = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelPopover(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const container = docViewRef.current;
    if (!container || !container.contains(range.commonAncestorContainer)) {
      setSelPopover(null);
      return;
    }
    if (!sel.toString().trim()) {
      setSelPopover(null);
      return;
    }

    // Turn the live selection into a resilient anchor: quote + up to 250c of
    // surrounding rendered text + a best-effort source line hint.
    //
    // Offsets come from the actual selection Range — NOT String.indexOf — so
    // that selecting the 2nd/3rd occurrence of a repeated phrase anchors to
    // that exact spot. We measure against the same flat text the read side
    // builds (raw text nodes concatenated in order, which is what
    // Range.toString() yields), so the `before` tail that
    // anchor-highlight.ts#locate uses to disambiguate matches stays consistent.
    const offsetOf = (node: Node, nodeOffset: number): number => {
      const r = document.createRange();
      r.setStart(container, 0);
      r.setEnd(node, nodeOffset);
      return r.toString().length;
    };
    const contents = document.createRange();
    contents.selectNodeContents(container);
    const full = contents.toString();
    let start = offsetOf(range.startContainer, range.startOffset);
    let end = offsetOf(range.endContainer, range.endOffset);
    if (start > end) [start, end] = [end, start];
    // Trim whitespace at the selection edges, keeping offsets in sync so the
    // quote and its context stay consistent with the flattened text.
    while (start < end && /\s/.test(full[start])) start++;
    while (end > start && /\s/.test(full[end - 1])) end--;
    const quote = full.slice(start, end);
    if (!quote) {
      setSelPopover(null);
      return;
    }
    const before = full.slice(Math.max(0, start - 250), start);
    const after = full.slice(end, end + 250);
    const srcIdx = content.indexOf(quote);
    const line = srcIdx >= 0 ? content.slice(0, srcIdx).split("\n").length : undefined;
    stagedAnchorRef.current = { quote, before, after, line };

    const rect = range.getBoundingClientRect();
    // Anchor the button just above the selection (viewport/fixed coords).
    setSelPopover({ x: rect.left + rect.width / 2, y: rect.top });
  }, [content]);

  // Consume the anchor snapshotted at mouseup (selection was live then) and
  // pin the pending comment to it.
  const stageAnchorFromSelection = useCallback(() => {
    const anchor = stagedAnchorRef.current;
    if (!anchor) return;
    setPendingAnchor(anchor);
    setSelPopover(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  // Rebuild the painted comment highlights whenever the doc text or the set
  // of anchored threads changes (and only in the rendered, non-diff view).
  useEffect(() => {
    const container = docViewRef.current;
    const inRenderedView =
      !isNew &&
      (commentMode || mode === "view") &&
      !rawMode &&
      compareVersion == null &&
      !looksLikeHtml(content);
    if (!container || !inRenderedView) {
      anchorRangesRef.current = [];
      clearHighlight("comment-anchor");
      clearHighlight("comment-anchor-active");
      return;
    }
    // Defer one frame so react-markdown has committed its DOM.
    const id = requestAnimationFrame(() => {
      const idx = buildTextIndex(container);
      const ranges: { id: string; range: Range }[] = [];
      for (const t of anchoredThreads) {
        if (!t.anchor?.quote) continue;
        const r = rangeForAnchor(container, idx, t.anchor);
        if (r) ranges.push({ id: t.id, range: r });
      }
      anchorRangesRef.current = ranges;
      setHighlight("comment-anchor", ranges.map((r) => r.range));
      // Deferred focus: a comment was clicked from edit mode; now that the
      // rendered view exists and ranges are built, scroll to + emphasize it.
      if (pendingFocusRef.current) {
        const hit = ranges.find((r) => r.id === pendingFocusRef.current);
        if (hit) {
          hit.range.startContainer.parentElement?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
          setActiveThreadId(hit.id);
        }
        pendingFocusRef.current = null;
      }
    });
    return () => cancelAnimationFrame(id);
  }, [anchoredThreads, content, mode, rawMode, compareVersion, isNew, commentMode]);

  // Paint the active thread's range brighter (doc ⇄ rail emphasis).
  useEffect(() => {
    const hit = anchorRangesRef.current.find((r) => r.id === activeThreadId);
    setHighlight("comment-anchor-active", hit ? [hit.range] : []);
  }, [activeThreadId]);

  // Jump to (and emphasize) an anchored quote when its thread is clicked.
  const focusAnchor = useCallback(
    (anchor: api.AnnotationAnchor) => {
      const hit = anchoredThreads.find(
        (t) => t.anchor?.quote === anchor.quote && t.anchor?.before === anchor.before,
      );
      if (hit) setActiveThreadId(hit.id);
      const range = anchorRangesRef.current.find((r) => r.id === hit?.id)?.range;
      if (range) {
        range.startContainer.parentElement?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
        return;
      }
      // Not rendered yet (we're in the editor) — drop into comment mode and let
      // the highlight effect scroll to it once ranges build.
      const inRenderedView = commentMode || mode === "view";
      if (!inRenderedView && !looksLikeHtml(content)) {
        pendingFocusRef.current = hit?.id ?? null;
        setCommentMode(true);
        setMode("view");
        return;
      }
      toast.message("That highlighted text isn't in the current version.");
    },
    [anchoredThreads, commentMode, mode, content],
  );

  // Map a click inside the rendered doc onto an anchored thread (if the click
  // landed on a highlighted span) and emphasize it in the rail.
  const onDocClick = useCallback((e: ReactMouseEvent) => {
    if (!anchorRangesRef.current.length) return;
    const caret = caretAt(e.clientX, e.clientY);
    if (!caret) return;
    for (const { id, range } of anchorRangesRef.current) {
      try {
        if (range.isPointInRange(caret.node, caret.offset)) {
          setActiveThreadId(id);
          return;
        }
      } catch {
        /* range detached after a re-render; ignore */
      }
    }
  }, []);

  // Pointer feedback: cursor becomes a pointer when hovering a commented span.
  const onDocMouseMove = useCallback((e: ReactMouseEvent) => {
    const container = docViewRef.current;
    if (!container) return;
    if (!anchorRangesRef.current.length) {
      container.style.cursor = "";
      return;
    }
    const caret = caretAt(e.clientX, e.clientY);
    let over = false;
    if (caret) {
      for (const { range } of anchorRangesRef.current) {
        try {
          if (range.isPointInRange(caret.node, caret.offset)) {
            over = true;
            break;
          }
        } catch {
          /* ignore detached range */
        }
      }
    }
    container.style.cursor = over ? "pointer" : "";
  }, []);

  // Dismiss the floating Comment button when the user clicks away from both
  // the selection and the button itself.
  useEffect(() => {
    if (!selPopover) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('[data-testid="selection-comment-button"]')) return;
      if (docViewRef.current?.contains(el)) return;
      setSelPopover(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [selPopover]);

  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  // New document: Title is the first required field — focus it on mount
  // instead of leaving focus to land in the body (MarkdownEditor skips its
  // own autofocus when isNew, see the `autofocus` prop below).
  useEffect(() => {
    if (isNew) titleInputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Last loaded/saved snapshot; drives isDirty for the leave-confirm path.
  const initialSnapshotRef = useRef<{
    title: string;
    content: string;
    tags: string[];
    schedule: string;
  }>({
    title: isNew && initialTitle ? initialTitle : "",
    content: "",
    tags: [],
    schedule: "",
  });

  // Title as it was last LOADED from the server — only updated by loadNode,
  // never by (auto)save. The rename warning compares against this so silent
  // autosave doesn't move the baseline out from under it and dismiss the
  // warning before the user sees it. (initialSnapshotRef tracks the saved
  // state and is mutated by every persist, so it's the wrong baseline here.)
  const loadedTitleRef = useRef<string>("");

  const [loading, setLoading] = useState(!isNew);
  // Cached nest node list (with content) — feeds both the backlinks panel
  // and wiki-link hover previews from one fetch. Best-effort.
  const [nestNodes, setNestNodes] = useState<
    Array<{ id: string; title: string; content?: string; tags?: string[] }>
  >([]);
  // The nest's folders, including any holding no document. Same cached census
  // the nest views read, so this costs no extra request in practice.
  const [nestFolders, setNestFolders] = useState<string[]>([]);
  useEffect(() => {
    if (loading) return;
    let cancelled = false;
    (async () => {
      try {
        const { census } = await qc.fetchQuery(reads.census(nestId));
        if (!cancelled) setNestFolders(census.folders.map((f) => f.path));
      } catch {
        /* best-effort: the picker still offers document-derived folders */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, nestId, qc]);
  useEffect(() => {
    // New docs need the list too — the folder picker derives its
    // suggestions from existing node ids.
    if (loading) return;
    let cancelled = false;
    (async () => {
      try {
        const { nodes } = await qc.fetchQuery(reads.nodes(nestId));
        if (!cancelled) {
          setNestNodes(
            nodes as Array<{
              id: string;
              title: string;
              content?: string;
              tags?: string[];
            }>,
          );
        }
      } catch {
        /* best-effort; list failures already surface elsewhere */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isNew, loading, nestId]);

  // Every folder the picker can offer: the prefixes documents sit under, plus
  // the nest's folder list — a folder created empty holds no document to
  // derive it from, so ids alone would hide it (CU-wdqcpzzzut).
  const folderOptions = useMemo(() => {
    const opts = new Set<string>(nestFolders);
    for (const n of nestNodes) {
      const rel = n.id.startsWith("nodes/") ? n.id.slice(6) : n.id;
      const segs = rel.split("/").slice(0, -1);
      for (let i = 1; i <= segs.length; i++) opts.add(segs.slice(0, i).join("/"));
    }
    return [...opts].sort();
  }, [nestNodes, nestFolders]);

  // Folder path this doc lives under (id minus the "nodes/" root and the leaf
  // slug), prettified for the header breadcrumb so users see where a nested
  // doc sits. Empty for new docs and docs directly under nodes/.
  const folderSegments = useMemo(() => {
    if (isNew || !nodeId) return [];
    const rel = nodeId.startsWith("nodes/") ? nodeId.slice(6) : nodeId;
    const raw = rel.split("/").slice(0, -1);
    return raw.map((seg, i) => ({
      // Raw cumulative path (matches NestView's folderFilter) + prettified label.
      path: raw.slice(0, i + 1).join("/"),
      label: prettyFolder(seg),
    }));
  }, [isNew, nodeId]);

  // Move to folder, from the open document — the same move the list row
  // offers, so nobody has to navigate back out to relocate what they're
  // reading. `null` = dialog closed.
  const [moveTo, setMoveTo] = useState<string | null>(null);
  // "Turn into…" — re-type an existing node. The picked type is staged in
  // the dialog until confirmed; the body is kept as-is, so the dialog says
  // what each target kind expects of it.
  const [turnInto, setTurnInto] = useState<string | null>(null);
  const [turningInto, setTurningInto] = useState(false);
  const turnIntoOptions = useMemo(() => {
    const all: Array<{ value: string; label: string; Icon: typeof FileText; expects: string }> = [
      { value: "document", label: "Document", Icon: FileText, expects: "Markdown prose." },
      ...(typeArtifactEnabled
        ? [{ value: "artifact", label: "Artifact", Icon: Code2, expects: "An HTML page — the body is hosted and rendered as-is." }]
        : []),
      ...(typeTableEnabled
        ? [{ value: "table", label: "Table", Icon: Table2, expects: "CSV — one header row, then data rows." }]
        : []),
      ...(workflowPlaneEnabled
        ? [
          { value: "agent", label: "Agent", Icon: Bot, expects: "Markdown instructions an orchestrator runs; can carry a schedule." },
          { value: "skill", label: "Skill", Icon: Zap, expects: "Markdown instructions with a trigger (defaulted from the title)." },
          { value: "tool", label: "Tool", Icon: Wrench, expects: "Source code, shown and edited as code." },
        ]
        : []),
    ];
    return all.filter((o) => o.value !== (nodeType ?? "document"));
  }, [typeArtifactEnabled, typeTableEnabled, workflowPlaneEnabled, nodeType]);
  const handleTurnInto = async () => {
    if (!turnInto || isNew) return;
    setTurningInto(true);
    try {
      await api.updateNode(nestId, nodeId, { type: turnInto });
      invalidateForPath(qc, `/nests/${nestId}/nodes/${nodeId}`);
      toast.success(`Turned into ${turnIntoOptions.find((o) => o.value === turnInto)?.label ?? turnInto}`);
      setTurnInto(null);
      // Reload so the page re-renders as the new kind (an artifact opens in
      // the artifact viewer; a table in the grid).
      await loadNode();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to convert");
    } finally {
      setTurningInto(false);
    }
  };
  const [moving, setMoving] = useState(false);
  const currentFolder = useMemo(() => {
    if (isNew || !nodeId) return "";
    const rel = nodeId.startsWith("nodes/") ? nodeId.slice(6) : nodeId;
    return rel.split("/").slice(0, -1).join("/");
  }, [isNew, nodeId]);

  // Docs in this nest that wiki-link to this one ("what links here").
  const backlinks = useMemo(
    () => (isNew ? [] : findBacklinks(nestNodes, { id: nodeId, title })),
    [isNew, nestNodes, nodeId, title],
  );

  // Related docs (shared tags + shared links) and link-discovery candidates
  // (docs that name this one in prose but never [[link]] it).
  const related = useMemo(
    () =>
      isNew
        ? []
        : relatedDocs({ id: nodeId, title, tags, content }, nestNodes),
    [isNew, nestNodes, nodeId, title, tags, content],
  );
  const unlinked = useMemo(
    () => (isNew ? [] : unlinkedMentions({ id: nodeId, title }, nestNodes)),
    [isNew, nestNodes, nodeId, title],
  );

  // Outgoing links here whose visible label is stale because the target doc
  // was renamed (`[[slug|Old Name]]`). Link still resolves; only the label
  // lags. Surfaced so the linking doc's author can refresh the labels.
  const staleLinks = useMemo(
    () => (isNew ? [] : staleAliasLinks(content, nestNodes)),
    [isNew, content, nestNodes],
  );

  // Hover-preview lookup for `[[wiki links]]` in the read view — resolves
  // against the cached list, no per-hover fetch.
  const previewFor = useCallback(
    (target: string) => {
      const node = resolveWikiTarget(nestNodes, target);
      if (!node) return null;
      return { title: node.title, snippet: previewSnippet(node.content ?? "") };
    },
    [nestNodes],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The document couldn't be loaded (stale link, deleted doc, no access). The
  // editor must not fall through to a blank, saveable document in that case.
  const [loadFailed, setLoadFailed] = useState(false);
  // User-edited flag; raw diff is unreliable because TipTap normalizes loaded HTML.
  const [touched, setTouched] = useState(false);

  // "Saved" hint on the Save button — set by an explicit save only. The server
  // is written on Save (or Save-and-leave); blur only parks a local draft.
  const [justSaved, setJustSaved] = useState(false);
  // Local draft couldn't be stored (quota exhausted / storage blocked).
  const [draftUnbacked, setDraftUnbacked] = useState(false);
  // When a parked local draft was put back on load — the restored body is not
  // what the server holds, and that used to be invisible (CU-wdqcpzzgz9).
  const [restoredDraftAt, setRestoredDraftAt] = useState<number | null>(null);


  const loadNode = useCallback(async () => {
    if (isNew) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      const { node } = await qc.fetchQuery(reads.node(nestId, nodeId));
      // Coerce to strings — YAML frontmatter can parse `title: 123` as a
      // number, and `title.trim()` later would throw "trim is not a function".
      const loadedTitle = node?.title == null ? "" : String(node.title);
      const loadedContent = node?.content == null ? "" : String(node.content);
      // Legacy tags were stored raw (leading #, mixed case), so they render
      // and compare differently from anything typed today. Canonicalise on load:
      // chips read consistently, the duplicate guard sees one key per tag, and
      // the next save migrates the document (CU-wdqcq00x8e).
      const loadedTags = Array.isArray(node?.tags)
        ? newTags([], node.tags.map((t: unknown) => tagKey(String(t))))
        : [];
      setTitle(loadedTitle);
      setContent(loadedContent);
      setTags(loadedTags);
      setNodeType(node?.type ?? null);
      const loadedSchedule =
        node?.schedule == null ? "" : String(node.schedule);
      setSchedule(loadedSchedule);
      const loadedPrime = typeof node?.prime === "boolean" ? node.prime : null;
      setPrime(loadedPrime);
      loadedPrimeRef.current = loadedPrime;
      setBaseVersion(node?.version);
      setStatus(node?.status ?? null);
      setAuthor(node?.author ?? null);
      setUpdatedAt(node?.updated_at ?? null);
      setCollaborators(
        Array.isArray(node?.collaborators)
          ? node.collaborators.map((e: unknown) => String(e))
          : [],
      );
      setPendingChange((node as any)?.pendingChange ?? null);
      setPendingReviewBy(
        ((node as any)?.pendingReviewBy as string | null | undefined) ?? null,
      );
      setDeletionRequest(((node as any)?.deletionRequest ?? null) as api.DeletionRequest | null);
      setMyGrant((((node as any)?.myGrant ?? null) as "read" | "write" | null));
      initialSnapshotRef.current = {
        title: loadedTitle,
        content: loadedContent,
        tags: loadedTags,
        schedule: loadedSchedule,
      };
      loadedTitleRef.current = loadedTitle;
      setTouched(false);
      // Restore unsaved edits parked in localStorage, but only if they were
      // taken from the version we just loaded — a newer server copy wins.
      const draft = readDraft(nestId, nodeId);
      setRestoredDraftAt(null);
      if (draft) {
        if (draft.baseVersion !== node?.version) {
          clearDraft(nestId, nodeId);
        } else {
          setTitle(draft.title);
          setContent(draft.content);
          setTags(draft.tags);
          setSchedule(draft.schedule);
          setTouched(true);
          setRestoredDraftAt(draft.savedAt ?? Date.now());
        }
      }
    } catch (err: any) {
      setError(err.message);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [isNew, nestId, nodeId]);

  const loadVersions = useCallback(async () => {
    if (isNew) {
      setVersionData(null);
      return;
    }
    try {
      setVersionData(await qc.fetchQuery(reads.nodeVersions(nestId, nodeId)));
    } catch (e: any) {
      console.error("[DocumentEditor] getNodeVersions failed", nestId, nodeId, e);
      setVersionData(null);
      toast.error(e?.message || "Failed to load version history");
    }
  }, [isNew, nestId, nodeId]);

  useEffect(() => {
    if (isNew) return;
    loadNode();
  }, [isNew, loadNode]);

  const openVersions = useCallback(async () => {
    setShowVersions(true);
    await loadVersions();
  }, [loadVersions]);

  // Throw away the unreviewed edits on this document.
  //
  // The outcome depends on the document and only the server can tell which:
  // one that was published before goes back to that version, one that never
  // was is deleted (there is nothing to fall back to). So the confirm names
  // both, and a delete navigates out rather than leaving the editor pointed at
  // a document that no longer exists.
  const [discarding, setDiscarding] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const handleDiscardDraft = useCallback(async () => {
    setConfirmDiscard(false);
    setDiscarding(true);
    try {
      // api.discardDraft clears the parked localStorage draft itself, so every
      // entry point gets that, not just this one.
      const res = await api.discardDraft(nestId, nodeId);
      if (res.deleted) {
        toast.success("Never approved — document deleted");
        onBack();
        return;
      }
      toast.success(`Draft discarded — back to version ${res.version}`);
      await Promise.all([loadNode(), loadVersions()]);
    } catch (e: any) {
      toast.error(e?.message || "Discard failed");
    } finally {
      setDiscarding(false);
    }
  }, [nestId, nodeId, title, onBack, loadNode, loadVersions]);

  // Load versions on demand when the Compare dropdown opens, so the list is
  // populated without forcing the user through the history modal first.
  const ensureVersions = useCallback(async () => {
    if (!versionData) await loadVersions();
  }, [versionData, loadVersions]);

  // The version list carries metadata only — getVersions returns content:""
  // because bodies live on disk — so the compared body has to be fetched, or
  // the diff runs against an empty base and paints the whole document green.
  const [compareBody, setCompareBody] = useState<{
    version: number;
    content: string;
  } | null>(null);
  const compareWith = useCallback(
    async (v: number | null) => {
      setCompareVersion(v);
      // Always reopen compare in the default Source view, and reset on exit.
      setDiffRendered(false);
      setCompareBody(null);
      if (v == null) return;
      try {
        const { content: body } = await api.getNodeVersionContent(
          nestId,
          nodeId,
          v,
        );
        setCompareBody({ version: v, content: body ?? "" });
      } catch (e: any) {
        toast.error(e?.message || `Failed to load version ${v}`);
        setCompareVersion(null);
      }
    },
    [nestId, nodeId],
  );
  // A pending-review doc is LOCKED: the server rejects edits/deletes with
  // 423 while a review is open (nodes/routes). Plain drafts stay editable —
  // only status==='pending_review' locks, so the editor flows normally until
  // a review is actually requested.
  //
  // Exception: the AUTHOR of the pending review may keep revising it. The
  // server accepts their edit and repoints the open review onto the new
  // draft (no withdraw/resubmit), so only OTHER users' pending reviews lock
  // the editor here.
  const isOwnPendingReview =
    status === "pending_review" &&
    !!pendingReviewBy &&
    !!currentEmail &&
    pendingReviewBy.toLowerCase() === currentEmail;
  const isLocked = status === "pending_review" && !isOwnPendingReview;
  // Existing document: the Type control is the Turn into entry point.
  const canTurnIntoHere = !isNew && !isLocked && turnIntoOptions.length > 0;
  const currentTypeValue = isNew ? newType : (nodeType ?? "document");

  // Fields read-only when locked or outside edit mode; "Start Editing" or
  // dblclick opts in (drafts only — a locked doc can't enter edit).
  const fieldsDisabled = isLocked || mode !== "edit";

  // Declared before isDirty so the save gate below can read it.
  const hasSaveableFields = useMemo(
    () => title.trim().length > 0 && content.trim().length > 0 && !saving,
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
    if (schedule.trim() !== snap.schedule.trim()) return true;
    if (prime !== loadedPrimeRef.current) return true;
    return false;
  }, [touched, title, content, tags, schedule, prime]);

  // Save is a no-op on a clean document (it would only bump the version), so
  // the button says so by being disabled — the enabled/disabled pair IS the
  // dirty indicator, alongside the badge in the header.
  const canSave = hasSaveableFields && (isNew || isDirty);

  // Set once the user has answered the leave dialog and the navigation is
  // going through — the browser-level guards below must not ask a second time.
  const leavingRef = useRef(false);
  // How many guard entries are parked in history right now. Back spends one
  // per press, and each press parks a replacement, so "leave for real" has to
  // walk back over all of them.
  const parkedRef = useRef(0);

  // Reloading or closing the tab with unsaved edits loses them — the in-app
  // leave dialog can't see a browser-level navigation, so hook it here too.
  useEffect(() => {
    if (!isDirty || isReviewerOnly) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leavingRef.current) return;
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty, isReviewerOnly]);

  // Anything that leaves this editor from the app chrome — the header logo,
  // the nav tabs, the account menu — asks first, the same way this component's
  // own back arrow does.
  useEffect(() => {
    setNavGuard((proceed) => {
      if (!isDirty || isReviewerOnly) return false;
      setLeaveIntent({ label: "leave this document", run: proceed });
      return true;
    });
    return () => setNavGuard(null);
  }, [isDirty, isReviewerOnly]);

  // Browser Back. The app keeps one history entry, so Back used to unload the
  // page — and a real unload can only ever raise the browser's own alert.
  // Parking a spare entry while the document is dirty turns Back into a
  // popstate we can answer with the same dialog every other exit uses.
  useEffect(() => {
    if (!isDirty || isReviewerOnly) return;
    leavingRef.current = false;
    parkedRef.current = 0;
    const park = () => {
      window.history.pushState({ cnLeaveGuard: true }, "");
      parkedRef.current++;
    };
    park();
    const onPop = () => {
      // The parked entry is spent; park another so a cancelled leave is still
      // caught, then ask. Back pressed again while the dialog is open spends
      // that one too, which is why the count is tracked rather than assumed —
      // leaving for real is every spare plus the page's own entry
      // (CU-wdqcq01k1u).
      parkedRef.current = Math.max(0, parkedRef.current - 1);
      park();
      // Keep the pending question: a second Back must not replace the dialog
      // the user is already answering, or its Save/Discard would resolve a
      // navigation that no longer exists.
      setLeaveIntent(
        (prev) =>
          prev ?? {
            label: "leave this page",
            run: () => {
              leavingRef.current = true;
              window.history.go(-(parkedRef.current + 1));
            },
          },
      );
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // Left by some other route (saved, discarded, navigated in-app): drop the
      // spare entries so Back still means Back.
      if (
        !leavingRef.current &&
        parkedRef.current > 0 &&
        (window.history.state as any)?.cnLeaveGuard
      ) {
        window.history.go(-parkedRef.current);
      }
    };
  }, [isDirty, isReviewerOnly]);

  // Feedback only — the schedule is saved exactly as typed either way (it's
  // opaque to this server; an external orchestrator parses it).
  const scheduleCheck = useMemo(() => validateSchedule(schedule), [schedule]);

  // Live artifact preview — the draft body is HTML nobody has hosted yet, so
  // it renders from srcDoc in the same opaque-origin sandbox the hosted
  // ArtifactViewer uses. Debounced: an iframe reload per keystroke is unusable.
  const [artifactPreview, setArtifactPreview] = useState("");
  useEffect(() => {
    if (!isArtifactDraft) return;
    const t = setTimeout(() => setArtifactPreview(content), 400);
    return () => clearTimeout(t);
  }, [content, isArtifactDraft]);

  // What the current input would commit, under the same policy addTag applies
  // (length cap, letters/digits/._- only, lowercased). Rendered under the
  // field so a truncation or rewrite is visible BEFORE Enter — a transient
  // toast after the fact is easy to miss, more so when several tags commit.
  // The tool preview highlights with lowlight's auto-detection, which tries
  // every grammar. Keyed on the live body that ran once per keystroke, on the
  // typing path. Deferred, React keeps the textarea responsive and re-highlights
  // when it has a spare frame — no debounce timer to tune or clean up.
  const deferredContent = useDeferredValue(content);

  const tagPreview = useMemo(() => {
    const candidates = tagInput.split(/[\s,]+/).map(normalizeTagInput);
    const accepted = candidates
      .map((c) => c.tag)
      .filter((t): t is string => !!t);
    return {
      // Already-present tags are dropped here, not at commit, so the preview
      // never promises to add something the commit would quietly discard.
      tags: newTags(tags, accepted),
      notes: candidates.map((c) => c.note).filter(Boolean) as string[],
    };
  }, [tagInput, tags]);

  const addTag = useCallback(() => {
    const { tags: accepted, notes } = tagPreview;
    // A paste commits several tags at once, and one transient toast per
    // rewrite is unreadable — stack them into a single summary and leave the
    // per-tag detail to the persistent preview above (CU-wdqcq00x8h).
    if (notes.length === 1) toast.warning(notes[0]);
    else if (notes.length > 1)
      toast.warning(`${notes.length} tags normalized`, {
        description: notes.join(" "),
        duration: 8000,
      });
    if (accepted.length === 0) {
      setTagInput("");
      return;
    }
    setTags([...tags, ...accepted]);
    setTagInput("");
    setTouched(true);
    // Local until Save — say so, or "added" reads as persisted.
    toast.success(
      accepted.length === 1 ? `Tag "${accepted[0]}" added` : `${accepted.length} tags added`,
      // One toast slot: adding tags one after another updates it instead of stacking.
      { id: "tag-added", description: "Save the document to keep it." },
    );
  }, [tagPreview, tags]);

  const removeTag = (t: string) => {
    setTags(tags.filter((x) => x !== t));
    setTouched(true);
  };

  const persistCurrent = async (): Promise<{
    ok: boolean;
    savedId?: string;
    noop?: boolean;
    // Only set for a fresh create — the resulting status (draft vs.
    // auto-published), so the caller can confirm what actually happened.
    createdStatus?: string;
  }> => {
    // No-op save: `isDirty` already normalizes title/content/tags/schedule/prime
    // against the loaded snapshot, so trust it here too instead of re-hashing —
    // skipping the request when nothing changed avoids stamping a new version
    // that only bumps `version`/`updated_at`.
    if (!isNew && !isDirty) {
      setTouched(false);
      toast.message(
        "Not saved — no changes were made. Edit the document, then save again.",
      );
      return { ok: true, savedId: nodeId, noop: true };
    }
    const payload = { title: title.trim(), content, tags };
    let savedId: string | undefined;
    let createdStatus: string | undefined;
    if (isNew) {
      const res = await api.createNode(nestId, {
        ...payload,
        type: newType,
        ...(folder.trim() ? { folder: folder.trim() } : {}),
        // schedule is server-rejected on non-runnable types, so only send it
        // for agent/skill drafts.
        ...(isRunnable ? { schedule: schedule.trim() } : {}),
        // Only sent when explicitly flagged — the server 403s a non-admin who
        // sends `prime` at all, so an inherited (null) flag stays off the wire.
        ...(prime === null ? {} : { prime }),
      });
      savedId = (res as any)?.node?.id;
      createdStatus = (res as any)?.node?.status;
    } else {
      const primePatch =
        prime === loadedPrimeRef.current ? {} : { prime };
      const res = await api.updateNode(
        nestId,
        nodeId,
        // Only runnable nodes accept schedule; "" clears it server-side.
        isRunnable
          ? { ...payload, ...primePatch, schedule: schedule.trim() }
          : { ...payload, ...primePatch },
        baseVersion,
      );
      loadedPrimeRef.current = prime;
      // Engine bumps version on publish; pick it up so next save's X-Base-Version matches.
      const nextVersion =
        (res as any)?.version ?? (res as any)?.node?.version;
      if (typeof nextVersion === "number") setBaseVersion(nextVersion);
      // The top bar's "Edited …" reads this; the save just moved it.
      setUpdatedAt((res as any)?.node?.updated_at ?? new Date().toISOString());
      savedId = nodeId;
    }
    initialSnapshotRef.current = {
      title: payload.title,
      content,
      tags: [...tags],
      schedule: schedule.trim(),
    };
    // Edits are on the server now; the local draft is spent.
    if (!isNew) clearDraft(nestId, nodeId);
    setTouched(false);
    setRestoredDraftAt(null);
    return { ok: true, savedId, ...(isNew ? { createdStatus } : {}) };
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
      const { savedId, noop, createdStatus } = await persistCurrent();
      // Skip the "Saved" checkmark on a no-op — the toast already told the
      // user nothing changed, and flashing "Saved" alongside it would be
      // contradictory.
      if (!noop) setJustSaved(true);
      // `afterSave` (below) navigates away on create (onSaved → back to the
      // nest), unmounting this editor before "Saved"/justSaved could ever be
      // seen — so a fresh create needs its own toast to confirm what actually
      // happened (published vs. saved as a draft awaiting review).
      if (isNew && savedId) {
        toast.success(
          createdStatus === "published"
            ? `"${title.trim() || "Untitled"}" published — it's now live and available for use.`
            : `"${title.trim() || "Untitled"}" saved as a draft.`,
        );
      }
      // The document is clean now, but React has not re-rendered yet: the
      // app-level nav guard registered by the effect below still closes over
      // isDirty === true. Without this, saving — which for a create navigates
      // straight back to the nest — reopened the "Unsaved changes" dialog for
      // the edits it had just written. A save is the answer to that question.
      bypassNavGuard(() => afterSave(savedId ?? ""));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => runSave((savedId) => onSaved?.(savedId));

  // Clear the "Saved" hint the moment the doc is edited again.
  useEffect(() => {
    if (isDirty) setJustSaved(false);
  }, [isDirty]);

  // Blur parks edits in localStorage, it does NOT hit the server. Blur-autosave
  // used to persist, which both spun up a version per field-exit and made the
  // leave dialog's "Discard" a lie (the edit was already written).
  // ponytail: blur-only draft write — a crash mid-typing loses that burst.
  // Move to a debounced effect on isDirty if that turns out to matter.
  const saveOnBlurRef = useRef<() => void>(() => { });
  saveOnBlurRef.current = () => {
    if (isNew) return;
    if (isLocked || isReviewerOnly || isViewOnly) return;
    if (!isDirty) return;
    const parked = writeDraft(nestId, nodeId, {
      title,
      content,
      tags: [...tags],
      schedule: schedule.trim(),
      baseVersion,
    });
    // Couldn't back the edits up locally — the leave dialog still guards
    // navigation, but a reload would lose them. Say so rather than pretend.
    setDraftUnbacked(!parked);
  };
  const saveOnBlur = useCallback(() => {
    saveOnBlurRef.current();
  }, []);

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
      // runSave already runs this continuation inside bypassNavGuard, so the
      // app-level guard cannot ask again about the navigation it just asked
      // about.
      intent?.();
    });

  /** Drop the parked draft AND put the loaded server copy back in the fields —
   *  a leave intent may navigate within this component (wiki link, breadcrumb)
   *  instead of unmounting it, and the restored-draft banner discards in place. */
  const revertToSaved = () => {
    if (!isNew) clearDraft(nestId, nodeId);
    const snap = initialSnapshotRef.current;
    setTitle(snap.title);
    setContent(snap.content);
    setTags([...snap.tags]);
    setSchedule(snap.schedule);
    setTouched(false);
    setRestoredDraftAt(null);
  };

  const handleLeaveDiscard = () => {
    if (!leaveIntent) return;
    const intent = leaveIntent.run;
    revertToSaved();
    setLeaveIntent(null);
    bypassNavGuard(intent);
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
  // Cancel your own pending review from the document itself — back to Draft,
  // rather than Delete being the only exit (CU-wdqcq007pe).
  const handleWithdrawSubmission = async () => {
    if (isNew) return;
    try {
      await api.cancelReview(nestId, nodeId);
      toast.success("Submission withdrawn — back to Draft");
      await loadNode();
    } catch (err: any) {
      console.error("[DocumentEditor] cancelReview failed", nestId, nodeId, err);
      toast.error(err?.message || "Failed to withdraw submission");
    }
  };
  // Flag this doc for deletion — for callers without delete permission. Errors
  // stay inside the dialog (it keeps the typed reason); success closes it.
  const handleRequestDeletion = async (reason: string) => {
    if (isNew) return;
    const { request } = await api.requestNodeDeletion(nestId, nodeId, reason);
    setDeletionRequest(request);
    toast.success("Deletion requested — a nest admin will review it");
  };

  // Delete outright (author / admin / owner). Leaves the page afterwards —
  // staying on a document that no longer exists just 404s the next fetch.
  const handleDeleteDocument = async () => {
    if (isNew) return;
    await api.deleteNode(nestId, nodeId);
    toast.success(`Deleted "${title || nodeId}"`);
    onBack();
  };

  const hasReviewerRole = myNodeRoles.includes("reviewer");

  // Mirrors server-side canUserApprove:
  //   admin (collaborator/steward) -> approve anything
  //   reviewer steward             -> approve
  //   bare owner                   -> ONLY when the nest allows self-approve
  // SoD: you can't approve a review YOU submitted — unless you're the owner
  // and the nest allows self-approve (the seeding switch).
  const isOwnSubmission = isOwnPendingReview;

  // Prime resolution mirrors the server (document → tag → nest). `primeByTag`
  // is what the doc would be WITHOUT its own flag, so the switch can tell an
  // override from an inherited value and clear the override when they agree.
  const primeByTag =
    primeTags.length > 0 &&
    tags.some((t) => primeTags.includes(t.trim().replace(/^#+/, "").toLowerCase()));
  const effectivePrime = prime === null ? primeByTag : prime;
  const canFlagPrime = isOwner || hasAdminApprove;
  const canApproveCapability =
    hasAdminApprove || hasReviewerRole || (isOwner && allowSelfApprove);
  const canReviewHere =
    !isNew &&
    status === "pending_review" &&
    canApproveCapability &&
    (!isOwnSubmission || (isOwner && allowSelfApprove));

  // A pending-review doc opens read-only for a reviewer, and the comment box
  // otherwise sits behind an easy-to-miss "turn on comment mode" affordance.
  // Default comment mode ON for them so they land ready to leave feedback.
  // The owner's own submission is excluded — they can still edit it, so the
  // rendered/comment view shouldn't be forced on top of that. Applied once
  // per doc (ref guard) so a manual toggle-off afterward isn't undone by
  // later re-renders of this effect.
  const defaultCommentModeAppliedRef = useRef(false);
  useEffect(() => {
    if (defaultCommentModeAppliedRef.current) return;
    if (loading || !rolesLoaded) return;
    defaultCommentModeAppliedRef.current = true;
    if (status === "pending_review" && isReviewerOnly) setCommentMode(true);
  }, [loading, rolesLoaded, status, isReviewerOnly]);

  // Always-editable surface ("buttery editor"): anyone who can edit drops
  // straight into the live editor instead of view → click → edit, which
  // remounts DocumentViewer→MarkdownEditor and loses the caret/reflows.
  // Read-only sessions (view-only / locked / reviewer) keep the rendered view.
  useEffect(() => {
    if (loading || mode === "edit" || commentMode) return;
    if (!isViewOnly && !isLocked && !isReviewerOnly) setMode("edit");
  }, [loading, isViewOnly, isLocked, isReviewerOnly, mode, commentMode]);

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
    editorRef.current?.insertWikiLink(node.id, node.title);
  };

  // `id` (the WikiLink decoration's cached existence check) is deliberately
  // NOT trusted here — it can go stale between when the decoration checked
  // and when the link is clicked (the target renamed/deleted meanwhile), and
  // a stale id blind-navigated straight to a 404'd "document not found" page
  // with no way back to the create flow. Always re-resolve against the live
  // node list and let decideWikiLinkAction decide navigate/create/blocked —
  // a broken link then always falls through to create (or a permission
  // message) instead of a dead end (CU-wdqcq02g17).
  const handleWikiLinkClick = async (linkTitle: string, _id: string | null) => {
    try {
      const { nodes } = await qc.fetchQuery(reads.nodes(nestId));
      const list = nodes as Array<{ id: string; title: string }>;
      const canAuthor = !isReviewerOnly && !isViewOnly;
      const action = decideWikiLinkAction(list, linkTitle, canAuthor);
      if (action.kind === "navigate") {
        confirmLeave(
          `open "${action.node.title}"`,
          () => onNavigateDocument?.(nestId, action.node.id, title),
        );
      } else if (action.kind === "create") {
        confirmLeave(
          `create "${action.title}"`,
          () => onCreateDocument?.(nestId, action.title),
        );
      } else {
        // Block create for reviewer/viewer/public-reader (no authoring).
        setError(
          `"${action.title}" doesn't exist in this nest. You only have view access — ask someone with edit rights to add it.`,
        );
      }
    } catch {
      // Search failed; don't auto-create on top of error.
    }
  };

  // A document that failed to load has nothing to edit. Rendering the editor
  // anyway gave a stale or mistyped link a blank, saveable document, which
  // quietly created a second document at that path.
  if (!isNew && !loading && loadFailed) {
    return (
      <div className="mt-14 md:mt-0" data-testid="document-not-found">
        <div className="max-w-xl mx-auto py-16 text-center space-y-4">
          <FileWarning className="h-10 w-10 mx-auto text-muted-foreground" />
          <h2 className="text-xl font-semibold">Document not found</h2>
          <p className="text-sm text-muted-foreground">
            {error ??
              `Nothing lives at ${nodeId} in this nest — the link may be stale or the document may have been moved or deleted.`}
          </p>
          <div className="flex items-center justify-center gap-2">
            <Button variant="outline" onClick={() => void loadNode()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Try again
            </Button>
            <Button onClick={onBack}>
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to documents
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Artifact nodes are hosted HTML, not markdown — render the sandboxed
  // viewer + annotation surface instead of the editor. Gated on a loaded node
  // so all hooks above still run unconditionally (rules-of-hooks).
  if (!isNew && !loading && nodeType === ARTIFACT_NODE_TYPE) {
    return (
      <ArtifactViewer
        nestId={nestId}
        nodeId={nodeId}
        title={title}
        snapshotVersion={null}
        currentEmail={currentEmail}
        viewOnly={isViewOnly}
        reviewerOnly={isReviewerOnly}
        initialThreadId={initialThreadId}
        onBack={onBack}
        onTurnedInto={() => {
          invalidateForPath(qc, `/nests/${nestId}/nodes/${nodeId}`);
          void loadNode();
        }}
      />
    );
  }

  return (
    <div className="flex min-h-full flex-col" data-testid="document-page">
      {/* Top bar — one row, Notion-style: where you are on the left, what you
          can do with the document on the right. Sticky so the actions stay
          reachable at any scroll depth; the body scrolls with the window. */}
      <div
        className="sticky top-16 z-30 flex h-12 items-center gap-2 border-b bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-3"
        data-testid="document-editor-topbar"
      >
        <div className="flex items-center gap-1 min-w-0 flex-1">
          {/* Bring the index back once it has been hidden. (On a phone the
              app header carries the drawer toggle for every page.) */}
          {sidebarCollapsed && onToggleSidebar && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={onToggleSidebar}
              title="Show sidebar"
              aria-label="Show sidebar"
              data-testid="document-sidebar-expand"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => confirmLeave("go back", onBack)}
            title="Back to documents"
            data-testid="document-editor-back"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          {/* Chain: nest > ancestors… > doc. Chip click truncates chain. */}
          {/* One line: the trail truncates rather than wrapping the bar. */}
          <div className="flex items-center gap-2 min-w-0 flex-nowrap overflow-hidden">
            <button
              type="button"
              onClick={() =>
                onOpenNest && confirmLeave("go to the nest", onOpenNest)
              }
              disabled={!onOpenNest}
              className="text-sm text-muted-foreground truncate hover:text-foreground hover:underline underline-offset-2 disabled:no-underline disabled:hover:text-muted-foreground disabled:cursor-default"
              title={onOpenNest ? `Open ${nestName}` : nestName}
            >
              {nestName}
            </button>
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
            {/* Folder path (nested docs only) so the location is visible. */}
            {folderSegments.map((seg, i) => (
              <Fragment key={`folder-${i}`}>
                <span className="text-muted-foreground shrink-0">›</span>
                <button
                  type="button"
                  onClick={() =>
                    onOpenFolder &&
                    confirmLeave(`open "${seg.label}"`, () =>
                      onOpenFolder(seg.path),
                    )
                  }
                  disabled={!onOpenFolder}
                  className="text-sm text-muted-foreground truncate max-w-[160px] hover:text-foreground hover:underline underline-offset-2 disabled:no-underline disabled:hover:text-muted-foreground disabled:cursor-default"
                  title={seg.path}
                >
                  {seg.label}
                </button>
              </Fragment>
            ))}
            {/* The document's own name is deliberately NOT repeated here: the
                Title field sits directly below (an <h1> in view mode), so the
                trail ended in the same string the next line already shows. The
                crumbs answer "where am I", the field answers "what is this". */}
            {!isNew && status && <StatusBadge status={status} />}
            {/* Pending only. A DECLINED flag is a past event, not a state of
                the document — badging it forever nags everyone who opens a doc
                that is very much alive, with no way to dismiss it. The verdict
                reaches the requester as a notification (which has read state),
                and anyone re-flagging sees it in the request dialog. */}
            {!isNew && deletionRequested && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs border bg-red-50 text-red-700 border-red-200 whitespace-nowrap"
                title={`${deletionRequest!.requestedBy} asked for this to be deleted: "${deletionRequest!.reason}". A nest admin decides.`}
                data-testid="deletion-requested-badge"
              >
                <Trash2 className="h-3 w-3" />
                Deletion requested
              </span>
            )}
            {!isNew && !stewardshipEnabled && status === "published" && (
              <span
                className="hidden sm:inline px-1.5 py-0.5 rounded text-xs bg-green-50 text-green-700 border border-green-200 whitespace-nowrap"
                title="Stewardship off — saving auto-publishes."
              >
                Auto-published
              </span>
            )}
            {/* "Unsaved changes" moved to the sticky action bar at the bottom,
                where it sits beside the Save button it is about. */}
          </div>
        </div>
        {/* Right side: state, then every action. The write actions (Save,
            Submit, Discard) used to sit in a sticky footer under the form;
            with the document as the page there is no form, and the top bar
            is where every editor keeps them. */}
        <div
          className="flex items-center gap-1 shrink-0"
          data-testid="document-editor-actions"
        >
          {(() => {
            // One line of state: unsaved > saving > just saved > last edit.
            if (isDirty)
              return (
                <span
                  className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs border bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900"
                  title="These edits are parked locally and not yet saved to the nest."
                  data-testid="document-editor-dirty-badge"
                >
                  <Pencil className="h-3 w-3" />
                  Unsaved changes
                </span>
              );
            const text = saving
              ? "Saving…"
              : justSaved
                ? "Saved"
                : updatedAt
                  ? `Edited ${relTime(updatedAt)}`
                  : null;
            return text ? (
              <span
                className="hidden sm:inline px-1.5 text-xs text-muted-foreground"
                title={updatedAt ? formatServerDate(updatedAt) : undefined}
              >
                {text}
              </span>
            ) : null;
          })()}
          {/* NOT gated on isViewOnly: that flag answers "may this caller
              author?", and a reviewer-only steward is view-only by definition
              yet is exactly the person meant to act here. Gating approval on it
              hid Approve/Reject from every reviewer who was not also an editor,
              leaving the document page with no way to resolve a review.
              canReviewHere already carries the full approval check. */}
          {canReviewHere && (
            <ReviewActions
              documentTitle={title}
              version={baseVersion ?? 1}
              onApprove={handleApprove}
              onReject={handleReject}
            />
          )}
          {/* Visibility — the nest's tier, right where Notion puts it. An
              owner/admin flips it in place (same control as the Share dialog
              and Collaborators tab); everyone else sees a read-only badge. */}
          {!isNew &&
            (canShare && !isArchived ? (
              <NestVisibilityControl
                nestId={nestId}
                variant="compact"
                onChanged={() => void qc.invalidateQueries({ queryKey: keys.nest(nestId) })}
                onError={(m) => {
                  if (m) toast.error(m);
                }}
              />
            ) : (
              nestMeta.data?.nest?.visibility && (
                <span
                  className="hidden sm:inline-flex items-center gap-1 px-1.5 text-xs text-muted-foreground"
                  title={
                    nestMeta.data.nest.visibility === "public"
                      ? "Public — anyone with the URL can read"
                      : nestMeta.data.nest.visibility === "org"
                        ? "Organization — everyone signed in here can read"
                        : "Private"
                  }
                  data-testid="document-editor-visibility"
                >
                  {nestMeta.data.nest.visibility === "public" ? (
                    <Globe className="h-3.5 w-3.5" />
                  ) : nestMeta.data.nest.visibility === "org" ? (
                    <Building2 className="h-3.5 w-3.5" />
                  ) : (
                    <Lock className="h-3.5 w-3.5" />
                  )}
                  {nestMeta.data.nest.visibility === "public"
                    ? "Public"
                    : nestMeta.data.nest.visibility === "org"
                      ? "Organization"
                      : "Private"}
                </span>
              )
            ))}
          {canShare && !isArchived && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8"
              onClick={() => setShowShare(true)}
              title="Share this nest — people, teams, visibility"
              data-testid="document-editor-share"
            >
              <Users className="h-4 w-4 sm:mr-1.5" />
              <span className="hidden sm:inline">Share</span>
            </Button>
          )}
          {/* Comments — toggles the rail. The count is open threads. Closing
              also leaves comment mode, or the rail would reopen itself. */}
          {!isNew && (
            <Button
              variant={commentsOpen ? "secondary" : "ghost"}
              size="sm"
              className="h-8"
              aria-pressed={commentsOpen}
              onClick={() => {
                if (commentsOpen) {
                  // A user close beats the deep link from here on.
                  initialThreadConsumedRef.current = true;
                  setCommentMode(false);
                  setActiveThreadId(null);
                  setPendingAnchor(null);
                  setSelPopover(null);
                }
                setCommentsOpen(!commentsOpen);
              }}
              title={commentsOpen ? "Hide comments" : "Show comments"}
              data-testid="document-editor-comments-toggle"
            >
              <MessageSquare className="h-4 w-4" />
              {openThreadCount > 0 && (
                <span className="ml-1 text-xs tabular-nums">{openThreadCount}</span>
              )}
            </Button>
          )}
          {/* Compare ▾ — pick a past version; the doc area renders an
              ever-present current↔vN diff inline (no modal). */}
          {!isNew && (
            <DropdownMenu
              onOpenChange={(o) => {
                if (o) ensureVersions();
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  variant={compareVersion != null ? "secondary" : "ghost"}
                  size="sm"
                  className="h-8"
                  title="Compare with a past version"
                  data-testid="document-editor-compare"
                >
                  <GitCompare className="h-4 w-4" />
                  <span className={compareVersion != null ? "ml-1" : "hidden xl:inline ml-1"}>
                    {compareVersion != null ? `Comparing v${compareVersion}` : "Compare"}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 ml-0.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 max-h-80 overflow-y-auto">
                <DropdownMenuLabel>Diff current against…</DropdownMenuLabel>
                {compareVersion != null && (
                  <>
                    <DropdownMenuItem onClick={() => void compareWith(null)}>
                      <X className="h-4 w-4 mr-2" /> Exit compare
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                {!versionData ? (
                  <DropdownMenuItem disabled>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Loading…
                  </DropdownMenuItem>
                ) : versionData.versions.filter(
                  (v) => v.version !== versionData.currentVersion,
                ).length === 0 ? (
                  <DropdownMenuItem disabled>No earlier versions</DropdownMenuItem>
                ) : (
                  versionData.versions
                    .filter((v) => v.version !== versionData.currentVersion)
                    .map((v) => (
                      <DropdownMenuItem
                        key={v.version}
                        onClick={() => void compareWith(v.version)}
                      >
                        {compareVersion === v.version ? (
                          <Check className="h-4 w-4 mr-2" />
                        ) : (
                          <span className="w-4 mr-2" />
                        )}
                        v{v.version}
                        {/* Author AND when — "v3 · taimur" alone gives no way
                            to tell which past version you are reaching for.
                            Same editedAt Version History already renders. */}
                        <span
                          className="ml-auto text-xs text-muted-foreground"
                          title={v.editedAt ? formatServerDate(v.editedAt) : undefined}
                        >
                          {[v.editedBy?.split("@")[0], relTime(v.editedAt)]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </DropdownMenuItem>
                    ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* Secondary actions collapse into one ⋮ menu to keep the header
              uncluttered. Grouped by use: version history, then sharing
              (copy link, share nest). Compare stays
              a visible button because it carries active "Comparing vN" state
              the flat menu can't surface. */}
          {(() => {
            const moreActions: OverflowAction[] = [];
            if (!isNew)
              moreActions.push({
                label: "Version history",
                icon: History,
                testId: "document-editor-history",
                onSelect: openVersions,
              });
            if (!isNew)
              moreActions.push({
                label: "Copy link",
                icon: LinkIcon,
                separatorBefore: true,
                testId: "document-editor-copy-link",
                onSelect: () => {
                  const url = `${window.location.origin}${nestPath(nestId)}?doc=${encodeURIComponent(nodeId)}`;
                  void copyTextWithToast(
                    url,
                    "Link copied — recipient needs access to this nest",
                  );
                },
              });
            if (!isNew && canEditContent && !isLocked)
              moreActions.push({
                label: "Move to folder",
                icon: FolderInput,
                testId: "document-editor-move",
                onSelect: () => setMoveTo(currentFolder),
              });
            // Share THIS doc first — it's the narrower, more common ask.
            // Meaningless on an unsaved doc: there's no node id to grant on.
            // Sharing the whole nest is the top bar's Share button; only the
            // narrower per-document grant lives here.
            if (canShare && !isNew && !isArchived)
              moreActions.push({
                label: "Share this document",
                icon: Share2,
                separatorBefore: true,
                testId: "document-editor-share-doc",
                onSelect: () => setShowShareDoc(true),
              });
            // Publishing hosts THIS document on the open web, so it sits with
            // sharing rather than with the editing actions above.
            if (canShare && !isNew && !isArchived)
              moreActions.push({
                label: "Publish",
                icon: Share2,
                testId: "document-editor-publish",
                onSelect: () => setShowPublish(true),
              });
            // Below admin only: this opens the REQUEST dialog, not a delete.
            // Admins delete from the nest list — this page has never carried a
            // real delete. Hidden once a flag is already pending.
            // One Delete entry: the author (and the admin/owner tier) deletes
            // outright, everyone else raises a request. Hidden below that tier
            // once a flag is already open.
            const showDelete =
              !isNew && canRequestDeletion && (canDeleteDirectly || !deletionRequested);
            if (showDelete)
              moreActions.push({
                label: "Delete",
                icon: Trash2,
                separatorBefore: true,
                destructive: canDeleteDirectly,
                testId: canDeleteDirectly
                  ? "document-editor-delete"
                  : "document-editor-request-deletion",
                onSelect: () => setShowDeletionModal(true),
              });
            // Withdraw: only shown to the original requester while the request
            // is still pending — lets them undo an accidental flag without
            // waiting for an admin to decline it.
            const isOwnDeletionRequest =
              deletionRequested &&
              deletionRequest?.requestedBy?.toLowerCase() === currentEmail;
            if (!isNew && isOwnDeletionRequest)
              moreActions.push({
                label: "Withdraw deletion request",
                icon: X,
                // Withdraw belongs with Delete in the destructive group, so it
                // only opens that group when Delete isn't there to open it.
                separatorBefore: !showDelete,
                testId: "document-editor-withdraw-deletion",
                onSelect: async () => {
                  try {
                    await api.withdrawDeletionRequest(nestId, deletionRequest!.id);
                    setDeletionRequest(null);
                    toast.success("Deletion request withdrawn");
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Failed to withdraw request");
                  }
                },
              });
            return moreActions.length ? (
              <OverflowMenu
                actions={moreActions}
                variant="ghost"
                testId="document-editor-more"
              />
            ) : null;
          })()}
          {/* View mode: Submit for review and Edit up here. In edit mode the
              sticky bar at the bottom of the document carries Submit + Save. */}
          {mode !== "edit" && (
            <>
              {!isViewOnly && canSubmitForReview && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => setShowSubmitModal(true)}
                  data-testid="document-editor-submit"
                  title="Requires steward approval — with stewardship on, publishing in this nest submits the document for steward review."
                >
                  <Send className="h-4 w-4 sm:mr-1.5" />
                  <span className="hidden sm:inline">Submit for review</span>
                </Button>
              )}
              {!isViewOnly && !isReviewerOnly && !isLocked && (
                <Button
                  size="sm"
                  className="h-8"
                  onClick={() => setMode("edit")}
                  data-testid="document-editor-start-edit"
                >
                  <Pencil className="h-4 w-4 mr-1.5" />
                  Edit
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Body: a reading-width column (the document) with the comments rail
          beside it when open. */}
      <div className="flex flex-1 flex-col items-stretch lg:flex-row lg:items-start">
        {/* The column is at least a window tall so the action bar sits at the
            window bottom on a short document too (mt-auto), and sticks there
            while a long one scrolls under it. 7rem = app header + top bar. */}
        <div className="flex min-w-0 flex-1 flex-col min-h-[calc(100vh-7rem)]">
          <div className="w-full px-5 py-6 sm:px-10 sm:py-8">

            {error && (
              <Alert variant="destructive" className="mb-4">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {restoredDraftAt !== null && (
              <Alert className="mb-4 border-amber-300 bg-amber-50 text-amber-800">
                <AlertCircle className="h-4 w-4 text-amber-600" />
                <AlertDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-amber-800">
                  <span>
                    Unsaved edits from this browser
                    {" ("}
                    {new Date(restoredDraftAt).toLocaleString()}
                    {") "}
                    were restored — the saved document still says something else.
                  </span>
                  <button
                    type="button"
                    onClick={revertToSaved}
                    className="font-medium underline underline-offset-2 hover:no-underline"
                    data-testid="discard-restored-draft"
                  >
                    Discard them
                  </button>
                </AlertDescription>
              </Alert>
            )}

            {draftUnbacked && isDirty && (
              <Alert className="mb-4 border-amber-300 bg-amber-50 text-amber-800">
                <AlertCircle className="h-4 w-4 text-amber-600" />
                <AlertDescription className="text-amber-800">
                  This browser couldn't store a local backup of your unsaved edits
                  (storage is full or blocked). Save the document — a page reload
                  would lose them.
                </AlertDescription>
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

                {isOwnPendingReview && (
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="flex-1 min-w-[16rem]">
                        This is still under review. Your edits update the same pending
                        submission — no need to withdraw and resubmit — and the steward
                        reviews your latest version.
                      </span>
                      {/* Withdraw belongs with the sentence explaining the state, not
                    in the header's action row (CU-wdqcq007pe). */}
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => void handleWithdrawSubmission()}
                        data-testid="document-editor-withdraw"
                        title="Withdraw this submission and return the document to Draft"
                      >
                        <Undo2 className="h-3.5 w-3.5 mr-1.5" />
                        Withdraw
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}

                {/* Title — the page's h1, and the field that edits it, are one
              thing (Notion-style): a borderless heading that takes the caret.
              Read-only sessions get a plain h1. */}
                <div>
                  {mode === "view" && !isNew ? (
                    <h1
                      className="text-4xl font-bold leading-tight tracking-tight text-foreground"
                      data-testid="document-editor-title"
                    >
                      {title || (loading ? "Loading…" : "Untitled")}
                    </h1>
                  ) : (
                    <>
                      <input
                        id="document-editor-title"
                        ref={titleInputRef}
                        value={title}
                        onChange={(e) => {
                          setTitle(e.target.value);
                          setTouched(true);
                        }}
                        onBlur={saveOnBlur}
                        onKeyDown={(e) => {
                          // Enter moves on to the body, like a heading would. The
                          // rich editor when it's mounted; otherwise whatever body
                          // control is (raw markdown, tool/table source, artifact
                          // HTML).
                          if (e.key === "Enter") {
                            e.preventDefault();
                            if (editorRef.current) editorRef.current.focus();
                            else
                              bodyRef.current
                                ?.querySelector<HTMLElement>(
                                  'textarea, [contenteditable="true"], input',
                                )
                                ?.focus();
                          }
                        }}
                        placeholder="Untitled"
                        // Mirrors MAX_TITLE_LENGTH in src/nodes/service.ts — a hard
                        // stop here so the server's 400 is unreachable from the UI.
                        // maxLength never truncates an existing longer value, so
                        // grandfathered titles still load and save.
                        maxLength={120}
                        disabled={fieldsDisabled}
                        required
                        aria-required="true"
                        aria-label="Title"
                        aria-invalid={touched && !title.trim() ? true : undefined}
                        data-testid="document-editor-title"
                        className={`block w-full bg-transparent text-4xl font-bold leading-tight tracking-tight text-foreground outline-none border-b border-border pb-1 focus:border-primary placeholder:text-muted-foreground/50 disabled:opacity-100${touched && !title.trim() ? " placeholder:text-destructive/60" : ""
                          }`}
                      />
                      {((touched && !title.trim()) || title.length >= 90) && (
                        <div className="mt-1 flex items-start justify-between gap-2 text-xs">
                          <span className="text-destructive">
                            {touched && !title.trim() ? "Title is required" : ""}
                          </span>
                          <span className="text-muted-foreground tabular-nums">
                            {title.length >= 90 ? `${title.length}/120` : ""}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                  {/* Rename safety: links referencing this doc by its old title
                either break ([[Old Title]]) or go stale ([[slug|Old Title]] —
                still resolves but keeps showing the old name). Compare against
                the LAST LOADED title (loadedTitleRef), not the saved snapshot —
                autosave keeps moving the snapshot, which would dismiss the
                warning ~1.2s after typing. */}
                  {!isNew &&
                    mode === "edit" &&
                    title.trim() !== loadedTitleRef.current.trim() &&
                    (() => {
                      const affected = renameImpactBacklinks(nestNodes, {
                        id: nodeId,
                        title: loadedTitleRef.current,
                      });
                      if (affected.length === 0) return null;
                      return (
                        <Alert className="mt-2 border-amber-300 bg-amber-50 text-amber-800">
                          <div className="flex items-center gap-2">
                            <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
                            <AlertDescription className="text-amber-800">
                              Renaming affects {affected.length} wiki link
                              {affected.length !== 1 ? "s" : ""} in other documents that
                              reference this one by its old title (
                              {affected
                                .slice(0, 3)
                                .map((a) => a.title)
                                .join(", ")}
                              {affected.length > 3 ? ", …" : ""}
                              ). Links by slug still resolve, but their visible label
                              keeps the old name; plain [[title]] links break.
                            </AlertDescription>
                          </div>
                        </Alert>
                      );
                    })()}
                </div>

                {/* Stale outgoing-link labels: a doc this one links to was renamed,
              so the [[slug|Old Name]] label here lags. Link still resolves. */}
                {!isNew && staleLinks.length > 0 && (
                  <Alert className="border-amber-300 bg-amber-50 text-amber-800">
                    <div className="flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 shrink-0 text-amber-600" />
                      <AlertDescription className="text-amber-800">
                        {staleLinks.length} link{staleLinks.length !== 1 ? "s" : ""} in
                        this document show an outdated name — the target document
                        {staleLinks.length !== 1 ? "s were" : " was"} renamed (
                        {staleLinks
                          .slice(0, 3)
                          .map((s) => `"${s.shownAs}" → "${s.currentTitle}"`)
                          .join(", ")}
                        {staleLinks.length > 3 ? ", …" : ""}
                        ). The links still work; only the visible label is out of date.
                      </AlertDescription>
                    </div>
                  </Alert>
                )}

                {/* Folder (create-only): files the doc under nodes/<path>/.
              Breadcrumbed selector — walk into existing folders level by
              level or add a new subfolder at the current level; no raw path
              typing. */}
                {isNew && (
                  <div>
                    <label className="block mb-1 text-sm font-medium">Folder</label>
                    <div
                      className="flex items-center flex-wrap gap-1 rounded-md border px-2 py-1.5 min-h-9"
                      data-testid="document-editor-folder-input"
                    >
                      <button
                        type="button"
                        disabled={fieldsDisabled}
                        onClick={() => {
                          setFolder("");
                          setTouched(true);
                        }}
                        className={`text-sm rounded px-1.5 py-0.5 ${folder ? "text-primary hover:bg-muted" : "font-medium bg-muted"
                          }`}
                        title="File directly under the nest root"
                      >
                        Root
                      </button>
                      {folder.split("/").filter(Boolean).map((seg, i, arr) => {
                        const path = arr.slice(0, i + 1).join("/");
                        const parent = arr.slice(0, i).join("/");
                        const isLast = i === arr.length - 1;
                        return (
                          <span key={path} className="flex items-center gap-1">
                            <span className="text-muted-foreground/50 text-sm">/</span>
                            <span
                              className={`flex items-center rounded ${isLast ? "bg-muted" : ""
                                }`}
                            >
                              <button
                                type="button"
                                disabled={fieldsDisabled}
                                onClick={() => {
                                  setFolder(path);
                                  setTouched(true);
                                }}
                                className={`text-sm rounded px-1.5 py-0.5 ${isLast
                                  ? "font-medium"
                                  : "text-primary hover:bg-muted"
                                  }`}
                                title={`Scope to ${path}`}
                              >
                                {prettyFolder(seg)}
                              </button>
                              {/* Step OUT one level — pops just this (current) segment
                            to its parent, so a deep path can be walked back up
                            without jumping all the way to Root via the X. */}
                              {isLast && (
                                <button
                                  type="button"
                                  disabled={fieldsDisabled}
                                  onClick={() => {
                                    setFolder(parent);
                                    setTouched(true);
                                  }}
                                  className="mr-0.5 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-background"
                                  title={
                                    parent
                                      ? `Go up to ${parent}`
                                      : "Go up to the nest root"
                                  }
                                  data-testid="folder-step-up"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              )}
                            </span>
                          </span>
                        );
                      })}
                      <FolderStepPicker
                        folder={folder}
                        folderOptions={folderOptions}
                        disabled={fieldsDisabled}
                        onPick={(next) => {
                          setFolder(next);
                          setTouched(true);
                        }}
                      />
                      {folder && (
                        <button
                          type="button"
                          disabled={fieldsDisabled}
                          onClick={() => {
                            setFolder("");
                            setTouched(true);
                          }}
                          className="ml-auto text-muted-foreground hover:text-foreground"
                          title="Clear folder (file under the nest root)"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Tags — hide the editor controls (input + Add) for anyone who
              can't author here (view-only, plus reviewer/viewer stewards);
              they see only the existing tag chips. */}
                {(canEditContent || tags.length > 0) && (
                  <div>
                    {/* Tags: an underlined "Add a tag" field (Enter, space or comma
                  commit, as the old input did), then the chips on their own row
                  beneath it. */}
                    <div className="space-y-2">
                      {canEditContent && !fieldsDisabled && (
                        <input
                          value={tagInput}
                          onChange={(e) => setTagInput(clampTagInput(e.target.value))}
                          onKeyDown={(e) => {
                            // Space/comma/Enter all commit (pasted "#one #two" or "tag, tag").
                            if (e.key === "Enter" || e.key === "," || e.key === " ") {
                              e.preventDefault();
                              addTag();
                            }
                          }}
                          onBlur={() => {
                            if (tagInput.trim()) addTag();
                          }}
                          placeholder={tags.length ? "Add a tag" : "Add a tag…"}
                          // A hard stop the way Title has one — several tags fit,
                          // a pasted paragraph does not.
                          maxLength={TAG_INPUT_MAX_LENGTH}
                          aria-label="Add a tag"
                          className="block h-8 w-full border-b border-border bg-transparent px-1 text-sm outline-none focus:border-primary placeholder:text-muted-foreground/70 focus:placeholder:text-muted-foreground"
                          data-testid="document-editor-tag-input"
                        />
                      )}
                      {tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
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
                                title={tagClickable ? `Filter nest by ${t}` : t}
                              >
                                {/* Long tags truncate rather than eat the row; the
                            full value stays in the chip's title. */}
                                <span className="truncate max-w-[16rem]">{t}</span>
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
                    {tagInput.trim() && (
                      <p
                        className="mt-1 text-xs text-muted-foreground"
                        data-testid="document-editor-tag-preview"
                      >
                        {tagPreview.tags.length > 0
                          ? `Will add: ${tagPreview.tags.join(", ")}`
                          : "Nothing new to add"}
                        {tagPreview.notes.length > 0 &&
                          ` — ${tagPreview.notes.join(" ")}`}
                      </p>
                    )}
                  </div>
                )}

                {/* Prime — governed nests only, and only for the roles allowed to
              set it. Everyone else just sees the badge next to the title. */}
                {stewardshipEnabled && canFlagPrime && (
                  <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
                    <div className="space-y-0.5">
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        <Star className="h-4 w-4" />
                        Prime document
                      </span>
                      <p className="text-xs text-muted-foreground">
                        {primeByTag && prime === null
                          ? "Inherited from a prime tag on this document — it always needs steward approval."
                          : "Always require steward approval for this document, even from an owner or admin with auto-publish on."}
                      </p>
                      {primeByTag && prime === false && (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          Exempted from its prime tag.
                        </p>
                      )}
                      {/* The one case people get wrong: an owner with auto-publish on
                    expects their edit to go live, and on a prime doc it won't. */}
                      {effectivePrime && allowSelfApprove && (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          Overrides auto-publish — your edits here queue for review
                          like everyone else&rsquo;s.
                        </p>
                      )}
                    </div>
                    <Switch
                      checked={effectivePrime}
                      disabled={fieldsDisabled}
                      onCheckedChange={(next) => {
                        // Turning the switch back to whatever the tags already imply
                        // clears the override rather than pinning a redundant flag.
                        setPrime(next === primeByTag ? null : next);
                        setTouched(true);
                      }}
                      aria-label="Prime document"
                      data-testid="document-editor-prime"
                    />
                  </div>
                )}

                {/* People — "Created by" + collaborator chips (version authors ∪
              document grantees, server-resolved). Hidden entirely for docs
              with no recorded author (old imports) and no collaborators. */}
                {!isNew && (author || collaborators.length > 0) && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    {author && (
                      <span className="inline-flex items-center gap-1.5">
                        Created by <span className="font-medium text-foreground/80">{author}</span>
                      </span>
                    )}
                    {author && collaborators.length > 0 && <span aria-hidden>·</span>}
                    {collaborators.length > 0 && (
                      <span
                        className="inline-flex items-center gap-1.5"
                        title={collaborators.join(", ")}
                      >
                        Collaborators:
                        <AuthorshipChips
                          collaborators={collaborators}
                          max={5}
                          size="md"
                        />
                        <span className="font-medium text-foreground/80">
                          {collaborators.length}
                        </span>
                      </span>
                    )}
                  </div>
                )}


                {/* Type + Schedule share one row: Type (new-doc kind, icon segmented
              control) on the left, Schedule (runnable orchestrator hint) on the
              right. Each takes half when both show; a lone field spans the row.
              Existing artifacts open straight into the ArtifactViewer (handled
              above). On an existing document the same control is "Turn into":
              picking another type opens the re-type confirmation (through the
              leave guard — the server re-types the SAVED body). Schedule shows
              for any agent/skill node. */}
                {canEditContent && (isNew || isRunnable || canTurnIntoHere) && (
                  <div className="flex flex-col sm:flex-row gap-4 w-full">
                    {(isNew || canTurnIntoHere) && (
                      <div className="flex-1 min-w-0">
                        <label className="block text-sm font-medium mb-1">Type</label>
                        {/* Icon segmented control, not a dropdown: all choices are
                  visible at once and carry the same type color language as
                  the list icons (document slate / artifact amber / agent
                  violet / skill blue). Built from the enabled set: document
                  always on; artifact/table only when their content-type
                  toggle is on; runnable types only when the workflow plane
                  is on. */}
                        {/* A radiogroup is one tab stop by contract: Tab reaches the
                      checked type, arrows move between the rest. */}
                        <div
                          className="inline-flex rounded-md border overflow-hidden"
                          role="radiogroup"
                          aria-label="Document type"
                          data-testid="document-editor-type"
                          {...typeRoving}
                        >
                          {(
                            [
                              {
                                value: "document", label: "Document", Icon: FileText,
                                on: "bg-slate-500/15 text-slate-700 dark:text-slate-300"
                              },
                              ...(typeArtifactEnabled
                                ? [
                                  {
                                    value: "artifact", label: "Artifact", Icon: Code2,
                                    on: "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                                  },
                                ]
                                : []),
                              ...(typeTableEnabled
                                ? [
                                  {
                                    value: "table", label: "Table", Icon: Table2,
                                    on: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300"
                                  },
                                ]
                                : []),
                              ...(workflowPlaneEnabled
                                ? [
                                  {
                                    value: "agent", label: "Agent", Icon: Bot,
                                    on: "bg-violet-500/15 text-violet-700 dark:text-violet-300"
                                  },
                                  {
                                    value: "skill", label: "Skill", Icon: Zap,
                                    on: "bg-blue-500/15 text-blue-700 dark:text-blue-300"
                                  },
                                  {
                                    value: "tool", label: "Tool", Icon: Wrench,
                                    on: "bg-teal-500/15 text-teal-700 dark:text-teal-300"
                                  },
                                ]
                                : []),
                            ] as const
                          ).map(({ value, label, Icon, on }, i) => {
                            const active = currentTypeValue === value;
                            return (
                              <button
                                key={value}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                title={
                                  value === "document"
                                    ? "Markdown document"
                                    : value === "artifact"
                                      ? "Hosted HTML artifact"
                                      : value === "table"
                                        ? "Table — CSV fact store, queryable deterministically"
                                        : value === "tool"
                                          ? "Tool — the body is code an agent can call"
                                          : `${label} (runnable)`
                                }
                                onClick={() => {
                                  if (isNew) {
                                    requestTypeChange(
                                      value as "document" | "artifact" | "agent" | "skill" | "tool" | "table",
                                      label,
                                    );
                                    return;
                                  }
                                  if (value === currentTypeValue) return;
                                  confirmLeave("turn it into another kind", () => setTurnInto(value));
                                }}
                                className={`flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors ${i > 0 ? "border-l" : ""
                                  } ${active ? `${on} font-medium` : "text-muted-foreground hover:bg-muted/60"}`}
                                data-testid={`document-editor-type-${value}`}
                              >
                                <Icon className="h-4 w-4" />
                                {label}
                              </button>
                            );
                          })}
                        </div>
                        {currentTypeValue === "artifact" && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            Hosted HTML — the body is served as a sandboxed page.
                          </p>
                        )}
                        {(currentTypeValue === "agent" || currentTypeValue === "skill") && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            The body is the instructions. Add flow edges from it in the
                            Workflows tab, then trigger a run.
                          </p>
                        )}
                        {currentTypeValue === "table" && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            The body is CSV — header first, directives welcome
                            (<code>sku:key, price:number, region</code>). Agents fetch
                            exact rows with table-query instead of reading it whole.
                          </p>
                        )}
                        {currentTypeValue === "tool" && (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            The body is code. Wire it to an agent on the canvas and the
                            runner ships it (plus the nest's env vars) in the run bundle.
                          </p>
                        )}
                      </div>
                    )}

                    {isRunnable && (
                      <div className="flex-1 min-w-0">
                        <label
                          htmlFor="document-editor-schedule"
                          className="block text-sm font-medium mb-1"
                        >
                          Schedule{" "}
                          <span className="font-normal text-muted-foreground">
                            (cron / interval — optional)
                          </span>
                        </label>
                        <input
                          id="document-editor-schedule"
                          data-testid="document-editor-schedule"
                          type="text"
                          value={schedule}
                          placeholder="e.g. 0 6 * * *  or  @daily  or  @every 15m"
                          aria-invalid={scheduleCheck.kind === "invalid"}
                          onChange={(e) => {
                            setSchedule(e.target.value);
                            setTouched(true);
                          }}
                          onBlur={saveOnBlur}
                          className={`w-full rounded-md border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring ${scheduleCheck.kind === "invalid"
                            ? "border-destructive focus:ring-destructive"
                            : ""
                            }`}
                        />
                        <p
                          data-testid="document-editor-schedule-feedback"
                          className={`mt-1 text-xs ${scheduleCheck.kind === "invalid"
                            ? "text-destructive"
                            : "text-muted-foreground"
                            }`}
                        >
                          {scheduleCheck.kind === "invalid" ? (
                            <>Doesn't look like a cron/interval schedule — {scheduleCheck.error}.</>
                          ) : scheduleCheck.kind === "valid" ? (
                            <>{scheduleCheck.description}. Opaque to this server — an external orchestrator parses it and runs the{" "}
                              {newType === "skill" || nodeType === "skill" ? "skill" : "agent"}.</>
                          ) : (
                            <>Opaque to this server — an external orchestrator parses it
                              and runs the{" "}
                              {newType === "skill" || nodeType === "skill"
                                ? "skill"
                                : "agent"}
                              . Leave blank for none.</>
                          )}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Runnable-node discovery hint: where an orchestrator fetches this
              node (+ every other agent/skill in the nest). Shown for agent/skill
              nodes, including read-only viewers, so the API surface is
              discoverable from the doc itself. */}
                {isRunnable && (
                  <div className="w-full rounded-md border border-dashed bg-muted/40 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-xs font-medium text-muted-foreground">
                        Orchestrator fetch — this {nodeType === "skill" || newType === "skill" ? "skill" : "agent"} appears here
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 shrink-0"
                        onClick={copyRunnablesUrl}
                        title="Copy URL"
                      >
                        {copiedRunnables ? (
                          <Check className="h-3 w-3 text-green-600" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </Button>
                    </div>
                    <code className="block text-[11px] font-mono break-all text-foreground/80">
                      GET {runnablesUrl}
                    </code>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Returns every runnable node (approved agent/skill) with its
                      schedule + content, so an external scheduler can discover what to
                      run and when.
                    </p>
                  </div>
                )}

                {/* Document + ever-present comments rail (Notion/Docs-style):
              editor left, comments a sticky panel on the right. */}
                <div className="flex flex-col lg:flex-row gap-6 items-start">
                  <div className="flex-1 min-w-0">
                    {commentMode && compareVersion == null && (
                      <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50/70 dark:bg-amber-950/20 px-3 py-1.5 text-xs text-amber-900 dark:text-amber-200">
                        <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                        Comment mode — select any text to pin a comment, or click a
                        highlighted phrase to open its thread. Editing is paused.
                      </div>
                    )}
                    {/* Dblclick → edit unless commenting/locked/reviewer/public-viewer. */}
                    <div
                      ref={bodyRef}
                      onClick={() => {
                        if (commentMode || isViewOnly || isLocked || isArtifactDraft) return;
                        // Table read view is interactive (query box + buttons), so a
                        // stray click must not yank the grid away — entering edit is
                        // explicit via "Start Editing".
                        if (effectiveType === "table") return;
                        if (mode === "view" && !isReviewerOnly) {
                          setMode("edit");
                        }
                      }}
                    >
                      {/* Source-only kinds keep a label: code and CSV are not prose,
                    and the label says which raw form the box expects. Documents
                    get none — the body is the page. */}
                      {(isArtifactDraft || effectiveType === "tool" || effectiveType === "table") && (
                        <div className="mb-1 text-xs font-medium text-muted-foreground">
                          {isArtifactDraft
                            ? "Artifact HTML"
                            : effectiveType === "tool"
                              ? "Tool source (code)"
                              : "Table data (CSV)"}
                        </div>
                      )}
                      {compareVersion != null ? (
                        /* Ever-present inline diff: current vs a chosen past version. */
                        <div data-testid="document-editor-inline-diff">
                          <div className="flex items-center justify-between mb-2">
                            <label className="text-sm font-medium flex items-center gap-2">
                              <GitCompare className="h-4 w-4" />
                              Diff: v{compareVersion} → current (v
                              {versionData?.currentVersion ?? baseVersion ?? "?"})
                              {isDirty && (
                                <span className="rounded bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300 px-1.5 py-px text-[10px] font-semibold uppercase">
                                  incl. unsaved edits
                                </span>
                              )}
                            </label>
                            <div className="flex items-center gap-1">
                              {/* Source = exact line changes; Rendered = formatted markdown. */}
                              <div className="flex rounded-md border overflow-hidden text-xs">
                                <button
                                  type="button"
                                  className={`px-2 py-1 ${!diffRendered ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-muted/50"}`}
                                  onClick={() => setDiffRendered(false)}
                                >
                                  Source
                                </button>
                                <button
                                  type="button"
                                  className={`px-2 py-1 ${diffRendered ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-muted/50"}`}
                                  onClick={() => setDiffRendered(true)}
                                >
                                  Rendered
                                </button>
                              </div>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7"
                                onClick={() => void compareWith(null)}
                              >
                                <X className="h-4 w-4 mr-1" /> Exit diff
                              </Button>
                            </div>
                          </div>
                          {(() => {
                            const past =
                              compareBody && compareBody.version === compareVersion
                                ? compareBody
                                : null;
                            if (!past) {
                              return (
                                <div className="flex items-center gap-2 text-sm text-muted-foreground p-4 border rounded-lg">
                                  <Loader2 className="h-4 w-4 animate-spin" /> Loading version{" "}
                                  {compareVersion}…
                                </div>
                              );
                            }
                            if (diffRendered) {
                              // A table's body is CSV: rendered as markdown it
                              // collapses into one run-on paragraph, so each side
                              // gets the same grid the reader sees, with the rows
                              // the other version doesn't have tinted.
                              const tableSides =
                                effectiveType === "table"
                                  ? tableDiffSides(past.content || "", content)
                                  : null;
                              const renderPane = (
                                side: "past" | "current",
                                body: string,
                              ) =>
                                tableSides ? (
                                  <TableGrid
                                    columns={tableSides[side].columns}
                                    rows={tableSides[side].rows}
                                    rowClassName={(i) =>
                                      tableSides[side].changed[i]
                                        ? side === "past"
                                          ? "bg-red-50 dark:bg-red-950/30"
                                          : "bg-emerald-50 dark:bg-emerald-950/30"
                                        : ""
                                    }
                                  />
                                ) : (
                                  <DocumentViewer content={body} className="px-4 py-3" />
                                );
                              return (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                  <div className="border rounded-lg overflow-hidden">
                                    <div className="bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground border-b">
                                      v{compareVersion}
                                    </div>
                                    {renderPane("past", past.content || "")}
                                  </div>
                                  <div className="border rounded-lg overflow-hidden">
                                    <div className="bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground border-b">
                                      current (v{versionData?.currentVersion ?? baseVersion ?? "?"})
                                    </div>
                                    {renderPane("current", content)}
                                  </div>
                                </div>
                              );
                            }
                            return (
                              <DiffViewer
                                patch={unifiedDiff(past.content || "", content)}
                                className="max-h-none border rounded-lg"
                              />
                            );
                          })()}
                        </div>
                      ) : isSourceOnly && mode === "edit" && !commentMode ? (
                        /* Tool/table edit is ALWAYS raw source — no TipTap, no
                           markdown round-trip. Tables get the CSV affordances
                           (file replace + grid-paste conversion) on top. */
                        effectiveType === "table" ? (
                          <TableSourceEditor
                            value={content}
                            onChange={(next) => {
                              if (fieldsDisabled) return;
                              setContent(next);
                              setTouched(true);
                            }}
                            onBlur={saveOnBlur}
                            readOnly={fieldsDisabled}
                          />
                        ) : (
                          /* Source beside a highlighted rendering of itself, reusing
                             the read view's lowlight output — flat plain text is hard
                             to scan while writing a tool.
                             ponytail: a preview pane, not highlighting under the
                             caret; swap in CodeMirror if tool authoring grows. */
                          <div
                            className={
                              content.trim() ? "grid gap-3 lg:grid-cols-2" : ""
                            }
                          >
                            <textarea
                              value={content}
                              onChange={(e) => {
                                if (fieldsDisabled) return;
                                setContent(e.target.value);
                                setTouched(true);
                              }}
                              onBlur={saveOnBlur}
                              readOnly={fieldsDisabled}
                              spellCheck={false}
                              placeholder={
                                "The body is code — paste or write the tool's source."
                              }
                              className="w-full min-h-[400px] border rounded-lg bg-background shadow-sm p-4 font-mono text-sm leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-ring"
                              data-testid="tool-source-editor"
                            />
                            {content.trim() && (
                              <div className="min-w-0 flex flex-col min-h-[400px] rounded-lg border bg-background shadow-sm overflow-hidden">
                                <div className="bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground border-b">
                                  Preview
                                </div>
                                <CodeHighlight
                                  code={deferredContent}
                                  className="flex-1 text-sm"
                                  data-testid="tool-source-preview"
                                />
                              </div>
                            )}
                          </div>
                        )
                      ) : rawMode ? (
                        <div className="space-y-2">
                          <div className="flex justify-end">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => setRawMode(false)}
                              title="Back to the rich editor"
                              data-testid="document-editor-rich-toggle"
                            >
                              <Code2 className="h-3.5 w-3.5 mr-1.5" />
                              Rich editor
                            </Button>
                          </div>
                          <textarea
                            value={content}
                            onChange={(e) => {
                              if (fieldsDisabled) return;
                              setContent(e.target.value);
                              setTouched(true);
                            }}
                            onBlur={saveOnBlur}
                            readOnly={fieldsDisabled}
                            spellCheck={false}
                            placeholder="# Raw markdown"
                            className="w-full min-h-[400px] border rounded-lg bg-background shadow-sm p-4 font-mono text-sm leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-ring"
                            data-testid="document-editor-raw-markdown"
                          />
                        </div>
                      ) : isArtifactDraft ? (
                        <div className="grid gap-3 lg:grid-cols-2">
                          <textarea
                            value={content}
                            onChange={(e) => {
                              setContent(e.target.value);
                              setTouched(true);
                            }}
                            onBlur={saveOnBlur}
                            placeholder="Paste the artifact's HTML (a self-contained slide deck, dashboard, infographic)…"
                            spellCheck={false}
                            className="w-full min-h-[360px] rounded-lg border bg-background p-3 font-mono text-xs leading-relaxed shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
                          />
                          <div className="rounded-lg border overflow-hidden flex flex-col min-h-[360px]">
                            <div className="bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground border-b">
                              Preview
                            </div>
                            {artifactPreview.trim() ? (
                              <iframe
                                srcDoc={artifactPreview}
                                title="Artifact preview"
                                // Same isolation as the hosted viewer: no
                                // allow-same-origin → opaque origin, no host storage.
                                sandbox="allow-scripts allow-popups allow-modals"
                                className="w-full flex-1 bg-white"
                                data-testid="artifact-draft-preview"
                              />
                            ) : (
                              <p className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
                                Paste HTML to see it render here.
                              </p>
                            )}
                          </div>
                        </div>
                      ) : (commentMode || mode === "view") &&
                        (isSourceOnly || !looksLikeHtml(content)) ? (
                        /* isSourceOnly bypasses the looksLikeHtml guard: a tool body
                           may legitimately start with `<` (HTML/XML/JSX code) and must
                           still render as source, never fall through to TipTap. */
                        <div
                          ref={docViewRef}
                          onMouseUp={isNew ? undefined : onDocMouseUp}
                          onClick={isNew ? undefined : onDocClick}
                          onMouseMove={isNew ? undefined : onDocMouseMove}
                          className="min-h-[300px] cursor-text"
                          data-testid="document-view-surface"
                        >
                          {effectiveType === "table" && !isNew ? (
                            <div className="p-4">
                              <TableViewer nestId={nestId} nodeId={nodeId} csv={content} />
                            </div>
                          ) : effectiveType === "tool" ? (
                            /* Highlighted with lowlight (language auto-detected) —
                               same tokens the editor's code blocks use. */
                            <CodeHighlight code={content} data-testid="tool-source-view" />
                          ) : (
                            <DocumentViewer
                              content={content}
                              onWikiLinkClick={(title) =>
                                handleWikiLinkClick(title, null)
                              }
                              previewFor={previewFor}
                            />
                          )}
                        </div>
                      ) : (
                        <MarkdownEditor
                          ref={editorRef}
                          content={content}
                          onChange={(next) => {
                            setContent(next);
                            // TipTap onUpdate fires only on real user input here.
                            setTouched(true);
                          }}
                          onSave={handleSave}
                          onBlur={saveOnBlur}
                          nestId={nestId}
                          currentNodeId={isNew ? undefined : nodeId}
                          editable={!fieldsDisabled}
                          onRequestDocLink={() => setShowDocPicker(true)}
                          onUploadImage={async (file) => {
                            const { url } = await api.uploadAsset(nestId, file);
                            return url;
                          }}
                          onWikiLinkClick={handleWikiLinkClick}
                          placeholder="Start writing, or select text to format it…"
                          // Nobody gets the caret on open: a new document focuses
                          // Title (see the effect below), an existing one reads as
                          // a page until you click into it — "end" would also
                          // scroll a long document to its last line on arrival.
                          autofocus={false}
                          variant="page"
                          toolbarEnd={
                            <>
                              {/* Rich ↔ raw markdown at the editor's own right end, where the
                                  writer already is (it used to hide in ⋮). */}
                              {!isSourceOnly && compareVersion == null && !isArtifactDraft && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => setRawMode(true)}
                                  title="Edit the raw markdown"
                                  data-testid="document-editor-markdown-toggle"
                                >
                                  <Code2 className="h-3.5 w-3.5 sm:mr-1.5" />
                                  <span className="hidden sm:inline">Markdown</span>
                                </Button>
                              )}
                            </>
                          }
                        />
                      )}
                    </div>
                  </div>

                </div>

                {/* Floating "Comment" button on text selection — pins a comment to
              the highlighted quote (Notion/Docs-style). */}
                {selPopover && !isViewOnly && (
                  <button
                    type="button"
                    data-testid="selection-comment-button"
                    onMouseDown={(e) => e.preventDefault() /* keep the selection */}
                    onClick={stageAnchorFromSelection}
                    style={{
                      position: "fixed",
                      left: selPopover.x,
                      top: selPopover.y - 40,
                      transform: "translateX(-50%)",
                      zIndex: 50,
                    }}
                    className="flex items-center gap-1 rounded-md bg-foreground text-background px-2.5 py-1.5 text-xs font-medium shadow-lg hover:opacity-90"
                  >
                    <MessageSquarePlus className="h-3.5 w-3.5" /> Comment
                  </button>
                )}

                {/* Backlinks — "what links here". View mode only; hidden when empty. */}
                {mode === "view" && backlinks.length > 0 && (
                  <div className="border rounded-lg bg-muted/20 p-3">
                    <div className="text-xs font-medium text-muted-foreground mb-2">
                      Linked from {backlinks.length} document
                      {backlinks.length !== 1 ? "s" : ""}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {backlinks.map((b) => (
                        <button
                          key={b.id}
                          type="button"
                          className="text-sm text-primary hover:underline text-left"
                          onClick={() =>
                            confirmLeave(
                              `open "${b.title}"`,
                              () => onNavigateDocument?.(nestId, b.id, title),
                            )
                          }
                        >
                          {b.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Related docs — shared tags / links. View mode only. */}
                {mode === "view" && related.length > 0 && (
                  <div className="border rounded-lg bg-muted/20 p-3">
                    <div className="text-xs font-medium text-muted-foreground mb-2">
                      Related documents
                    </div>
                    {/* A dot between titles: a run of "Weekly Sync — April 13"
                        style titles is otherwise one unbroken line. */}
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      {related.map((r, i) => (
                        <Fragment key={r.id}>
                        {i > 0 && <span aria-hidden className="text-muted-foreground/50">·</span>}
                        <button
                          type="button"
                          className="text-sm text-primary hover:underline text-left"
                          title={
                            r.sharedTags.length
                              ? `Shared tags: ${r.sharedTags.join(", ")}`
                              : "Shared links"
                          }
                          onClick={() =>
                            confirmLeave(
                              `open "${r.title}"`,
                              () => onNavigateDocument?.(nestId, r.id, title),
                            )
                          }
                        >
                          {r.title}
                        </button>
                        </Fragment>
                      ))}
                    </div>
                  </div>
                )}

                {/* Link discovery — docs that mention this one but don't link it. */}
                {mode === "view" && unlinked.length > 0 && (
                  <div className="border rounded-lg bg-muted/20 p-3">
                    <div className="text-xs font-medium text-muted-foreground mb-2">
                      Mentioned in {unlinked.length} document
                      {unlinked.length !== 1 ? "s" : ""} without a link
                    </div>
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      {unlinked.map((m, i) => (
                        <Fragment key={m.id}>
                        {i > 0 && <span aria-hidden className="text-muted-foreground/50">·</span>}
                        <button
                          type="button"
                          className="text-sm text-primary hover:underline text-left"
                          onClick={() =>
                            confirmLeave(
                              `open "${m.title}"`,
                              () => onNavigateDocument?.(nestId, m.id, title),
                            )
                          }
                        >
                          {m.title}
                        </button>
                        </Fragment>
                      ))}
                    </div>
                  </div>
                )}

              </div>
            )}

          </div>
          {/* Sticky action bar, edit mode only — Submit / Create·Save sit at the
            bottom of the document column so they stay in reach at the end of
            a long body. In view mode Submit and Edit live in the top bar. */}
          {mode === "edit" && (
            <div
              className="sticky bottom-0 z-20 mt-auto flex items-center justify-center gap-2 border-t bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80"
              data-testid="document-editor-actions-bottom"
            >
              {(() => {
                const canWrite = !isViewOnly && !isReviewerOnly && !isLocked;
                const showSubmit = !isViewOnly && canSubmitForReview;
                return (
                  <>
                    {/* Discard only where there is unreviewed work to throw away —
                    a draft or rejected status — beside Save, its opposite. */}
                    {canWrite &&
                      !isNew &&
                      canEditContent &&
                      (status === "draft" || status === "rejected") && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-muted-foreground"
                          disabled={discarding}
                          onClick={() => setConfirmDiscard(true)}
                          data-testid="document-editor-discard"
                        >
                          <Undo2 className="h-4 w-4 sm:mr-1.5" />
                          <span className="hidden sm:inline">{discarding ? "Discarding…" : "Discard draft"}</span>
                        </Button>
                      )}
                    {showSubmit && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        onClick={() => setShowSubmitModal(true)}
                        data-testid="document-editor-submit"
                        title="Requires steward approval — with stewardship on, publishing in this nest submits the document for steward review."
                      >
                        <Send className="h-4 w-4 sm:mr-1.5" />
                        <span className="hidden sm:inline">Submit for review</span>
                      </Button>
                    )}
                    {canWrite && (
                      <Button
                        size="sm"
                        className="h-8"
                        // Keep focus in the editor field so clicking Save doesn't
                        // fire the field's blur (which would trigger a second,
                        // concurrent save alongside this click). One save per click.
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={handleSave}
                        disabled={!canSave}
                        data-testid="document-editor-save"
                      >
                        {saving ? (
                          <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                        ) : justSaved && !isDirty ? (
                          <Check className="h-4 w-4 mr-1.5" />
                        ) : (
                          <Save className="h-4 w-4 mr-1.5" />
                        )}
                        {saving
                          ? "Saving…"
                          : justSaved && !isDirty
                            ? "Saved"
                            : isNew
                              ? "Create"
                              : "Save"}
                      </Button>
                    )}
                  </>
                );
              })()}
            </div>
          )}
        </div>
        {/* Right rail — the outline while reading, the comments once they
            are opened. A long outline stacked above the body pushed the
            document off the first screen; beside it, both stay in view.
            The comments panel stays mounted while hidden so its threads
            keep the in-text highlights alive. */}
        {!isNew && (
          <aside
            className={`w-full shrink-0 border-t lg:w-80 lg:border-t-0 lg:border-l lg:sticky lg:top-28 lg:self-start lg:max-h-[calc(100vh-7rem)] flex flex-col min-h-0 max-h-[70vh] px-4 py-4${commentsOpen || showOutline ? "" : " hidden"}`}
            data-testid="document-comments-rail"
            aria-hidden={!commentsOpen && !showOutline}
          >
            {!commentsOpen && showOutline && (
              <nav className="flex flex-col min-h-0 rounded-lg border border-border bg-card p-5" aria-label="Outline">
                <div className="mb-4 border-b pb-3 text-sm font-semibold">Outline</div>
                <div className="space-y-0.5 overflow-y-auto min-h-0">
                  {outlineHeadings.map((h) => (
                    <button
                      key={h.id}
                      type="button"
                      className="block w-full text-left text-sm text-primary hover:underline truncate"
                      style={{ paddingLeft: `${(h.level - 1) * 12}px` }}
                      title={h.text}
                      onClick={(e) => {
                        e.stopPropagation();
                        document
                          .getElementById(h.id)
                          ?.scrollIntoView({ behavior: "smooth", block: "start" });
                      }}
                    >
                      {h.text}
                    </button>
                  ))}
                </div>
              </nav>
            )}
            <div className={commentsOpen ? "flex flex-col flex-1 min-h-0" : "hidden"}>
            <AnnotationsPanel
              nestId={nestId}
              nodeId={nodeId}
              readOnly={isViewOnly}
              pendingAnchor={pendingAnchor}
              onClearAnchor={() => setPendingAnchor(null)}
              onFocusAnchor={focusAnchor}
              onThreadsChange={setAnchoredThreads}
              activeThreadId={activeThreadId}
              commentMode={commentMode}
              onSetCommentMode={(on) => {
                setCommentMode(on);
                if (on) setMode("view");
                setSelPopover(null);
                if (!on) setActiveThreadId(null);
              }}
            />
            </div>
          </aside>
        )}
      </div>

      {showVersions && !isNew && (
        <VersionHistoryModal
          open
          onClose={() => setShowVersions(false)}
          title={title || nodeId}
          versionData={versionData}
          onLoadContent={async (v) =>
            (await api.getNodeVersionContent(nestId, nodeId, v)).content
          }
          onRestore={
            // Reverting rewrites the document — an author's act, not a
            // reviewer's, so it follows the same gate as the editor itself.
            !canEditContent
              ? undefined
              : async (v) => {
                try {
                  await api.revertToVersion(nestId, nodeId, v);
                  toast.success(`Reverted to version ${v}`);
                  await Promise.all([loadNode(), loadVersions()]);
                } catch (e: any) {
                  toast.error(e?.message || "Revert failed");
                }
              }
          }
          onDiscard={
            // Same gate as revert — throwing the draft away rewrites the
            // document, so it is the author's call, not a reviewer's.
            !canEditContent
              ? undefined
              : async () => {
                try {
                  const { version } = await api.discardDraft(nestId, nodeId);
                  toast.success(`Draft discarded — back to version ${version}`);
                  await Promise.all([loadNode(), loadVersions()]);
                } catch (e: any) {
                  toast.error(e?.message || "Discard failed");
                }
              }
          }
        />
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

      {!isNew && (
        <ReasonDialog
          open={showDeletionModal}
          onOpenChange={setShowDeletionModal}
          title={
            canDeleteDirectly
              ? `Delete "${title || nodeId}"?`
              : `Request deletion of "${title || nodeId}"`
          }
          description={
            canDeleteDirectly
              ? "This removes the document, its version history, comments and annotations. It cannot be undone."
              : "A nest admin reviews this and either deletes the document or rejects with a note. Nothing is removed yet."
          }
          // Deleting your own work needs no justification; asking for someone
          // else's does.
          label={canDeleteDirectly ? undefined : "Why should it be deleted?"}
          placeholder="e.g. superseded by the new runbook"
          confirmLabel={canDeleteDirectly ? "Delete document" : "Request deletion"}
          destructive={canDeleteDirectly}
          priorDecline={
            !canDeleteDirectly && deletionRequest?.status === "declined"
              ? deletionRequest
              : null
          }
          onConfirm={
            canDeleteDirectly ? handleDeleteDocument : handleRequestDeletion
          }
        />
      )}

      <DocumentPickerModal
        isOpen={showDocPicker}
        onClose={() => setShowDocPicker(false)}
        nestId={nestId}
        excludeNodeId={isNew ? undefined : nodeId}
        onSelect={handleDocLinkInsert}
      />

      <Dialog
        open={turnInto !== null}
        onOpenChange={(open) => {
          if (!open && !turningInto) setTurnInto(null);
        }}
      >
        <DialogContent className="sm:max-w-[480px]">
          {/* The type was picked on the page (the Type control); this is the
              confirmation step only — what the new kind expects of the body. */}
          {(() => {
            const picked = turnIntoOptions.find((o) => o.value === turnInto);
            const Icon = picked?.Icon;
            return (
              <>
                <DialogHeader>
                  <DialogTitle>Turn into {picked?.label ?? ""}?</DialogTitle>
                </DialogHeader>
                <p className="text-sm text-muted-foreground">
                  Changes what kind of node this is. The body is kept as it is —
                  edit it afterwards if the new kind expects something else.
                </p>
                {picked && Icon && (
                  <div
                    className="flex items-start gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm"
                    data-testid={`document-editor-turn-into-${picked.value}`}
                  >
                    <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="flex flex-col">
                      <span className="font-medium">{picked.label}</span>
                      <span className="text-xs text-muted-foreground">{picked.expects}</span>
                    </span>
                  </div>
                )}
              </>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTurnInto(null)} disabled={turningInto}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleTurnInto()}
              disabled={turningInto || !turnInto}
              data-testid="document-editor-turn-into-confirm"
            >
              {turningInto ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Turn into {turnIntoOptions.find((o) => o.value === turnInto)?.label ?? ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={moveTo !== null}
        onOpenChange={(open) => {
          if (!open && !moving) setMoveTo(null);
        }}
      >
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Move to folder</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Move <strong>{title || nodeId}</strong> to another folder. Version
            history, review state, and [[wiki links]] follow the document.
          </p>
          <Select
            value={moveTo === "" ? "__root__" : (moveTo ?? "__root__")}
            onValueChange={(v) => setMoveTo(v === "__root__" ? "" : v)}
          >
            <SelectTrigger data-testid="document-editor-move-select">
              <SelectValue placeholder="Choose a folder" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__root__">Nest root</SelectItem>
              {folderOptions.map((f) => (
                <SelectItem key={f} value={f}>
                  {prettyFolderPath(f)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="ghost" disabled={moving} onClick={() => setMoveTo(null)}>
              Cancel
            </Button>
            <Button
              disabled={moving || moveTo === null || moveTo === currentFolder}
              data-testid="document-editor-move-confirm"
              onClick={async () => {
                if (moveTo === null) return;
                setMoving(true);
                try {
                  const { node: moved } = await api.moveNode(nestId, nodeId, moveTo);
                  toast.success(
                    moveTo ? `Moved to ${moveTo}` : "Moved to nest root",
                  );
                  setMoveTo(null);
                  // The move rewrites the node id, so this editor's id (and
                  // every breadcrumb entry pointing at it) is stale — leave
                  // for the list, where the document shows in its new folder.
                  onSaved?.(moved.id);
                } catch (err: any) {
                  toast.error(err?.message || "Move failed");
                } finally {
                  setMoving(false);
                }
              }}
            >
              {moving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <FolderInput className="h-4 w-4 mr-2" />
              )}
              Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {showShareDoc && (
        <ShareTargetDialog
          nestId={nestId}
          targetType="document"
          target={nodeId}
          label={title || nodeId}
          archived={isArchived}
          onClose={() => setShowShareDoc(false)}
        />
      )}
      {showShare && (
        <ShareNestDialog
          nestId={nestId}
          nestName={nestName}
          stewardshipEnabled={stewardshipEnabled}
          onClose={() => setShowShare(false)}
          onChanged={() => {
            /* Sharing changes don't alter this document's content; nothing
               to reload here. The nest list re-reads on next visit. */
          }}
        />
      )}
      {showPublish && (
        <PublishDialog
          nestId={nestId}
          nodeId={nodeId}
          nodeTitle={title || nodeId}
          onClose={() => setShowPublish(false)}
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

      {pendingType && (
        <Dialog open onOpenChange={() => setPendingType(null)}>
          <DialogContent className="sm:max-w-[460px]">
            <DialogHeader>
              <DialogTitle>Switch to {pendingType.label}?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground py-2">
              Your existing content will stay as-is, but it will now be
              interpreted as {bodyKindLabel(typeBodyKind(pendingType.value))}{" "}
              instead of {bodyKindLabel(typeBodyKind(newType))}. Nothing is
              converted automatically — review the body after switching.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPendingType(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setNewType(pendingType.value);
                  setPendingType(null);
                }}
              >
                Switch anyway
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Discard confirmation — the app's own dialog, like every other
          destructive action. Names both outcomes: only the server knows whether
          this document has an approved version to fall back to. */}
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Discard the draft of "{title || nodeId}"?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The document goes back to its last approved version. If it was
              never approved, it is deleted instead. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleDiscardDraft()}
              data-testid="document-editor-discard-confirm"
            >
              Discard draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

/**
 * Step-wise folder chooser for the create-form breadcrumb: lists existing
 * subfolders of the current path (derived from sibling doc ids) and takes a
 * new-subfolder name inline. Descending and creating both go through onPick
 * with the full new path — the breadcrumb above renders the result.
 */
function FolderStepPicker({
  folder,
  folderOptions,
  disabled,
  onPick,
}: {
  folder: string;
  folderOptions: string[];
  disabled?: boolean;
  onPick: (next: string) => void;
}) {
  const [newName, setNewName] = useState("");
  // Existing folders are already within the server's depth cap, so only a
  // brand-new subfolder can push past it — block that here once the current
  // path is at the limit.
  const atDepthLimit =
    folder.split("/").filter(Boolean).length >= MAX_FOLDER_DEPTH;
  const children = useMemo(() => {
    const kids = new Set<string>();
    for (const f of folderOptions) {
      if (folder) {
        if (f === folder || !f.startsWith(`${folder}/`)) continue;
        kids.add(f.slice(folder.length + 1).split("/")[0]);
      } else {
        kids.add(f.split("/")[0]);
      }
    }
    return [...kids].sort();
  }, [folder, folderOptions]);

  const commitNew = () => {
    if (atDepthLimit) return;
    // Slashes would smuggle extra depth past the picker; fold them away.
    const seg = newName.trim().replace(/\/+/g, "-");
    if (!seg) return;
    onPick(folder ? `${folder}/${seg}` : seg);
    setNewName("");
  };

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-muted-foreground"
          disabled={disabled}
          title="Open a subfolder or create a new one"
          data-testid="folder-step-picker"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {children.length > 0 && (
          <>
            <DropdownMenuLabel>
              {folder ? "Subfolders" : "Existing folders"}
            </DropdownMenuLabel>
            {children.map((k) => (
              <DropdownMenuItem
                key={k}
                onSelect={() => onPick(folder ? `${folder}/${k}` : k)}
              >
                <FolderOpen className="h-3.5 w-3.5 mr-2 text-blue-500" />
                {prettyFolder(k)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        {atDepthLimit ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            Max folder depth ({MAX_FOLDER_DEPTH}) reached — can't nest deeper.
          </div>
        ) : (
          <div
            className="flex items-center gap-1.5 px-2 py-1.5"
            onKeyDown={(e) => e.stopPropagation()}
          >
            <FolderPlus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitNew();
                }
              }}
              placeholder="New subfolder…"
              className="h-7 text-sm"
            />
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
