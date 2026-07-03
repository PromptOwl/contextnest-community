/** DocumentEditor — create/edit view; `nodeId === "new"` → POST, else PATCH. Server enforces 403. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import * as api from "../lib/api";
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
  ArrowLeft,
  Loader2,
  Save,
  AlertCircle,
  Send,
  X,
  Pencil,
  Users,
  Link as LinkIcon,
  History,
  Code2,
  MessageSquare,
  MessageSquarePlus,
  GitCompare,
  ChevronDown,
  Check,
  Copy,
} from "lucide-react";
import { OverflowMenu, type OverflowAction } from "@/components/ui/overflow-menu";
import { toast } from "sonner";
import {
  MarkdownEditor,
  slugFromNodeId,
  type MarkdownEditorHandle,
} from "./MarkdownEditor";
import { DocumentViewer } from "./DocumentViewer";
import { ArtifactViewer, ARTIFACT_NODE_TYPE } from "./ArtifactViewer";
import { ShareNestDialog } from "./ShareNestDialog";
import { AnnotationsPanel } from "./AnnotationsPanel";
import {
  buildTextIndex,
  rangeForAnchor,
  setHighlight,
  clearHighlight,
  caretAt,
} from "../lib/anchor-highlight";
import { SubmitForReviewModal, ReviewActions, ExternalEditBanner, VersionHistory, DiffViewer } from "./governance";
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
import { unlinkedMentions } from "../lib/unlinked-mentions";
import { extractHeadings } from "../lib/toc";
import { resolveWikiTarget, previewSnippet } from "../lib/wiki-preview";
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
  // Folder path under nodes/ for new docs (e.g. "gtm/deals"). Create-only:
  // moving an existing doc is a rename with backlink fallout, handled elsewhere.
  const [folder, setFolder] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  // Orchestrator schedule (free-form cron/interval). Only meaningful for
  // runnable node types (agent/skill); ignored/hidden otherwise. "" = none.
  const [schedule, setSchedule] = useState("");
  // Node kind. An "artifact" node is rich HTML hosted + annotated, not edited
  // as markdown — once loaded we hand off to ArtifactViewer (see below).
  const [nodeType, setNodeType] = useState<string | null>(null);
  // Version history for the detail view (CU-wdqcpztgwn). Lazily loaded when
  // the user opens the modal — VersionHistory already renders highlighted diffs.
  const [versionData, setVersionData] = useState<{
    versions: any[];
    approvedVersion: number | null;
    currentVersion: number;
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
  // Raw markdown source view — `content` is already markdown (the editor
  // serializes via tiptap-markdown), so this is just a textarea over the same
  // state. Editable in edit mode, read-only in view mode.
  const [rawMode, setRawMode] = useState(false);
  // New-document kind picker. "artifact" = paste raw HTML (hosted + annotated);
  // "document" = the normal markdown editor. Only meaningful while isNew.
  const [newType, setNewType] = useState<
    "document" | "artifact" | "agent" | "skill"
  >("document");
  const isArtifactDraft = isNew && newType === "artifact";
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
    try {
      await navigator.clipboard.writeText(runnablesUrl);
      setCopiedRunnables(true);
      setTimeout(() => setCopiedRunnables(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  };
  // Inline anchored comments (annotations) parked beside the doc. commentMode
  // forces the rendered read view + highlight overlay even for editors, so
  // select-to-comment and painted highlights are reachable without TipTap
  // stealing focus. Backed by the same /annotations API the ArtifactViewer uses.
  const [commentMode, setCommentMode] = useState(false);
  const [pendingAnchor, setPendingAnchor] = useState<api.AnnotationAnchor | null>(null);
  const [selPopover, setSelPopover] = useState<{ x: number; y: number } | null>(null);
  const docViewRef = useRef<HTMLDivElement | null>(null);
  const [anchoredThreads, setAnchoredThreads] = useState<api.AnnotationThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const anchorRangesRef = useRef<{ id: string; range: Range }[]>([]);
  const pendingFocusRef = useRef<string | null>(null);

  // Read the current selection inside the rendered doc and, if non-empty,
  // surface a floating "Comment" button at the selection. Building the anchor
  // is deferred to the click so we don't compute on every mouseup.
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
    const rect = range.getBoundingClientRect();
    // Anchor the button just above the selection (viewport/fixed coords).
    setSelPopover({ x: rect.left + rect.width / 2, y: rect.top });
  }, []);

  // Turn the live selection into a resilient anchor: quote + up to 250c of
  // surrounding rendered text + a best-effort source line hint.
  //
  // Offsets come from the actual selection Range — NOT String.indexOf — so that
  // selecting the 2nd/3rd occurrence of a repeated phrase anchors to that exact
  // spot. We measure against the same flat text the read side builds (raw text
  // nodes concatenated in order, which is what Range.toString() yields), so the
  // `before` tail that anchor-highlight.ts#locate uses to disambiguate matches.
  const stageAnchorFromSelection = useCallback(() => {
    const sel = window.getSelection();
    const container = docViewRef.current;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !container) return;
    const range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return;

    // Global char offset of a (node, offset) boundary within the container's
    // flattened text: length of the text from container start up to that point.
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
    if (!quote) return;
    const before = full.slice(Math.max(0, start - 250), start);
    const after = full.slice(end, end + 250);
    const srcIdx = content.indexOf(quote);
    const line = srcIdx >= 0 ? content.slice(0, srcIdx).split("\n").length : undefined;
    setPendingAnchor({ quote, before, after, line });
    setSelPopover(null);
    sel.removeAllRanges();
  }, [content]);

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
  useEffect(() => {
    // New docs need the list too — the folder picker derives its
    // suggestions from existing node ids.
    if (loading) return;
    let cancelled = false;
    (async () => {
      try {
        const { nodes } = await api.listNodes(nestId);
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

  // Every folder prefix in use (ids minus the nodes/ root and the leaf),
  // so the folder picker suggests existing paths at each depth.
  const folderOptions = useMemo(() => {
    const opts = new Set<string>();
    for (const n of nestNodes) {
      const rel = n.id.startsWith("nodes/") ? n.id.slice(6) : n.id;
      const segs = rel.split("/").slice(0, -1);
      for (let i = 1; i <= segs.length; i++) opts.add(segs.slice(0, i).join("/"));
    }
    return [...opts].sort();
  }, [nestNodes]);

  // Folder path this doc lives under (id minus the "nodes/" root and the leaf
  // slug), prettified for the header breadcrumb so users see where a nested
  // doc sits. Empty for new docs and docs directly under nodes/.
  const folderSegments = useMemo(() => {
    if (isNew || !nodeId) return [];
    const rel = nodeId.startsWith("nodes/") ? nodeId.slice(6) : nodeId;
    return rel
      .split("/")
      .slice(0, -1)
      .map((seg) =>
        seg
          .split("-")
          .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
          .join(" "),
      );
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
      setNodeType(node?.type ?? null);
      const loadedSchedule =
        node?.schedule == null ? "" : String(node.schedule);
      setSchedule(loadedSchedule);
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
        schedule: loadedSchedule,
      };
      loadedTitleRef.current = loadedTitle;
      setTouched(false);
    } catch (err: any) {
      setError(err.message);
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
      setVersionData(await api.getNodeVersions(nestId, nodeId));
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

  // Load versions on demand when the Compare dropdown opens, so the list is
  // populated without forcing the user through the history modal first.
  const ensureVersions = useCallback(async () => {
    if (!versionData) await loadVersions();
  }, [versionData, loadVersions]);

  const compareWith = useCallback((v: number | null) => {
    setCompareVersion(v);
    // Always reopen compare in the default Source view, and reset on exit.
    setDiffRendered(false);
  }, []);

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
    if (schedule.trim() !== snap.schedule.trim()) return true;
    return false;
  }, [touched, title, content, tags, schedule]);

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
      const res = await api.createNode(nestId, {
        ...payload,
        type: newType,
        ...(folder.trim() ? { folder: folder.trim() } : {}),
        // schedule is server-rejected on non-runnable types, so only send it
        // for agent/skill drafts.
        ...(isRunnable ? { schedule: schedule.trim() } : {}),
      });
      savedId = (res as any)?.node?.id;
    } else {
      const res = await api.updateNode(
        nestId,
        nodeId,
        // Only runnable nodes accept schedule; "" clears it server-side.
        isRunnable ? { ...payload, schedule: schedule.trim() } : payload,
        baseVersion,
      );
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
      schedule: schedule.trim(),
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
  const autosaveRef = useRef<() => void>(() => { });
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
        onBack={onBack}
      />
    );
  }

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
            {/* Folder path (nested docs only) so the location is visible. */}
            {folderSegments.map((seg, i) => (
              <Fragment key={`folder-${i}`}>
                <span className="text-muted-foreground shrink-0">›</span>
                <span
                  className="text-sm text-muted-foreground truncate max-w-[160px]"
                  title={seg}
                >
                  {seg}
                </span>
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
          {/* Version history — opens modal w/ highlighted diffs (CU-wdqcpztgwn).
              Icon-only; lives next to the overflow menu in the header. */}
          {!isNew && (
            <Button
              variant="outline"
              size="icon"
              onClick={openVersions}
              title="Version history"
              data-testid="document-editor-history"
            >
              <History className="h-4 w-4" />
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
                  variant={compareVersion != null ? "secondary" : "outline"}
                  size="sm"
                  title="Compare with a past version"
                  data-testid="document-editor-compare"
                >
                  <GitCompare className="h-4 w-4 mr-1" />
                  {compareVersion != null ? `Comparing v${compareVersion}` : "Compare"}
                  <ChevronDown className="h-4 w-4 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 max-h-80 overflow-y-auto">
                <DropdownMenuLabel>Diff current against…</DropdownMenuLabel>
                {compareVersion != null && (
                  <>
                    <DropdownMenuItem onClick={() => compareWith(null)}>
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
                        onClick={() => compareWith(v.version)}
                      >
                        {compareVersion === v.version ? (
                          <Check className="h-4 w-4 mr-2" />
                        ) : (
                          <span className="w-4 mr-2" />
                        )}
                        v{v.version}
                        <span className="ml-auto text-xs text-muted-foreground">
                          {v.editedBy?.split("@")[0] || ""}
                        </span>
                      </DropdownMenuItem>
                    ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* Raw markdown source toggle — view/edit the underlying .md. */}
          <Button
            variant={rawMode ? "secondary" : "outline"}
            size="icon"
            onClick={() => setRawMode((v) => !v)}
            title={rawMode ? "Rich editor" : "Markdown source"}
            aria-pressed={rawMode}
            data-testid="document-editor-markdown-toggle"
          >
            <Code2 className="h-4 w-4" />
          </Button>
          {/* Write/review affordances hidden for public reader.
              Copy link + Share nest collapsed into an overflow menu to keep
              the header uncluttered; primary actions (Publish/Save) stay inline. */}
          {(() => {
            const moreActions: OverflowAction[] = [];
            if (!isNew)
              moreActions.push({
                label: "Copy link",
                icon: LinkIcon,
                testId: "document-editor-copy-link",
                onSelect: () => {
                  // Deep link the App's ?nest=&doc= probe understands.
                  const url = `${window.location.origin}${window.location.pathname}?nest=${encodeURIComponent(nestId)}&doc=${encodeURIComponent(nodeId)}`;
                  navigator.clipboard.writeText(url);
                  toast.success("Link copied — recipient needs access to this nest");
                },
              });
            if (canShare)
              moreActions.push({
                label: "Share nest",
                icon: Users,
                testId: "document-editor-share",
                onSelect: () => setShowShare(true),
              });
            return (
              <OverflowMenu
                actions={moreActions}
                variant="outline"
                testId="document-editor-more"
              />
            );
          })()}
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

          {/* Folder (create-only): files the doc under nodes/<path>/ */}
          {isNew && (
            <div>
              <label className="block mb-1 text-sm font-medium">Folder</label>
              <Input
                list="document-editor-folder-options"
                value={folder}
                onChange={(e) => {
                  setFolder(e.target.value);
                  setTouched(true);
                }}
                placeholder='Optional — e.g. "gtm/deals" to nest this document'
                disabled={fieldsDisabled}
                data-testid="document-editor-folder-input"
              />
              <datalist id="document-editor-folder-options">
                {folderOptions.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
            </div>
          )}

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

          {/* Outline/TOC — view mode, only when the doc has real structure. */}
          {mode === "view" &&
            !looksLikeHtml(content) &&
            (() => {
              const headings = extractHeadings(content);
              if (headings.length < 3) return null;
              return (
                <nav className="border rounded-lg bg-muted/20 px-3 py-2">
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    Outline
                  </div>
                  <div className="space-y-0.5">
                    {headings.map((h) => (
                      <button
                        key={h.id}
                        type="button"
                        className="block w-full text-left text-sm text-primary hover:underline truncate"
                        style={{ paddingLeft: `${(h.level - 1) * 12}px` }}
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
              );
            })()}

          {/* Type + Schedule share one row: Type (new-doc kind) on the left,
              Schedule (runnable orchestrator hint) on the right. Each takes half
              when both show; a lone field spans the row. Existing artifacts open
              straight into the ArtifactViewer (handled above), so Type is
              create-only; Schedule shows for any agent/skill node. */}
          {!isViewOnly && (isNew || isRunnable) && (
            <div className="flex flex-col sm:flex-row gap-4 w-full">
              {isNew && (
                <div className="flex-1 min-w-0">
                  <label className="block text-sm font-medium mb-1">Type</label>
                  <Select
                    value={newType}
                    onValueChange={(v) =>
                      setNewType(
                        v as "document" | "artifact" | "agent" | "skill",
                      )
                    }
                  >
                    <SelectTrigger data-testid="document-editor-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="document">
                        Document (markdown)
                      </SelectItem>
                      <SelectItem value="artifact">
                        Artifact (hosted HTML)
                      </SelectItem>
                      <SelectItem value="agent">Agent (runnable)</SelectItem>
                      <SelectItem value="skill">Skill (runnable)</SelectItem>
                    </SelectContent>
                  </Select>
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
                    placeholder="e.g. 0 6 * * *  or  @daily"
                    onChange={(e) => {
                      setSchedule(e.target.value);
                      setTouched(true);
                      scheduleAutosave();
                    }}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Opaque to this server — an external orchestrator parses it
                    and runs the{" "}
                    {newType === "skill" || nodeType === "skill"
                      ? "skill"
                      : "agent"}
                    . Leave blank for none.
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
            onClick={() => {
              if (commentMode || isViewOnly || isLocked || isArtifactDraft) return;
              if (mode === "view" && !isReviewerOnly) {
                setMode("edit");
              }
            }}
          >
            <label className="block text-sm font-medium mb-1">
              {isArtifactDraft ? "Artifact HTML" : "Content"}{" "}
              <span className="text-destructive">*</span>
            </label>
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
                      onClick={() => compareWith(null)}
                    >
                      <X className="h-4 w-4 mr-1" /> Exit diff
                    </Button>
                  </div>
                </div>
                {(() => {
                  const past = versionData?.versions.find(
                    (v) => v.version === compareVersion,
                  );
                  if (!past) {
                    return (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground p-4 border rounded-lg">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading version{" "}
                        {compareVersion}…
                      </div>
                    );
                  }
                  if (diffRendered) {
                    return (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div className="border rounded-lg overflow-hidden">
                          <div className="bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground border-b">
                            v{compareVersion}
                          </div>
                          <DocumentViewer
                            content={past.content || ""}
                            className="px-4 py-3"
                          />
                        </div>
                        <div className="border rounded-lg overflow-hidden">
                          <div className="bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground border-b">
                            current (v{versionData?.currentVersion ?? baseVersion ?? "?"})
                          </div>
                          <DocumentViewer content={content} className="px-4 py-3" />
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
            ) : rawMode ? (
              <textarea
                value={content}
                onChange={(e) => {
                  if (fieldsDisabled) return;
                  setContent(e.target.value);
                  setTouched(true);
                  scheduleAutosave();
                }}
                onBlur={flushAutosave}
                readOnly={fieldsDisabled}
                spellCheck={false}
                placeholder="# Raw markdown"
                className="w-full min-h-[400px] border rounded-lg bg-background shadow-sm p-4 font-mono text-sm leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-ring"
                data-testid="document-editor-raw-markdown"
              />
            ) : isArtifactDraft ? (
              <textarea
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  setTouched(true);
                }}
                placeholder="Paste the artifact's HTML (a self-contained slide deck, dashboard, infographic)…"
                spellCheck={false}
                className="w-full min-h-[360px] rounded-lg border bg-background p-3 font-mono text-xs leading-relaxed shadow-sm focus:outline-none focus:ring-1 focus:ring-primary"
              />
            ) : (commentMode || mode === "view") && !looksLikeHtml(content) ? (
              <div
                ref={docViewRef}
                onMouseUp={isNew ? undefined : onDocMouseUp}
                onClick={isNew ? undefined : onDocClick}
                onMouseMove={isNew ? undefined : onDocMouseMove}
                className="border rounded-lg bg-background shadow-sm min-h-[300px] cursor-text"
              >
                <DocumentViewer
                  content={content}
                  onWikiLinkClick={(title) =>
                    handleWikiLinkClick(title, null)
                  }
                  previewFor={previewFor}
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
                currentNodeId={isNew ? undefined : nodeId}
                editable={!fieldsDisabled}
                onRequestDocLink={() => setShowDocPicker(true)}
                onUploadImage={async (file) => {
                  const { url } = await api.uploadAsset(nestId, file);
                  return url;
                }}
                onWikiLinkClick={handleWikiLinkClick}
                placeholder="Start writing..."
              />
            )}
          </div>
          </div>

          {/* Ever-present comments rail — beside the doc, not stacked below. */}
          {!isNew && (
            <aside className="w-full lg:w-80 shrink-0 self-start lg:sticky lg:top-4 flex flex-col min-h-0 max-h-[70vh]">
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
            </aside>
          )}
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
              <div className="flex flex-wrap gap-2">
                {related.map((r) => (
                  <button
                    key={r.id}
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
              <div className="flex flex-wrap gap-2">
                {unlinked.map((m) => (
                  <button
                    key={m.id}
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
                ))}
              </div>
            </div>
          )}

        </div>
      )}

      {showVersions && !isNew && (
        <Dialog open onOpenChange={(o) => !o && setShowVersions(false)}>
          <DialogContent className="sm:max-w-[600px] max-h-[85vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle>{title || nodeId}</DialogTitle>
            </DialogHeader>
            {versionData ? (
              <VersionHistory
                className="flex-1 min-h-0 overflow-hidden"
                versions={versionData.versions}
                currentVersion={versionData.currentVersion}
                approvedVersion={versionData.approvedVersion}
                onRestore={
                  isViewOnly
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
              />
            ) : (
              <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Loading versions…
              </div>
            )}
          </DialogContent>
        </Dialog>
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
