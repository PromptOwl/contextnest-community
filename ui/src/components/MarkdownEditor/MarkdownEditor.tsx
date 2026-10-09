/**
 * MarkdownEditor — slim TipTap editor for community.
 *
 * Mirrors the TheOwl/data-room editor surface so syntax behaves the
 * same across products:
 *   - `[[Title]]`        — wiki link to a document in the same nest
 *   - `[ ]` / `[x]`      — toggleable task checkbox (plain-text round-trips)
 *   - `@email` / `@(Name)` — mention of a person on the nest, picked from
 *                            the `@` autocomplete; unknown names style as
 *                            unresolved rather than passing as a mention
 *
 * Imperative API:
 *   `ref.current?.insertWikiLink(title)` is used by the parent after a
 *   pick in `DocumentPickerModal` so the user gets a discoverable
 *   browser for documents on top of the bare `[[…]]` syntax.
 */
import {
  useEditor,
  EditorContent,
  type Editor,
} from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { useRovingFocus } from "../../lib/use-roving-focus";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TiptapImage from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Highlight from "@tiptap/extension-highlight";
import { TextStyle, Color } from "@tiptap/extension-text-style";
import Typography from "@tiptap/extension-typography";
import CharacterCount from "@tiptap/extension-character-count";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { NodeRange } from "@tiptap/extension-node-range";
import type { Transaction } from "@tiptap/pm/state";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";
import { serializeImageNode } from "../../lib/image-markdown-serializer";

// tiptap-markdown's storage isn't in TipTap's Storage type; cast.
// TextStyle/Color have no dedicated markdown syntax, so with no explicit
// mark serializer tiptap-markdown's html:true fallback (see Markdown.configure
// below) writes the mark as raw `<span style="color: …">` HTML straight into
// the stored .md — that's valid CommonMark (raw inline HTML) and is exactly
// how legacy HTML docs already round-trip through this editor. Same fallback
// parses it back into the TextStyle/Color marks on load via their normal
// `parseHTML`, so color survives save + reopen without any custom code here.

// Unescape `\[\[ \]\]` — prosemirror-markdown escapes `[`/`]` as link syntax.
// Same escaping kills GFM footnotes (`\[^1\]`), so restore those too — and
// LaTeX inside `$…$`, where the same escaping hides the command from KaTeX.
function getEditorMarkdown(editor: Editor): string {
  const storage = editor.storage as unknown as { markdown: MarkdownStorage };
  const md = storage.markdown.getMarkdown();
  return unescapeMathSpans(
    md
      .replace(/\\\[\\\[/g, "[[")
      .replace(/\\\]\\\]/g, "]]")
      .replace(/\\\[\^([^\]\\\s]+)\\?\]/g, "[^$1]"),
  );
}

/** Heading levels the schema accepts, and the icon each one shows. Kept
 *  together so the toolbar and the StarterKit config can't drift apart. */
const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;
const HEADING_ICONS = {
  1: Heading1,
  2: Heading2,
  3: Heading3,
  4: Heading4,
  5: Heading5,
  6: Heading6,
} as const;

// Engine ids: `nodes/<slug>`. Slug = on-disk filename.
export function slugFromNodeId(id: string): string {
  if (!id) return "";
  const idx = id.lastIndexOf("/");
  return idx >= 0 ? id.slice(idx + 1) : id;
}

// Multi-paragraph selection → one codeBlock (default makes N stacked blocks).
function toggleCodeBlockMerged(editor: Editor): void {
  const { state } = editor;
  const { from, to } = state.selection;
  if (from === to || editor.isActive("codeBlock")) {
    editor.chain().focus().toggleCodeBlock().run();
    return;
  }
  const text = state.doc.textBetween(from, to, "\n", "\n");
  editor
    .chain()
    .focus()
    .deleteRange({ from, to })
    .insertContent(
      text
        ? { type: "codeBlock", content: [{ type: "text", text }] }
        : { type: "codeBlock" },
    )
    .run();
}

// Normalize a user-typed URL for the Link mark. Bare "google.com" would
// otherwise be treated as relative by the browser (/google.com on the host
// origin). Adds https:// when no scheme is present; rejects unparseable
// input and the javascript: scheme.
function normalizeLinkUrl(
  raw: string,
): { url: string; error: null } | { url: null; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { url: "", error: null };
  const tryParse = (candidate: string) => {
    try {
      return new URL(candidate);
    } catch {
      return null;
    }
  };
  const parsed = tryParse(trimmed) ?? tryParse(`https://${trimmed}`);
  if (!parsed) {
    return { url: null, error: "Enter a valid URL (e.g. https://example.com)." };
  }
  if (parsed.protocol === "javascript:") {
    return { url: null, error: "javascript: links are not allowed." };
  }
  return { url: parsed.toString(), error: null };
}

// Obsidian wiki link: `[[nodes/<folder>/<slug>|Title]]` — the full node id
// as the target (a bare slug would resolve wrong once two folders share
// one), plus the title as the alias.
function formatWikiLink(nodeId: string, title: string): string {
  const safeId = (nodeId || title).trim();
  const display = (title || nodeId).trim();
  if (!safeId) return "";
  const target = safeId.startsWith("nodes/") ? safeId : `nodes/${safeId}`;
  return `[[${target}|${display}]] `;
}
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
} from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Bold,
  Italic,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Heading5,
  Heading6,
  List,
  ListOrdered,
  CheckSquare,
  Quote,
  Code,
  Link as LinkIcon,
  ImagePlus,
  FileText,
  Undo,
  Redo,
  Eye,
  Pencil,
  Search,
  ChevronUp,
  ChevronDown,
  X,
  GripVertical,
  Copy,
  Trash2,
  Highlighter,
  Table as TableIcon,
  FileSpreadsheet,
  Upload,
  Video,
  Info,
  ChevronRight,
  Columns2,
} from "lucide-react";
import { toast } from "sonner";
import {
  looksLikeDelimitedTable,
  detectHeaderRow,
  rowsToMarkdownTable,
  readUploadedTable,
  uploadedTableErrorMessage,
  LARGE_TABLE_ROW_THRESHOLD,
  type Delimiter,
} from "@/lib/csv-table";
import { cn } from "@/lib/utils";
import { unescapeMathSpans } from "@/lib/markdown-math";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { reads } from "../../lib/queries";
import { escapeUnknownInlineHtml } from "../../lib/html-tag-allowlist";
import {
  detectTrigger,
  matchMembers,
  isMemberName,
  type MentionMember,
} from "./picker-match";
import { WikiLink, clearWikiExistsCache } from "./extensions/WikiLink";
import { resolveWikiTarget, previewSnippet } from "@/lib/wiki-preview";
import { CodeBlock } from "./extensions/CodeBlock";
import { tableExtensions } from "./extensions/Table";
import { Callout } from "./extensions/Callout";
import { toggleExtensions } from "./extensions/Toggle";
import { columnExtensions } from "./extensions/Columns";
import { TableControls } from "./TableControls";
import { TaskCheckbox } from "./extensions/TaskCheckbox";
import { VideoPreview } from "./extensions/VideoPreview";
import {
  MEDIA_ACCEPT,
  MEDIA_FILE_RE,
  MEDIA_HELPER_TEXT,
  VIDEO_FILE_RE,
  IMAGE_MAX_UPLOAD_BYTES,
  VIDEO_MAX_UPLOAD_BYTES,
  editorPlaceholder,
  isFileDrag,
  isUnsupportedFileDrag,
  mediaAffordances,
  pickMediaFile,
  shouldUploadPastedMedia,
  unsupportedMediaDropMessage,
  validateEmbedInput,
} from "@/lib/editor-media";
import { Mention } from "./extensions/Mention";
import {
  SearchReplace,
  setSearch,
  gotoMatch,
  replaceCurrent,
  replaceAll,
  clearSearch,
  type SearchState,
} from "./extensions/SearchReplace";
import { DocumentViewer } from "../DocumentViewer";
import "./editor-styles.css";
import { useAuth } from "../../auth/AuthContext";

export interface MarkdownEditorHandle {
  /** Insert `[[<node id>|Title]]` at cursor. */
  insertWikiLink: (nodeId: string, title: string) => void;
  /** Put the caret at the start of the body (Enter from the title). */
  focus: () => void;
}

interface MarkdownEditorProps {
  content: string;
  onChange: (content: string) => void;
  onSave?: () => void;
  /** Editor lost focus (click-out). Parent uses it for silent autosave. */
  onBlur?: () => void;
  /** Nest scope used by the wiki-link existence check. Without it
   *  every `[[X]]` styles optimistically as "exists". */
  nestId?: string;
  /** This document's node id — excluded from the `[[` autocomplete so a
   *  doc can't wiki-link to itself. */
  currentNodeId?: string;
  /** Toolbar "Link to document" button calls this. Parent shows the picker. */
  onRequestDocLink?: () => void;
  /** Toolbar "Image or video" button (and file drag-drop): upload the
   *  picked file, resolve to its asset URL. Omit to hide the button
   *  (e.g. contexts with no asset storage). */
  onUploadImage?: (file: File) => Promise<string>;
  /** Click on a `[[Title]]` decoration inside the editor. `displayText` is
   *  the human-readable alias (for aliased links `title` is the internal
   *  node id — see `formatWikiLink`). */
  onWikiLinkClick?: (
    title: string,
    id: string | null,
    displayText?: string | null,
  ) => void;
  /** Click on an `@name` decoration. */
  onMentionClick?: (name: string) => void;
  placeholder?: string;
  editable?: boolean;
  className?: string;
  /** Caret-ready on mount ("end"), or leave focus alone (false) — e.g. a
   *  brand-new document wants focus on the Title field first. Default
   *  preserves the existing Notion/Obsidian-style caret-ready feel. */
  autofocus?: "end" | false;
  /** "boxed" (default): a bordered field with its own scroll viewport and an
   *  always-on toolbar — a form control. "page": the document IS the page
   *  (Notion-style) — no border, the window scrolls, and the block toolbar
   *  only appears while the editor has focus; inline formatting comes from
   *  the selection bubble. */
  variant?: "boxed" | "page";
  /** Rendered at the toolbar's right end — the document page puts its
   *  document-level switches (source view, Turn into) there. */
  toolbarEnd?: React.ReactNode;
  /** Keep the toolbar's space but hide it — the page reads clean until the
   *  user starts working in it. Space is kept so the body doesn't jump. */
  toolbarHidden?: boolean;
}

export const MarkdownEditor = forwardRef<
  MarkdownEditorHandle,
  MarkdownEditorProps
>(function MarkdownEditor(
  {
    content,
    onChange,
    onSave,
    onBlur,
    nestId,
    currentNodeId,
    onRequestDocLink,
    onUploadImage,
    onWikiLinkClick,
    onMentionClick,
    placeholder,
    editable = true,
    className,
    autofocus = "end",
    variant = "boxed",
    toolbarEnd,
    toolbarHidden = false,
  }: MarkdownEditorProps,
  ref: ForwardedRef<MarkdownEditorHandle>,
) {
  // Preview renders the markdown through the same reader the view and
  // comment modes use, not a read-only TipTap — TipTap shows its own editing
  // model, so anything it has no node for (math, footnotes) stayed as raw
  // source and the preview lied about how the document would render.
  // The editor stays mounted, hidden, so toggling back keeps caret and undo.
  const [previewing, setPreviewing] = useState(false);
  // Page mode shows the block toolbar only while writing. Toolbar buttons
  // preventDefault on mousedown, so clicking one never blurs the editor.
  const isPage = variant === "page";
  const [previewMarkdown, setPreviewMarkdown] = useState("");
  const qc = useQueryClient();
  const effectiveEditable = editable && !previewing;
  // Same target resolution as DocumentEditor's own read view (lib/wiki-preview),
  // so the "Preview" toggle's broken-link styling and hover preview match the
  // view/comment modes instead of styling every `[[…]]` as resolved.
  const { data: previewNodesData } = useQuery({
    ...reads.nodes(nestId ?? ""),
    enabled: !!nestId && previewing,
  });
  const previewFor = useCallback(
    (target: string) => {
      const nodes = (previewNodesData?.nodes ?? []) as Array<{
        id: string;
        title: string;
        content?: string;
      }>;
      const node = resolveWikiTarget(nodes, target);
      if (!node) return null;
      return { title: node.title, snippet: previewSnippet(node.content ?? "") };
    },
    [previewNodesData],
  );
  // Image / video affordances (toolbar menu, drop overlay) — none in a
  // read-only / locked / preview doc. See lib/editor-media.ts.
  const media = mediaAffordances({
    editable,
    previewing,
    canUpload: !!onUploadImage,
  });
  // "Drop to add an image or video" overlay while a file is dragged over.
  const [fileDragOver, setFileDragOver] = useState(false);

  // Inline autocomplete state, shared by both triggers: `[[` searches the
  // nest's documents, `@` searches its people. One popup, one keyboard
  // handler, one set of placement math — the kind only changes what fills it.
  const [pickerPopup, setPickerPopup] = useState<{
    kind: "wiki" | "mention";
    query: string;
    from: number;
    to: number;
    // Caret rect edges (viewport coords). `top`/`bottom` are the caret's
    // top and bottom so the render can flip the panel above the caret when
    // there isn't room below (caret near the bottom of the viewport).
    coords: { left: number; top: number; bottom: number };
    selectedIdx: number;
  } | null>(null);
  // Rows normalized to one shape so the list render and the insert stay
  // kind-agnostic: `insert` is the literal text that replaces the trigger.
  const [pickerResults, setPickerResults] = useState<
    Array<{ key: string; primary: string; secondary: string; insert: string }>
  >([]);
  // Full node list for the nest, fetched once per popup-open and filtered
  // client-side. Server search on every keystroke added 3-4s of latency;
  // the nest's list is small enough to filter locally for instant matches.
  const wikiNodesRef = useRef<Array<{ id: string; title: string }>>([]);
  // Bump when the list finishes loading so the filter effect recomputes.
  const [wikiNodesVersion, setWikiNodesVersion] = useState(0);
  // In flight → the popup says "Loading" instead of flashing "no documents".
  const [wikiLoading, setWikiLoading] = useState(false);
  // Refs mirror state so the editor's static `handleKeyDown` (captured
  // once at useEditor time) can see the latest values without a re-init.
  const pickerPopupRef = useRef(pickerPopup);
  const pickerResultsRef = useRef(pickerResults);
  useEffect(() => {
    pickerPopupRef.current = pickerPopup;
  }, [pickerPopup]);
  useEffect(() => {
    pickerResultsRef.current = pickerResults;
  }, [pickerResults]);

  // The nest's people, for the `@` picker AND for telling a real mention from
  // a typo. `people` — not `collaborators` — because the owner, a shared
  // team's members, stewards and grant holders all reach the nest without a
  // collaborator row. Write-tier read (an editor already passes), so it's
  // skipped for read-only surfaces where it would only 403.
  const { data: rosterData } = useQuery({
    ...reads.collaborators(nestId ?? ""),
    enabled: !!nestId && effectiveEditable,
  });
  const members: MentionMember[] = useMemo(
    () =>
      ((rosterData?.people as Array<{
        email?: string;
        name?: string | null;
      }>) || []
      ).filter((p) => !!p.email)
        .map((p) => ({ email: p.email as string, name: p.name })),
    [rosterData],
  );
  // Read from the Mention extension's decorator, which is configured once.
  const membersRef = useRef<MentionMember[]>(members);
  useEffect(() => {
    membersRef.current = members;
  }, [members]);

  // In-doc find/replace (Cmd+F). Match state lives in the SearchReplace
  // plugin; these drive the bar UI + counter. openSearchRef lets the static
  // editor keydown handler open the bar.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [matchInfo, setMatchInfo] = useState({ current: 0, total: 0 });
  const openSearchRef = useRef<() => void>(() => {});

  // Block actions. The official DragHandle reports which top-level block it
  // points at via onNodeChange → `blockTarget.pos`. Clicking the ⠿ opens the
  // action dropdown (duplicate / delete / turn-into); `menuPos` anchors it to
  // the handle. Drag on the handle itself reorders the block natively.
  const [blockTarget, setBlockTarget] = useState<{ pos: number } | null>(null);
  const [blockMenuOpen, setBlockMenuOpen] = useState(false);
  // top/left = preferred (below-handle) anchor; anchorTop = the handle's top,
  // used to flip the menu above when it would overflow the viewport bottom.
  const [menuPos, setMenuPos] = useState<{
    top: number;
    left: number;
    anchorTop: number;
  } | null>(null);
  const blockMenuRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // The scrollable content viewport (EditorContent's div). Used as the bubble
  // menu's flip boundary so a top-of-doc selection flips the menu below.
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Word/char count + document outline. Both recomputed on every doc change
  // (cheap walk); the outline panel is toggled from the toolbar.
  const [counts, setCounts] = useState({ words: 0, characters: 0 });
  const [headings, setHeadings] = useState<
    Array<{ level: number; text: string; pos: number }>
  >([]);
  const [outlineOpen, setOutlineOpen] = useState(false);

  // Wiki-link hover preview: which link is hovered + its fetched excerpt.
  const [wikiPreview, setWikiPreview] = useState<{
    title: string;
    excerpt: string;
    left: number;
    top: number;
  } | null>(null);

  // Lets the static `handlePaste` (captured once at useEditor time) reach
  // the live editor instance for markdown-aware insertion.
  const editorRef = useRef<Editor | null>(null);
  // Same trick for `handleDrop`: the uploader prop is an inline arrow in
  // the parent, so route it through a ref to avoid a stale closure.
  const onUploadImageRef = useRef(onUploadImage);
  onUploadImageRef.current = onUploadImage;

  // ONE in-flight media upload at a time, shared by the toolbar picker and
  // drag-drop. State drives the toolbar's disabled UI; the ref is the
  // source of truth for the static handleDrop closure.
  const [uploading, setUploading] = useState(false);
  const uploadingRef = useRef(false);
  const runMediaUpload = async (
    ed: Editor,
    file: File,
    insertPos?: number,
  ) => {
    const upload = onUploadImageRef.current;
    if (!upload) return;
    if (uploadingRef.current) {
      toast.error("An upload is already in progress — try again when it finishes.");
      return;
    }
    uploadingRef.current = true;
    setUploading(true);
    try {
      await uploadAndInsertMedia(ed, file, upload, insertPos);
    } finally {
      uploadingRef.current = false;
      setUploading(false);
    }
  };
  const runMediaUploadRef = useRef(runMediaUpload);
  runMediaUploadRef.current = runMediaUpload;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Every markdown heading level. Capped at 3, `#### x` stayed literal
        // text both when typed and when a document written elsewhere was
        // loaded — its deeper headings were flattened on the way in.
        heading: { levels: [...HEADING_LEVELS] },
        link: false,
        // Replaced by the lowlight code block (syntax highlight + picker + copy).
        codeBlock: false,
      }),
      CodeBlock,
      // Caller's placeholder verbatim; the default also says media can be
      // dropped in / linked (only when an uploader is wired).
      Placeholder.configure({
        placeholder: editorPlaceholder(placeholder, !!onUploadImage),
      }),
      Link.configure({
        // Plain click opens link in new tab. Edit URL: caret inside link →
        // toolbar Link button (setLink uses extendMarkRange).
        openOnClick: true,
        HTMLAttributes: { target: "_blank", rel: "noopener noreferrer" },
        // Auto-link: typed/pasted URLs become links. Wiki `[[…]]` and
        // `@mentions` aren't URLs, so they're left untouched.
        autolink: true,
        linkOnPaste: true,
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      // Block-level images — required for tiptap-markdown to round-trip
      // ![alt](url) instead of dropping it. Rendering constrained via
      // editor-styles.css. Custom markdown serializer: the built-in one
      // (inherited from an inline-image assumption) never closes the
      // image's block, which drops the blank line before whatever follows
      // it — see image-markdown-serializer.ts for why that silently breaks
      // a video URL placed right after an image.
      TiptapImage.extend({
        addStorage() {
          return { markdown: { serialize: serializeImageNode } };
        },
      }).configure({ inline: false, allowBase64: false }),
      // `==text==` highlight. multicolor lets the color marks set a bg.
      Highlight.configure({ multicolor: true }),
      // Text color mark. Persisted via the html:true raw-HTML fallback below
      // (see the TextStyle/Color import comment) — no dedicated markdown
      // syntax needed.
      TextStyle,
      Color,
      // Smart typography: -- → em-dash, (c) → ©, -> → →, smart quotes, etc.
      Typography,
      // Word / character counter (read from editor.storage.characterCount).
      CharacterCount,
      // Multi-block selection via Mod+drag, to move/delete a range as a group.
      // `key: "Mod"` keeps a plain mouse drag a normal text selection — so
      // dragging across lines shows the native ::selection highlight. `key: null`
      // would turn every drag into a NodeRangeSelection (decoration-rendered, no
      // native highlight, looked unselected).
      // We also drop NodeRange's keyboard shortcuts: it binds Mod+A to a
      // NodeRangeSelection, which has no native highlight — so Ctrl/Cmd+A
      // "looked unselected". Removing them lets ProseMirror's default Mod+A
      // selectAll through, which uses the browser's selection highlight.
      NodeRange.extend({ addKeyboardShortcuts: () => ({}) }).configure({
        key: "Mod",
      }),
      // GFM tables (parse via markdown-it, serialize via our Table.ts).
      ...tableExtensions,
      // Rich blocks that persist as markdown container directives (no HTML).
      Callout,
      ...toggleExtensions,
      ...columnExtensions,
      WikiLink.configure({
        onWikiLinkClick,
        nestId,
        checkExists: nestId
          ? async (target) => {
              // Match target as id, title, or slug.
              try {
                const { nodes } = await qc.fetchQuery(reads.nodes(nestId));
                const list = nodes as Array<{ id: string; title: string }>;
                const lower = target.toLowerCase();
                const bareSlug = slugFromNodeId(target).toLowerCase();
                
                const exact = list.find(
                  (n) =>
                    n.id.toLowerCase() === lower ||
                    n.title.toLowerCase() === lower ||
                    slugFromNodeId(n.id).toLowerCase() === bareSlug,
                );
                return exact
                  ? { exists: true, id: exact.id }
                  : { exists: false };
              } catch {
                return { exists: false };
              }
            }
          : undefined,
      }),
      TaskCheckbox,
      VideoPreview,
      Mention.configure({
        onMentionClick,
        // Optimistic while the roster is empty (still loading, or no read
        // access) — same rule as the wiki-link existence check.
        isMember: (name) =>
          membersRef.current.length === 0 ||
          isMemberName(membersRef.current, name),
      }),
      SearchReplace,
      // html:true keeps legacy HTML docs loadable; output is markdown.
      Markdown.configure({
        html: true,
        tightLists: true,
        bulletListMarker: "-",
        linkify: false,
        breaks: false,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: escapeUnknownInlineHtml(content),
    editable,
    // Caret-ready on open so you can type immediately (Notion/Obsidian
    // feel). "end" lands at doc end; placeholder shows when empty. A
    // brand-new document passes `false` so the Title field gets focus
    // instead (see DocumentEditor's initial-focus effect).
    autofocus,
    immediatelyRender: false,
    onUpdate: ({ editor, transaction }) => {
      // Only a transaction the USER made counts as an edit. Plugins append
      // their own doc-changing transactions to any dispatch — prosemirror-
      // tables' fixTables normalises a freshly parsed table on the first
      // transaction after load, even an empty one (the mention repaint
      // below) or a click that only moves the selection. tiptap still emits
      // `update` for those, and re-serialising then reported markdown that
      // never round-trips byte-for-byte (`|---|` → `| --- |`) as "Unsaved
      // changes" on open, with a spurious version on the first blur.
      if (!transaction.docChanged) return;
      const md = getEditorMarkdown(editor);
      const isEmpty =
        editor.isEmpty || editor.getText().trim().length === 0;
      onChange(isEmpty ? "" : md);
    },
    editorProps: {
      attributes: {
        class: isPage
          ? "prose dark:prose-invert max-w-none focus:outline-none min-h-[40vh] py-2"
          : "prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-[300px] px-6 py-4",
      },
      // CSV/TSV paste → markdown table. Deliberately conservative: only
      // fires on plain-text clipboards that look unambiguously tabular
      // (see looksLikeDelimitedTable), never inside a code block or an
      // existing table, and never when the clipboard carries an HTML
      // <table> — Sheets/Excel provide one and ProseMirror's native HTML
      // parsing already turns it into table nodes.
      handlePaste: (_view, event) => {
        const ed = editorRef.current;
        if (!ed || !event.clipboardData) return false;
        // A pasted image/video file (a screenshot, a copied image) uploads
        // and inserts exactly like a drop. Before this, handlePaste only knew
        // tables and a pasted screenshot silently did nothing. Never in a
        // read-only / locked / preview doc.
        // Inside a code block or table it falls through, like everything else.
        const pastedMedia = pickMediaFile(event.clipboardData.files);
        if (
          pastedMedia &&
          shouldUploadPastedMedia({
            hasMediaFile: true,
            canUpload: !!onUploadImageRef.current,
            editable: ed.isEditable,
            inCodeBlock: ed.isActive("codeBlock"),
            inTable: ed.isActive("table"),
          })
        ) {
          event.preventDefault();
          void runMediaUploadRef.current(ed, pastedMedia);
          return true;
        }
        if (ed.isActive("codeBlock") || ed.isActive("table")) return false;
        const html = event.clipboardData.getData("text/html");
        if (html && /<table[\s>]/i.test(html)) return false;
        const text = event.clipboardData.getData("text/plain");
        if (!text) return false;
        const detected = looksLikeDelimitedTable(text);
        if (!detected) return false;
        // Handled here → returns true, so the default plain-text paste is
        // skipped (large inputs land as a code block, not a live table).
        return insertDelimitedTable(ed, detected.rows, {
          text,
          delimiter: detected.delimiter,
        });
      },
      // Image/video file dropped onto the editor → same upload + insert
      // as the toolbar picker, at the drop position. An unsupported file
      // type is rejected with a toast (handled, not left to fall through —
      // an unhandled file drop can otherwise navigate the tab to the file).
      // A drag with no files at all still falls through (return false) so
      // ProseMirror's default drop handling — text drags, in-editor block
      // moves — is untouched.
      handleDrop: (view, event) => {
        const ed = editorRef.current;
        const upload = onUploadImageRef.current;
        const files = event.dataTransfer?.files;
        if (!ed || !upload || !files || files.length === 0) return false;
        // ProseMirror fires custom handleDrop even on a read-only view —
        // never upload/insert into a locked or preview-mode doc.
        if (!ed.isEditable) return false;
        const file = files[0];
        if (!MEDIA_FILE_RE.test(file.name)) {
          event.preventDefault();
          toast.error(unsupportedMediaDropMessage(file.name));
          return true;
        }
        event.preventDefault();
        if (files.length > 1) {
          toast("Only the first file was uploaded — drop one file at a time.");
        }
        const pos = view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        })?.pos;
        void runMediaUploadRef.current(ed, file, pos);
        return true;
      },
      handleKeyDown: (_view, event) => {
        const popup = pickerPopupRef.current;
        const results = pickerResultsRef.current;
        if (popup && results.length > 0) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setPickerPopup((s) =>
              s
                ? { ...s, selectedIdx: (s.selectedIdx + 1) % results.length }
                : s,
            );
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setPickerPopup((s) =>
              s
                ? {
                    ...s,
                    selectedIdx:
                      (s.selectedIdx - 1 + results.length) % results.length,
                  }
                : s,
            );
            return true;
          }
          if (event.key === "Enter" || event.key === "Tab") {
            event.preventDefault();
            const pick = results[popup.selectedIdx];
            if (pick) insertPickRef.current?.(pick);
            return true;
          }
        }
        // Escape dismisses the panel whether or not it has results — the
        // empty-state panel is dismissable the same way.
        if (popup && event.key === "Escape") {
          event.preventDefault();
          setPickerPopup(null);
          return true;
        }
        if (
          (event.ctrlKey || event.metaKey) &&
          (event.key === "f" || event.key === "F")
        ) {
          event.preventDefault();
          openSearchRef.current?.();
          return true;
        }
        if ((event.ctrlKey || event.metaKey) && event.key === "s") {
          event.preventDefault();
          onSave?.();
          return true;
        }
        return false;
      },
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (editor && editor.isEditable !== effectiveEditable) {
      // emitUpdate=false: tiptap's setEditable emits a synthetic `update`
      // by default, which re-serialized the (unchanged) document and reported
      // it as an edit — any markdown that doesn't round-trip byte-for-byte
      // (a `|---|` table row comes back as `| --- |`) opened as "Unsaved
      // changes" and wrote a spurious version on the first blur.
      editor.setEditable(effectiveEditable, false);
    }
  }, [editor, effectiveEditable]);

  // Insertion handler kept in a ref so the static `handleKeyDown`
  // closure inside useEditor can call the latest version. Replaces the
  // partial trigger (`[[query` / `@query`) with the row's text.
  const insertPickRef = useRef<((row: { insert: string }) => void) | null>(
    null,
  );
  useEffect(() => {
    insertPickRef.current = (row) => {
      if (!editor) return;
      const popup = pickerPopupRef.current;
      if (!popup) return;
      editor
        .chain()
        .focus()
        .insertContentAt({ from: popup.from, to: popup.to }, row.insert)
        .run();
      setPickerPopup(null);
    };
  }, [editor]);

  // Repaint mention decorations once the roster arrives — an empty
  // transaction is enough to re-run the decoration pass, and without it every
  // mention keeps whatever styling it got before the members were known.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr);
  }, [editor, members]);

  // Detect a `[[query` or `@query` trigger at the cursor on every selection /
  // doc update. Closing the trigger (`]]`, or a space after `@`) ends the
  // match so the popup doesn't linger while the user types on.
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      if (!effectiveEditable) {
        setPickerPopup(null);
        return;
      }
      const { state, view } = editor;
      const { selection } = state;
      if (!selection.empty) {
        setPickerPopup(null);
        return;
      }
      const $from = selection.$from;
      const parentStart = $from.start();
      const before = state.doc.textBetween(
        Math.max(parentStart, $from.pos - 200),
        $from.pos,
        "\n",
        "￼",
      );
      const trigger = detectTrigger(before);
      if (!trigger) {
        setPickerPopup(null);
        return;
      }
      const { kind, query } = trigger;
      const matchStart = $from.pos - trigger.length;
      const coords = view.coordsAtPos($from.pos);
      setPickerPopup((prev) => ({
        kind,
        query,
        from: matchStart,
        to: $from.pos,
        coords: { left: coords.left, top: coords.top, bottom: coords.bottom },
        selectedIdx:
          prev && prev.kind === kind && prev.query === query
            ? prev.selectedIdx
            : 0,
      }));
    };
    editor.on("selectionUpdate", update);
    editor.on("update", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("update", update);
    };
  }, [editor, effectiveEditable]);

  // Load the nest's node list once each time the popup opens (not per
  // keystroke). Re-fetching on open keeps the list fresh (docs created
  // this session show up) while filtering stays local and instant.
  const wikiPopupOpen = pickerPopup?.kind === "wiki";
  useEffect(() => {
    if (!wikiPopupOpen || !nestId) return;
    let cancelled = false;
    setWikiLoading(true);
    (async () => {
      try {
        const res = await qc.fetchQuery(reads.nodes(nestId));
        if (cancelled) return;
        wikiNodesRef.current =
          (res.nodes as Array<{ id: string; title: string }>) || [];
        setWikiNodesVersion((v) => v + 1);
      } catch {
        /* leave the last list in place; filter still works offline */
      } finally {
        if (!cancelled) setWikiLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wikiPopupOpen, nestId]);

  // Never offer the author to themselves (the server skips a self-mention;
  // `members` stays whole so others' mentions of them still resolve).
  const me = useAuth().adminStatus?.me?.email?.toLowerCase();
  // Filter client-side as the query changes. Empty query (just `[[` or `@`)
  // lists everything so users can browse without typing.
  useEffect(() => {
    if (!pickerPopup) {
      setPickerResults([]);
      return;
    }
    if (pickerPopup.kind === "mention") {
      setPickerResults(
        matchMembers(
          members.filter((m) => m.email.toLowerCase() !== me),
          pickerPopup.query,
        ).map((m) => ({
          key: m.email,
          primary: m.name || m.email.split("@")[0],
          secondary: m.email,
          // Insert the email: unique, and what the mention decoration
          // resolves against, so the token stays a real reference.
          insert: `@${m.email} `,
        })),
      );
      return;
    }
    const q = pickerPopup.query.trim().toLowerCase();
    setPickerResults(
      wikiNodesRef.current
        // A doc can't link to itself — drop it from the suggestions.
        .filter((n) => n.id !== currentNodeId)
        .filter((n) => !q || n.title.toLowerCase().includes(q))
        .slice(0, 8)
        .map((n) => ({
          key: n.id,
          primary: n.title,
          secondary: n.id,
          insert: formatWikiLink(n.id, n.title),
        })),
    );
  }, [
    pickerPopup?.kind,
    pickerPopup?.query,
    currentNodeId,
    wikiNodesVersion,
    members,
    me,
  ]);

  // Sync external content only when not focused — avoids selection
  // loss + onUpdate loop on re-render.
  useEffect(() => {
    if (!editor) return;
    if (editor.isFocused) return;
    if (content === getEditorMarkdown(editor)) return;
    editor.commands.setContent(escapeUnknownInlineHtml(content), {
      emitUpdate: false,
    });
  }, [content, editor]);

  useImperativeHandle(
    ref,
    (): MarkdownEditorHandle => ({
      insertWikiLink: (nodeId, title) => {
        if (!editor) return;
        editor.chain().focus().insertContent(formatWikiLink(nodeId, title)).run();
      },
      focus: () => {
        editor?.chain().focus("start").run();
      },
    }),
    [editor],
  );

  // Wire the keydown opener once.
  useEffect(() => {
    openSearchRef.current = () => setSearchOpen(true);
  }, []);

  // Drop this nest's cached wiki-link existence results when the nest
  // changes — a doc created/deleted/renamed elsewhere shouldn't keep
  // showing its old broken/live state here.
  useEffect(() => {
    return () => clearWikiExistsCache(nestId);
  }, [nestId]);

  // Clear the drop indicator (prosemirror-dropcursor) the moment a block is
  // dropped. dropcursor only removes its line on drop/dragend/dragleave fired
  // on the editor DOM, but the ⠿ drag-handle lives outside the editor DOM, so
  // its native `dragend` fires on the handle — never on the editor. The last
  // event the editor sees is a `dragover`, which arms a 5000ms removal timer,
  // so the black line lingers a few seconds. The handle's drag *does* bubble
  // `dragend`/`drop` to document (tiptap's drag-handle listens there too).
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom as HTMLElement;
    const clearDropCursor = () => {
      // Proper path: dropcursor removes its line on `dragleave` with no
      // relatedTarget (not contained in the editor → setCursor(null)).
      dom.dispatchEvent(new DragEvent("dragleave", { bubbles: false }));
      // Belt-and-suspenders: if the line is still in the DOM (the synthetic
      // event doesn't always reach dropcursor's view listeners), collapse it
      // now. dropcursor's updateOverlay rewrites height/width on the next drag
      // and its own timer removes the element later, so this can't break a
      // subsequent drag.
      document
        .querySelectorAll<HTMLElement>(
          ".prosemirror-dropcursor-block, .prosemirror-dropcursor-inline",
        )
        .forEach((el) => {
          el.style.height = "0";
          el.style.width = "0";
        });
    };
    document.addEventListener("dragend", clearDropCursor);
    document.addEventListener("drop", clearDropCursor);
    return () => {
      document.removeEventListener("dragend", clearDropCursor);
      document.removeEventListener("drop", clearDropCursor);
    };
  }, [editor]);

  // Recompute word/char count + heading outline on every doc change.
  useEffect(() => {
    if (!editor) return;
    const recompute = () => {
      const cc = editor.storage.characterCount as
        | { words?: () => number; characters?: () => number }
        | undefined;
      setCounts({
        words: cc?.words?.() ?? 0,
        characters: cc?.characters?.() ?? 0,
      });
      const hs: Array<{ level: number; text: string; pos: number }> = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "heading") {
          hs.push({
            level: node.attrs.level as number,
            text: node.textContent || "Untitled",
            pos,
          });
        }
      });
      setHeadings(hs);
    };
    recompute();
    editor.on("update", recompute);
    return () => {
      editor.off("update", recompute);
    };
  }, [editor]);

  // Hover-preview for `[[wiki links]]`. Delegated on the editor DOM so it
  // covers every decoration without per-link listeners. Debounced; fetches
  // the linked doc's content client-side and shows a short excerpt.
  useEffect(() => {
    if (!editor || !nestId) return;
    const dom = editor.view.dom as HTMLElement;
    let timer: number | undefined;
    let activeEl: HTMLElement | null = null;
    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest(
        ".wiki-link",
      ) as HTMLElement | null;
      if (!el || el === activeEl) return;
      activeEl = el;
      const id = el.getAttribute("data-wiki-id");
      const title =
        el.getAttribute("data-wiki-display") ||
        el.getAttribute("data-wiki-title") ||
        "";
      const rect = el.getBoundingClientRect();
      window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        if (!id) {
          setWikiPreview({
            title,
            excerpt: "Not found in this nest yet.",
            left: rect.left,
            top: rect.bottom + 6,
          });
          return;
        }
        try {
          // A hover preview, not an edit: overriding the document staleness
          // (0, so an edit always starts from server truth) lets re-hovering
          // the same link read from cache instead of refetching the body.
          const { node } = await qc.fetchQuery({
            ...reads.node(nestId, id),
            staleTime: 30_000,
          });
          const content = ((node?.content as string) || "")
            .replace(/```[\s\S]*?```/g, "")
            .replace(/[#>*`_~|-]/g, "")
            .replace(/\n{2,}/g, "\n")
            .trim();
          setWikiPreview({
            title: node?.title || title,
            excerpt: content.slice(0, 280) || "(empty document)",
            left: rect.left,
            top: rect.bottom + 6,
          });
        } catch {
          setWikiPreview(null);
        }
      }, 350);
    };
    const onOut = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".wiki-link")) return;
      activeEl = null;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setWikiPreview(null), 150);
    };
    dom.addEventListener("mouseover", onOver);
    dom.addEventListener("mouseout", onOut);
    return () => {
      dom.removeEventListener("mouseover", onOver);
      dom.removeEventListener("mouseout", onOut);
      window.clearTimeout(timer);
    };
  }, [editor, nestId]);

  // Jump the caret to a heading from the outline panel.
  const gotoHeading = (pos: number) => {
    if (!editor) return;
    editor
      .chain()
      .focus()
      .setTextSelection(pos + 1)
      .scrollIntoView()
      .run();
    setOutlineOpen(false);
  };

  // Forward editor blur (click-out) to the parent for silent autosave.
  // Ref keeps the latest callback without re-binding the listener.
  const onBlurRef = useRef(onBlur);
  useEffect(() => {
    onBlurRef.current = onBlur;
  }, [onBlur]);
  useEffect(() => {
    if (!editor) return;
    const handler = () => onBlurRef.current?.();
    editor.on("blur", handler);
    return () => {
      editor.off("blur", handler);
    };
  }, [editor]);

  // Keep blockTarget.pos valid across document edits. The drag handle only
  // re-reports its position via onNodeChange when the pointed node changes, so
  // a paste (or any edit that shifts positions) leaves the last-reported pos
  // stale — the block menu would then act on the wrong block. Remap it through
  // each transaction's mapping so it always points at the same block.
  useEffect(() => {
    if (!editor) return;
    const onTr = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged) return;
      setBlockTarget((bt) =>
        bt ? { pos: transaction.mapping.map(bt.pos) } : bt,
      );
    };
    editor.on("transaction", onTr);
    return () => {
      editor.off("transaction", onTr);
    };
  }, [editor]);

  // Close the open block menu on any outside mousedown. Handle/menu stop
  // propagation so their own clicks don't trip this.
  useEffect(() => {
    if (!blockMenuOpen) return;
    const close = () => {
      setBlockMenuOpen(false);
      setMenuPos(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [blockMenuOpen]);

  const closeBlockMenu = () => {
    setBlockMenuOpen(false);
    setMenuPos(null);
  };

  // Keep the block-action menu inside the viewport: flip above the handle when
  // it would overflow the bottom, clamp to the right edge, and cap the height
  // (scroll) on short screens so the lower items aren't cut off.
  useLayoutEffect(() => {
    if (!blockMenuOpen || !menuPos) return;
    const el = blockMenuRef.current;
    if (!el) return;
    const margin = 8;
    const { offsetHeight: h, offsetWidth: w } = el;
    const vh = window.innerHeight;
    const vw = window.innerWidth;

    let top = menuPos.top;
    if (top + h > vh - margin) {
      const above = menuPos.anchorTop - h - 4;
      top = above >= margin ? above : Math.max(margin, vh - h - margin);
    }
    let left = menuPos.left;
    if (left + w > vw - margin) left = Math.max(margin, vw - w - margin);

    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
    el.style.maxHeight = `${vh - margin * 2}px`;
    el.style.overflowY = "auto";
  }, [blockMenuOpen, menuPos]);

  // Read the node fresh at action time (blockTarget.pos tracks the handle's
  // current block, so it's up to date when the menu opens).
  const blockNodeAt = (pos: number) => editor?.state.doc.nodeAt(pos) ?? null;

  const duplicateBlock = () => {
    if (!editor || !blockTarget) return;
    const node = blockNodeAt(blockTarget.pos);
    if (!node) return;
    editor
      .chain()
      .focus()
      .insertContentAt(blockTarget.pos + node.nodeSize, node.toJSON())
      .run();
    closeBlockMenu();
  };

  const deleteBlock = () => {
    if (!editor || !blockTarget) return;
    const node = blockNodeAt(blockTarget.pos);
    if (!node) return;
    const from = blockTarget.pos;
    const to = from + node.nodeSize;
    closeBlockMenu();
    const run = () =>
      editor.chain().focus().deleteRange({ from, to }).run();
    // A big node (image, table, or a large CSV/code block) can stall the main
    // thread while ProseMirror re-renders the delete. Show a loader and defer
    // two frames so it paints before the synchronous delete freezes the UI;
    // small blocks delete inline with no toast noise.
    const heavy =
      node.type.name === "image" ||
      node.type.name === "table" ||
      node.type.name === "codeBlock" ||
      node.nodeSize > 400;
    if (!heavy) {
      run();
      return;
    }
    const toastId = toast.loading("Deleting…");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        run();
        toast.success("Deleted.", { id: toastId });
      }),
    );
  };

  // Turn-into: put the caret inside the handle's block, then run the block
  // toggle so the conversion targets that block (not wherever focus was).
  const turnBlockInto = (apply: (chain: ReturnType<Editor["chain"]>) => void) => {
    if (!editor || !blockTarget) return;
    const chain = editor.chain().focus().setTextSelection(blockTarget.pos + 1);
    apply(chain);
    closeBlockMenu();
  };

  // "Turn into → Toggle". setDetails() wraps the line into the collapsed BODY
  // with an empty summary — the text vanishes and the block reads as a stray
  // bullet. Instead build the toggle with the line's text as its SUMMARY
  // (the visible header) and open it, so nothing is hidden.
  const turnIntoToggle = () => {
    if (!editor || !blockTarget) return;
    const node = editor.state.doc.nodeAt(blockTarget.pos);
    if (!node) return;
    const from = blockTarget.pos;
    const to = from + node.nodeSize;
    const text = node.textContent;
    editor
      .chain()
      .focus()
      .insertContentAt(
        { from, to },
        {
          type: "details",
          attrs: { open: true },
          content: [
            {
              type: "detailsSummary",
              ...(text ? { content: [{ type: "text", text }] } : {}),
            },
            { type: "detailsContent", content: [{ type: "paragraph" }] },
          ],
        },
      )
      .run();
    closeBlockMenu();
  };

  const syncMatchInfo = (s: SearchState) =>
    setMatchInfo({
      current: s.results.length ? s.current + 1 : 0,
      total: s.results.length,
    });

  // Re-run the search whenever the query (or open state) changes.
  useEffect(() => {
    if (!editor) return;
    if (!searchOpen) {
      clearSearch(editor);
      return;
    }
    syncMatchInfo(setSearch(editor, searchQuery));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, searchOpen, searchQuery]);

  const searchNext = () => editor && syncMatchInfo(gotoMatch(editor, 1));
  const searchPrev = () => editor && syncMatchInfo(gotoMatch(editor, -1));
  const doReplace = () => {
    if (!editor) return;
    // Use the state replaceCurrent returns — re-running setSearch here would
    // snap the index back to match 0 instead of advancing to the next hit.
    syncMatchInfo(replaceCurrent(editor, replaceText));
  };
  const doReplaceAll = () => {
    if (!editor) return;
    syncMatchInfo(replaceAll(editor, replaceText));
  };
  const closeSearch = () => setSearchOpen(false);

  const [linkDialog, setLinkDialog] = useState<{
    open: boolean;
    url: string;
    error: string | null;
  }>({ open: false, url: "", error: null });

  const setLink = () => {
    if (!editor) return;
    const previous = (editor.getAttributes("link").href as string) ?? "";
    setLinkDialog({ open: true, url: previous, error: null });
  };

  const confirmLink = () => {
    if (!editor) return;
    const result = normalizeLinkUrl(linkDialog.url);
    if (result.url === null) {
      setLinkDialog((s) => ({ ...s, error: result.error }));
      return;
    }
    const chain = editor.chain().focus().extendMarkRange("link");
    if (result.url === "") {
      chain.unsetLink().run();
    } else {
      chain.setLink({ href: result.url }).run();
    }
    setLinkDialog({ open: false, url: "", error: null });
  };

  if (!editor) {
    return isPage ? (
      <div className="animate-pulse bg-muted/20 h-[40vh] rounded-md" />
    ) : (
      <div className="border rounded-lg bg-background shadow-sm">
        <div className="h-12 bg-muted/40 rounded-t-lg border-b" />
        <div className="animate-pulse bg-muted/20 h-[300px] rounded-b-lg" />
      </div>
    );
  }

  return (
    <div
      ref={wrapperRef}
      className={cn(
        "relative",
        isPage ? "" : "border rounded-lg bg-background shadow-sm",
        className,
      )}
      data-variant={variant}
      // Drop-overlay bookkeeping only — the drop itself is still ProseMirror's
      // handleDrop (the overlay is pointer-events-none, so it never eats it).
      onDragOver={(e) => {
        if (media.dropOverlay && isFileDrag(e.dataTransfer?.types)) {
          const show = !isUnsupportedFileDrag(e.dataTransfer?.items);
          if (fileDragOver !== show) setFileDragOver(show);
        }
      }}
      onDragLeave={(e) => {
        const next = e.relatedTarget as Node | null;
        if (!next || !e.currentTarget.contains(next)) setFileDragOver(false);
      }}
      onDropCapture={() => setFileDragOver(false)}
    >
      {media.dropOverlay && fileDragOver && (
        <div
          className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-primary/60 bg-background/80"
          data-testid="markdown-editor-drop-overlay"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            <ImagePlus className="h-4 w-4" />
            Drop to add an image or video
          </span>
        </div>
      )}
      {/* Page mode: the toolbar is always there in edit mode — it is what says
          "this is an editor". It sticks a little under the document top bar
          (h-12) so the two bars read as separate surfaces while scrolling. */}
      {editable && (
        <div
          className={cn(
            "sticky z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75",
            isPage
              ? "top-14 -mx-2 mb-3 rounded-md border shadow-sm"
              : "top-0 border-b",
            toolbarHidden && "invisible",
          )}
          aria-hidden={toolbarHidden || undefined}
          data-testid="markdown-editor-toolbar"
        >
          <Toolbar
            editor={editor}
            onLink={setLink}
            onRequestDocLink={onRequestDocLink}
            onMediaFile={
              media.upload
                ? (file) => void runMediaUpload(editor, file)
                : undefined
            }
            canEmbed={media.embed}
            uploading={uploading}
            previewing={previewing}
            onTogglePreview={() =>
              setPreviewing((p) => {
                if (!p && editor) setPreviewMarkdown(getEditorMarkdown(editor));
                return !p;
              })
            }
            end={toolbarEnd}
          />
        </div>
      )}

      {/* Find/replace bar (Cmd+F). Sticky under the toolbar. */}
      {editable && searchOpen && (
        <div
          className={cn(
            "sticky z-30 flex flex-wrap items-center gap-1 border-b bg-background/95 px-2 py-1 backdrop-blur",
            isPage ? "top-[6.75rem]" : "top-0",
          )}
        >
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <Input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              }
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) searchPrev();
                else searchNext();
              }
            }}
            placeholder="Find"
            className="h-7 w-40"
          />
          <span className="w-14 text-center text-xs text-muted-foreground tabular-nums">
            {matchInfo.total ? `${matchInfo.current}/${matchInfo.total}` : "0/0"}
          </span>
          <ToolbarButton onClick={searchPrev} title="Previous (Shift+Enter)">
            <ChevronUp className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton onClick={searchNext} title="Next (Enter)">
            <ChevronDown className="h-3.5 w-3.5" />
          </ToolbarButton>
          <Input
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            placeholder="Replace"
            className="h-7 w-40"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7"
            onMouseDown={(e) => e.preventDefault()}
            onClick={doReplace}
          >
            Replace
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7"
            onMouseDown={(e) => e.preventDefault()}
            onClick={doReplaceAll}
          >
            All
          </Button>
          <ToolbarButton onClick={closeSearch} title="Close (Esc)">
            <X className="h-3.5 w-3.5" />
          </ToolbarButton>
        </div>
      )}

      {/* Selection bubble toolbar — format-on-highlight, Notion-style. Only
          when editing (not in read-only preview). Buttons reuse the
          onMouseDown-preventDefault guard so the selection survives the click. */}
      {editable && !previewing && (
        <BubbleMenu
          editor={editor}
          // The menu is appended inside the overflow-y-auto content viewport, so
          // a top-of-doc selection would place it above the first line where it
          // gets clipped by the scroll overflow and hidden behind the sticky
          // z-20 toolbar. Bounding flip to that viewport (scrollRef) makes a
          // top-edge selection overflow the boundary and flip to `bottom`, where
          // it's fully visible; z-50 on the menu keeps it above the toolbar.
          options={{
            flip: { boundary: (isPage ? undefined : scrollRef.current) ?? undefined, padding: 8 },
            shift: { boundary: (isPage ? undefined : scrollRef.current) ?? undefined, padding: 8 },
          }}
          className="z-50 flex items-center gap-0.5 rounded-md border bg-popover p-1 shadow-md"
        >
          <ToolbarButton
            active={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
            title="Bold (Ctrl+B)"
          >
            <Bold className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            title="Italic (Ctrl+I)"
          >
            <Italic className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("strike")}
            onClick={() => editor.chain().focus().toggleStrike().run()}
            title="Strikethrough"
          >
            <Strikethrough className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("code")}
            onClick={() => editor.chain().focus().toggleCode().run()}
            title="Inline code"
          >
            <Code className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("link")}
            onClick={setLink}
            title="Link"
          >
            <LinkIcon className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("highlight")}
            onClick={() => editor.chain().focus().toggleHighlight().run()}
            title="Highlight (==text==)"
          >
            <Highlighter className="h-3.5 w-3.5" />
          </ToolbarButton>

          <Divider />

          {/* Text color swatches — saved with the document (see the
              TextStyle/Color import comment above) and rendered on view too
              (DocumentViewer's remarkColorSpans). Selection collapses to the
              end on pick so the applied color is visible immediately instead
              of staying hidden under the selection highlight, and the menu
              closes with it (BubbleMenu only shows for a live selection). */}
          {["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6"].map((c) => (
            <button
              key={c}
              type="button"
              title={`Text color ${c}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const { to } = editor.state.selection;
                editor.chain().focus().setColor(c).setTextSelection(to).run();
              }}
              className="m-0.5 h-4 w-4 rounded-full border border-border"
              style={{ backgroundColor: c }}
            />
          ))}
          <ToolbarButton
            onClick={() => editor.chain().focus().unsetColor().run()}
            title="Clear color"
          >
            <X className="h-3.5 w-3.5" />
          </ToolbarButton>

          <Divider />

          {/* Turn into — convert the selected block's type inline (Notion-style). */}
          <ToolbarButton
            active={editor.isActive("heading", { level: 1 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
            title="Turn into Heading 1"
          >
            <Heading1 className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("heading", { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            title="Turn into Heading 2"
          >
            <Heading2 className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("bulletList")}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            title="Turn into bullet list"
          >
            <List className="h-3.5 w-3.5" />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("blockquote")}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            title="Turn into quote"
          >
            <Quote className="h-3.5 w-3.5" />
          </ToolbarButton>
        </BubbleMenu>
      )}

      {previewing && (
        <DocumentViewer
          content={previewMarkdown}
          onWikiLinkClick={(title, displayText) =>
            onWikiLinkClick?.(title, null, displayText)
          }
          previewFor={nestId ? previewFor : undefined}
        />
      )}

      <EditorContent
        ref={scrollRef}
        editor={editor}
        className={cn(
          isPage ? "min-h-[40vh]" : "min-h-[60vh] max-h-[60vh] overflow-y-auto",
          previewing && "hidden",
        )}
        // Click the empty area below the last block → caret to doc end.
        // The ProseMirror node only grows to its content height, so clicks
        // in the surrounding scroll region never reach contenteditable.
        onMouseDown={(e) => {
          if (!effectiveEditable) return;
          const pmDom = editor.view.dom as HTMLElement;
          if (e.clientY <= pmDom.getBoundingClientRect().bottom) return;
          e.preventDefault();
          editor
            .chain()
            .focus()
            .setTextSelection(editor.state.doc.content.size)
            .run();
        }}
        data-testid="markdown-editor-content"
      />

      {/* Notion-style inline table grips (hover a table to reveal). */}
      {effectiveEditable && <TableControls editor={editor} />}

      {/* Footer: word/char count + outline toggle. */}
      {editable && (
        <div
          className={cn(
            "flex items-center gap-3 py-1 text-xs text-muted-foreground",
            isPage ? "mt-4 opacity-60 hover:opacity-100" : "border-t px-3",
          )}
        >
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOutlineOpen((o) => !o)}
            className="flex items-center gap-1 rounded px-1 hover:bg-muted hover:text-foreground"
            title="Document outline"
          >
            <List className="h-3.5 w-3.5" />
            Outline
          </button>
          <span className="ml-auto tabular-nums">
            {counts.words} words · {counts.characters} chars
          </span>
        </div>
      )}

      {/* Document outline (TOC) — built from headings, click to jump. */}
      {editable && outlineOpen && (
        <div
          className="absolute bottom-9 right-3 z-40 max-h-72 w-64 overflow-y-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="border-b px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Outline
          </div>
          {headings.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              No headings yet.
            </div>
          ) : (
            <ul className="py-1">
              {headings.map((h, i) => (
                <li key={`${h.pos}-${i}`}>
                  <button
                    type="button"
                    onClick={() => gotoHeading(h.pos)}
                    className="block w-full truncate px-3 py-1 text-left text-sm hover:bg-muted"
                    style={{ paddingLeft: 12 + (h.level - 1) * 12 }}
                    title={h.text}
                  >
                    {h.text}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Wiki-link hover preview. */}
      {wikiPreview && (
        <div
          className="fixed z-50 w-72 rounded-md border bg-popover p-3 text-popover-foreground shadow-md"
          style={{ left: wikiPreview.left, top: wikiPreview.top }}
        >
          <div className="mb-1 truncate text-sm font-medium">
            {wikiPreview.title}
          </div>
          <div className="line-clamp-4 whitespace-pre-wrap text-xs text-muted-foreground">
            {wikiPreview.excerpt}
          </div>
        </div>
      )}

      {/* Rendered even with no results: typing `[[` in an empty nest used to
          do nothing at all, which reads as a broken feature. */}
      {pickerPopup && (() => {
        // Panel is w-72 (288px) / max-h-64 (256px), fixed-positioned at the
        // caret. Near the bottom or right edge of the viewport it would clip
        // off-screen, so flip it above the caret when space below is short,
        // and clamp its left so it never runs past the right edge. maxHeight
        // is set to the space available on the chosen side so a long list
        // scrolls inside the panel instead of overflowing the viewport.
        const PANEL_W = 288;
        const PANEL_H = 256;
        const GAP = 4;
        const MARGIN = 8;
        const { left, top, bottom } = pickerPopup.coords;
        const isMention = pickerPopup.kind === "mention";
        const spaceBelow = window.innerHeight - bottom;
        const spaceAbove = top;
        const flipUp = spaceBelow < PANEL_H + GAP && spaceAbove > spaceBelow;
        const clampedLeft = Math.max(
          MARGIN,
          Math.min(left, window.innerWidth - PANEL_W - MARGIN),
        );
        const style = flipUp
          ? {
              left: clampedLeft,
              bottom: window.innerHeight - top + GAP,
              maxHeight: spaceAbove - GAP - MARGIN,
            }
          : {
              left: clampedLeft,
              top: bottom + GAP,
              maxHeight: spaceBelow - GAP - MARGIN,
            };
        return (
        <div
          className="fixed z-50 w-72 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md"
          style={style}
          // Avoid stealing editor focus so the cursor selection that
          // `insertContentAt` targets stays intact.
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground border-b">
            {isMention ? "Mention a person" : "Link a document"}
          </div>
          {pickerResults.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {isMention
                ? pickerPopup.query.trim()
                  ? `Nobody on this nest matches “${pickerPopup.query.trim()}”.`
                  : "Nobody to mention yet — share the nest to add people."
                : wikiLoading
                  ? "Loading documents…"
                  : pickerPopup.query.trim()
                    ? `No documents match “${pickerPopup.query.trim()}”.`
                    : "No documents to link yet."}
            </div>
          ) : (
          <ul className="py-1">
            {pickerResults.map((row, idx) => (
              <li key={row.key}>
                <button
                  type="button"
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-sm hover:bg-muted",
                    idx === pickerPopup.selectedIdx && "bg-muted",
                  )}
                  onClick={() => insertPickRef.current?.(row)}
                >
                  <div className="truncate font-medium">{row.primary}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {row.secondary}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          )}
        </div>
        );
      })()}

      {/* Drag handle (⠿). The official extension positions it in the left
          gutter of the hovered block and handles drag-to-reorder natively.
          Dragging the handle moves the block; a plain click opens the action
          menu. onMousedown stopPropagation keeps the editor selection and
          dodges the outside-click closer. */}
      {effectiveEditable && (
        <DragHandle
          editor={editor}
          onNodeChange={({ node, pos }) =>
            setBlockTarget(node ? { pos } : null)
          }
        >
          <button
            type="button"
            title="Drag to move · click for actions"
            data-block-handle
            className="flex h-6 w-5 cursor-grab items-center justify-center rounded text-muted-foreground/70 hover:bg-muted hover:text-foreground active:cursor-grabbing"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setMenuPos({ top: r.bottom + 2, left: r.left, anchorTop: r.top });
              setBlockMenuOpen((o) => !o);
            }}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        </DragHandle>
      )}

      {effectiveEditable && blockMenuOpen && menuPos && (
        <div
          ref={blockMenuRef}
          data-block-handle
          className="fixed z-50 min-w-44 select-none overflow-hidden rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
          style={{ top: menuPos.top, left: menuPos.left }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <div className="px-3 pb-1 pt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            Turn into
          </div>
          <BlockMenuItem
            onClick={() => turnBlockInto((c) => c.setParagraph().run())}
          >
            <FileText className="h-3.5 w-3.5" /> Text
          </BlockMenuItem>
          <BlockMenuItem
            onClick={() =>
              turnBlockInto((c) => c.toggleHeading({ level: 1 }).run())
            }
          >
            <Heading1 className="h-3.5 w-3.5" /> Heading 1
          </BlockMenuItem>
          <BlockMenuItem
            onClick={() =>
              turnBlockInto((c) => c.toggleHeading({ level: 2 }).run())
            }
          >
            <Heading2 className="h-3.5 w-3.5" /> Heading 2
          </BlockMenuItem>
          <BlockMenuItem
            onClick={() => turnBlockInto((c) => c.toggleBulletList().run())}
          >
            <List className="h-3.5 w-3.5" /> Bullet list
          </BlockMenuItem>
          <BlockMenuItem
            onClick={() => turnBlockInto((c) => c.toggleBlockquote().run())}
          >
            <Quote className="h-3.5 w-3.5" /> Quote
          </BlockMenuItem>
          <BlockMenuItem
            onClick={() => turnBlockInto((c) => c.toggleCallout("info").run())}
          >
            <Info className="h-3.5 w-3.5" /> Callout
          </BlockMenuItem>
          <BlockMenuItem
            onClick={turnIntoToggle}
          >
            <ChevronRight className="h-3.5 w-3.5" /> Toggle
          </BlockMenuItem>
          <BlockMenuItem
            onClick={() => turnBlockInto((c) => c.insertColumns(2).run())}
          >
            <Columns2 className="h-3.5 w-3.5" /> Columns
          </BlockMenuItem>
          <div className="my-1 h-px bg-border" />
          <BlockMenuItem onClick={duplicateBlock}>
            <Copy className="h-3.5 w-3.5" /> Duplicate
          </BlockMenuItem>
          <BlockMenuItem onClick={deleteBlock} destructive>
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </BlockMenuItem>
        </div>
      )}

      <Dialog
        open={linkDialog.open}
        onOpenChange={(open) =>
          setLinkDialog((s) => ({ ...s, open, error: open ? s.error : null }))
        }
      >
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Insert link</DialogTitle>
            <DialogDescription>
              Paste a URL. Bare domains get <code>https://</code> added
              automatically. Leave blank to remove the link.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Label htmlFor="link-url" className="text-xs">URL</Label>
            <Input
              id="link-url"
              autoFocus
              placeholder="https://example.com"
              value={linkDialog.url}
              onChange={(e) =>
                setLinkDialog((s) => ({ ...s, url: e.target.value, error: null }))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  confirmLink();
                }
              }}
            />
            {linkDialog.error && (
              <p className="text-xs text-destructive">{linkDialog.error}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                setLinkDialog({ open: false, url: "", error: null })
              }
            >
              Cancel
            </Button>
            <Button onClick={confirmLink}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});

function BlockMenuItem({
  onClick,
  destructive,
  children,
}: {
  onClick: () => void;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted",
        destructive && "text-destructive",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export default MarkdownEditor;

/**
 * Insert parsed CSV/TSV as editor content. Shared by the paste interceptor
 * and the file-upload button so the guard copy and header UX stay in one
 * place. Always returns true (the paste path returns it verbatim: the content
 * is handled here, never left to the default plain-text paste).
 *
 * Small inputs become a live markdown table with a one-click header override.
 * Large inputs (> LARGE_TABLE_ROW_THRESHOLD data rows) become a fenced
 * `csv`/`tsv` code block instead: a live table that big stutters ProseMirror's
 * render and typing, whereas a code block is a single cheap text node. Both
 * are plain markdown — diffable, versioned, and readable by every downstream
 * consumer — so nothing new is stored either way. The rejected form is offered
 * as a one-click, informed opt-in.
 */
function insertDelimitedTable(
  editor: Editor,
  rows: string[][],
  raw: { text: string; delimiter: Delimiter },
): boolean {
  const hasHeader = detectHeaderRow(rows);
  const dataRows = rows.length - (hasHeader ? 1 : 0);
  const insertTable = (header: boolean) =>
    editor
      .chain()
      .focus()
      .insertContent(rowsToMarkdownTable(rows, { hasHeader: header }))
      .run();

  if (dataRows > LARGE_TABLE_ROW_THRESHOLD) {
    const lang = raw.delimiter === "\t" ? "tsv" : "csv";
    // Fenced code block via markdown so tiptap-markdown parses it to a real
    // codeBlock node (same insert path as the table markdown below).
    const fence = "```" + lang + "\n" + raw.text.trim() + "\n```";
    editor.chain().focus().insertContent(fence).run();
    toast(
      `${dataRows.toLocaleString()} rows kept as a ${lang.toUpperCase()} ` +
        `code block — a live table this large slows the editor.`,
      {
        action: {
          label: "Insert as table anyway",
          onClick: () => {
            editor.chain().focus().undo().run();
            insertTable(hasHeader);
          },
        },
      },
    );
    return true;
  }

  insertTable(hasHeader);
  // Header detection is a heuristic, so surface the manual toggle the ticket
  // asks for as a one-click correction. Undo drops the just-inserted table
  // (one insertContent = one undo step); re-insert with the flipped choice.
  toast("Table inserted.", {
    action: {
      label: hasHeader ? "First row is data" : "First row is header",
      onClick: () => {
        editor.chain().focus().undo().run();
        insertTable(!hasHeader);
      },
    },
  });
  return true;
}

// Media allowlist + size caps live in lib/editor-media.ts (shared with the
// toolbar's helper text and the paste/drop pickers).

/**
 * Upload an image/video via the caller's asset uploader and insert the
 * reference at the cursor (or at `insertPos`, e.g. drop coordinates).
 * Images insert as an image node (persists as `![alt](url)`); videos
 * insert as the bare asset URL on its own paragraph line — the read view
 * upgrades same-origin asset video URLs to a <video> player.
 * Shared by the toolbar picker and editor drag-drop.
 */
async function uploadAndInsertMedia(
  editor: Editor,
  file: File,
  upload: (file: File) => Promise<string>,
  insertPos?: number,
): Promise<void> {
  const isVideo = VIDEO_FILE_RE.test(file.name);
  const kind = isVideo ? "video" : "image";
  const maxBytes = isVideo ? VIDEO_MAX_UPLOAD_BYTES : IMAGE_MAX_UPLOAD_BYTES;
  if (file.size > maxBytes) {
    toast.error(
      `That ${kind} is ${(file.size / (1024 * 1024)).toFixed(1)} MB — ` +
        `the limit is ${maxBytes / (1024 * 1024)} MB.`,
    );
    return;
  }
  const toastId = toast.loading(
    `Uploading ${kind}… (${(file.size / (1024 * 1024)).toFixed(1)} MB)`,
  );
  try {
    const url = await upload(file);
    let chain = editor.chain().focus();
    if (insertPos !== undefined) chain = chain.setTextSelection(insertPos);
    if (isVideo) {
      chain
        .insertContent({
          type: "paragraph",
          content: [{ type: "text", text: url }],
        })
        .run();
    } else {
      chain
        .setImage({ src: url, alt: file.name.replace(/\.[^.]+$/, "") })
        .run();
    }
    toast.success(`${isVideo ? "Video" : "Image"} uploaded.`, { id: toastId });
  } catch (err: any) {
    toast.error(err?.message || `${kind} upload failed`, { id: toastId });
  }
}

function Toolbar({
  editor,
  onLink,
  onRequestDocLink,
  onMediaFile,
  canEmbed,
  uploading,
  previewing,
  onTogglePreview,
  end,
}: {
  editor: Editor;
  onLink: () => void;
  onRequestDocLink?: () => void;
  /** Picked image/video file. Parent owns the shared single-flight
   *  upload guard (toolbar + drag-drop) and the insert. */
  onMediaFile?: (file: File) => void;
  /** Show "Embed YouTube or Vimeo link" (false in read-only / preview). */
  canEmbed: boolean;
  uploading: boolean;
  previewing: boolean;
  onTogglePreview: () => void;
  end?: React.ReactNode;
}) {
  const roving = useRovingFocus<HTMLDivElement>();
  // Hidden file input driven by the "Insert table from CSV" toolbar button.
  const csvInputRef = useRef<HTMLInputElement>(null);
  const pickCsv = () => csvInputRef.current?.click();
  const onCsvPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    const toastId = toast.loading("Processing file…");
    // Let the loader actually paint before the (synchronous, possibly heavy)
    // read + parse blocks the main thread — two frames clears the commit+paint.
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
    );
    // Size cap, read, delimiter resolution, parse — shared with the
    // table-node source editor (csv-table.readUploadedTable).
    const res = await readUploadedTable(file);
    if (!res.ok) {
      toast.error(uploadedTableErrorMessage(res.error, file), { id: toastId });
      return;
    }
    // insertDelimitedTable pops its own result toast; drop the loader first.
    toast.dismiss(toastId);
    insertDelimitedTable(editor, res.rows, {
      text: res.text,
      delimiter: res.delimiter,
    });
  };

  // Hidden file input driven by the "Image or video" toolbar button.
  // Upload + insert (and the single-flight guard shared with drag-drop)
  // live in the parent via onMediaFile.
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const pickMedia = () => mediaInputRef.current?.click();
  const onMediaPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (file) onMediaFile?.(file);
  };

  // "Embed YouTube or Vimeo link": validated with toEmbedUrl (via
  // validateEmbedInput), inserted as the bare URL on its own paragraph — the
  // VideoPreview decoration shows the player, the markdown stays the URL.
  const [embedDialog, setEmbedDialog] = useState<{
    open: boolean;
    url: string;
    error: string | null;
  }>({ open: false, url: "", error: null });
  const confirmEmbed = () => {
    const res = validateEmbedInput(embedDialog.url);
    if (!res.ok) {
      setEmbedDialog((d) => ({ ...d, error: res.error }));
      return;
    }
    editor
      .chain()
      .focus()
      .insertContent({
        type: "paragraph",
        content: [{ type: "text", text: res.url }],
      })
      .run();
    setEmbedDialog({ open: false, url: "", error: null });
  };
  // In preview mode every formatting affordance is irrelevant — collapse
  // the toolbar to just the toggle so the user has one obvious way back
  // to editing.
  if (previewing) {
    return (
      <div
        className="flex items-center gap-0.5 p-1 flex-wrap"
        role="toolbar"
        aria-label="Editor"
      >
        <ToolbarButton
          active
          onClick={onTogglePreview}
          title="Back to editing"
          label="Edit"
        >
          <Pencil className="h-3.5 w-3.5" />
        </ToolbarButton>
        <span className="text-xs text-muted-foreground px-2">
          Preview — read-only
        </span>
      </div>
    );
  }

  return (
    // One tab stop for the whole strip; arrows move between the buttons, so
    // Tab out of the Title field reaches the writing area in one press
    // instead of twenty-odd.
    <div
      className="flex items-center gap-0.5 p-1 flex-wrap"
      role="toolbar"
      aria-label="Formatting"
      {...roving}
    >
      <ToolbarButton
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
        title="Bold (Ctrl+B)"
      >
        <Bold className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        title="Italic (Ctrl+I)"
      >
        <Italic className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        title="Strikethrough"
      >
        <Strikethrough className="h-3.5 w-3.5" />
      </ToolbarButton>

      <Divider />

      {/* Every level the schema accepts gets a button: markdown shortcuts
          reach H6, so stopping the toolbar at H3 left three levels that could
          be typed but never clicked (CU-wdqcpzzuv6). */}
      {HEADING_LEVELS.map((level) => {
        const Icon = HEADING_ICONS[level];
        return (
          <ToolbarButton
            key={level}
            active={editor.isActive("heading", { level })}
            onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
            title={`Heading ${level}`}
          >
            <Icon className="h-3.5 w-3.5" />
          </ToolbarButton>
        );
      })}

      <Divider />

      <ToolbarButton
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        title="Bullet list"
      >
        <List className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        title="Numbered list"
      >
        <ListOrdered className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() =>
          editor.chain().focus().insertContent("[ ] ").run()
        }
        title="Insert task ([ ])"
      >
        <CheckSquare className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        title="Quote"
      >
        <Quote className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("codeBlock")}
        onClick={() => toggleCodeBlockMerged(editor)}
        title="Code block"
      >
        <Code className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("table")}
        onClick={() =>
          editor
            .chain()
            .focus()
            .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
            .run()
        }
        title="Insert table"
      >
        <TableIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      {/* Labelled, not icon-only: "you can add images and videos" should be
          obvious, not a tooltip on an upload glyph. The label collapses to
          the icon on narrow toolbars. */}
      {(onMediaFile || canEmbed) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              title="Add an image or video"
              // Match ToolbarButton: don't blur the editor before the menu opens.
              onMouseDown={(e) => e.preventDefault()}
              className="h-7 gap-1 px-2"
              disabled={uploading}
              data-testid="markdown-editor-media-button"
            >
              <ImagePlus className="h-3.5 w-3.5" />
              <span className="hidden text-xs sm:inline">Image / video</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {onMediaFile && (
              <DropdownMenuItem onSelect={pickMedia} className="items-start">
                <Upload className="mr-2 mt-0.5 h-4 w-4" />
                <span className="flex flex-col">
                  <span>Upload image or video</span>
                  <span className="text-xs text-muted-foreground">
                    {MEDIA_HELPER_TEXT}
                  </span>
                </span>
              </DropdownMenuItem>
            )}
            {canEmbed && (
              <DropdownMenuItem
                onSelect={() =>
                  setEmbedDialog({ open: true, url: "", error: null })
                }
              >
                <Video className="mr-2 h-4 w-4" />
                Embed YouTube or Vimeo link
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {/* Other file imports (CSV / TSV → table). Images and videos have
          their own labelled button above. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title="Upload a file"
            // Match ToolbarButton: don't blur the editor before the menu opens.
            onMouseDown={(e) => e.preventDefault()}
            className="h-7 w-7 p-0"
            disabled={uploading}
          >
            <Upload className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onSelect={pickCsv}>
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            Table from CSV / TSV
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={csvInputRef}
        type="file"
        accept=".csv,.tsv,text/csv,text/tab-separated-values"
        className="hidden"
        onChange={onCsvPicked}
      />
      {onMediaFile && (
        <input
          ref={mediaInputRef}
          type="file"
          accept={MEDIA_ACCEPT}
          className="hidden"
          onChange={onMediaPicked}
        />
      )}
      <Dialog
        open={embedDialog.open}
        onOpenChange={(open) =>
          setEmbedDialog((d) => (open ? d : { open: false, url: "", error: null }))
        }
      >
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Embed a video</DialogTitle>
            <DialogDescription>
              Paste a YouTube or Vimeo link. It plays in place; the document
              keeps the plain link.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-1">
            <Label htmlFor="embed-url" className="text-xs">Video link</Label>
            <Input
              id="embed-url"
              autoFocus
              placeholder="https://www.youtube.com/watch?v=…"
              value={embedDialog.url}
              onChange={(e) =>
                setEmbedDialog((d) => ({ ...d, url: e.target.value, error: null }))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  confirmEmbed();
                }
              }}
            />
            {embedDialog.error && (
              <p className="text-xs text-destructive">{embedDialog.error}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEmbedDialog({ open: false, url: "", error: null })}
            >
              Cancel
            </Button>
            <Button onClick={confirmEmbed}>Embed</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Divider />

      <ToolbarButton
        active={editor.isActive("link")}
        onClick={onLink}
        title="Insert URL link"
      >
        <LinkIcon className="h-3.5 w-3.5" />
      </ToolbarButton>
      {onRequestDocLink && (
        <ToolbarButton
          onClick={onRequestDocLink}
          title="Link to a document in this nest"
        >
          <FileText className="h-3.5 w-3.5" />
        </ToolbarButton>
      )}
      <Divider />

      <ToolbarButton
        onClick={() => editor.chain().focus().undo().run()}
        disabled={!editor.can().undo()}
        title="Undo (Ctrl+Z)"
      >
        <Undo className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().redo().run()}
        disabled={!editor.can().redo()}
        title="Redo (Ctrl+Shift+Z)"
      >
        <Redo className="h-3.5 w-3.5" />
      </ToolbarButton>

      <Divider />

      {/* Labelled, not icon-only: math and footnotes stay raw source in the
          editor, so a reader who can't find the rendered view assumes they
          aren't supported (CU-wdqcq00x8v). */}
      <ToolbarButton
        onClick={onTogglePreview}
        title="Preview — see how it will render"
        label="Preview"
      >
        <Eye className="h-3.5 w-3.5" />
      </ToolbarButton>

      <div className="ml-auto flex items-center gap-1">
        <div className="hidden items-center gap-2 px-1 text-xs text-muted-foreground lg:flex">
          <span>[[wiki]]</span>
          <span>@mention</span>
          <span>[ ] task</span>
        </div>
        {end}
      </div>
    </div>
  );
}

function ToolbarButton({
  active,
  onClick,
  disabled,
  title,
  label,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  title: string;
  /** Visible text beside the icon — for controls a tooltip alone won't teach. */
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      // Critical: stop the button from stealing focus before the click
      // fires. Without this the editor blurs first, so `focus()` runs
      // with no stored selection and toggleBold/toggleItalic act on the
      // wrong range — the bug that made one-word formatting look like
      // it was affecting the whole document.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        label ? "h-7 gap-1 px-2" : "h-7 w-7 p-0",
        active && "bg-muted text-foreground",
      )}
    >
      {children}
      {label && <span className="text-xs">{label}</span>}
    </Button>
  );
}

function Divider() {
  return <span className="mx-1 inline-block h-5 w-px bg-border" />;
}
