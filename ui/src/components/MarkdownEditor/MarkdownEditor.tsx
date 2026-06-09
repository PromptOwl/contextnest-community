/**
 * MarkdownEditor — slim TipTap editor for community.
 *
 * Mirrors the TheOwl/data-room editor surface so syntax behaves the
 * same across products:
 *   - `[[Title]]`        — wiki link to a document in the same nest
 *   - `[ ]` / `[x]`      — toggleable task checkbox (plain-text round-trips)
 *   - `@email` / `@(Name)` — mention decoration (no autocomplete; the
 *                            text *is* the source of truth)
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
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Link from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown, type MarkdownStorage } from "tiptap-markdown";

// tiptap-markdown's storage isn't in TipTap's Storage type; cast.
// Unescape `\[\[ \]\]` — prosemirror-markdown escapes `[`/`]` as link syntax.
function getEditorMarkdown(editor: Editor): string {
  const storage = editor.storage as unknown as { markdown: MarkdownStorage };
  const md = storage.markdown.getMarkdown();
  return md
    .replace(/\\\[\\\[/g, "[[")
    .replace(/\\\]\\\]/g, "]]");
}

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

// Obsidian wiki link: `[[nodes/<slug>|Title]]` — full path + alias.
function formatWikiLink(slug: string, title: string): string {
  const safeSlug = (slug || title).trim();
  const display = (title || slug).trim();
  if (!safeSlug) return "";
  const target = safeSlug.startsWith("nodes/") ? safeSlug : `nodes/${safeSlug}`;
  return `[[${target}|${display}]] `;
}
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ForwardedRef,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Bold,
  Italic,
  Strikethrough,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  CheckSquare,
  Quote,
  Code,
  Link as LinkIcon,
  FileText,
  Undo,
  Redo,
  Eye,
  Pencil,
  Search,
  ChevronUp,
  ChevronDown,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import * as api from "../../lib/api";
import { WikiLink } from "./extensions/WikiLink";
import { TaskCheckbox } from "./extensions/TaskCheckbox";
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
import "./editor-styles.css";

export interface MarkdownEditorHandle {
  /** Insert `[[nodes/<slug>|Title]]` at cursor. */
  insertWikiLink: (slug: string, title: string) => void;
}

interface MarkdownEditorProps {
  content: string;
  onChange: (content: string) => void;
  onSave?: () => void;
  /** Nest scope used by the wiki-link existence check. Without it
   *  every `[[X]]` styles optimistically as "exists". */
  nestId?: string;
  /** Toolbar "Link to document" button calls this. Parent shows the picker. */
  onRequestDocLink?: () => void;
  /** Click on a `[[Title]]` decoration inside the editor. */
  onWikiLinkClick?: (title: string, id: string | null) => void;
  /** Click on an `@name` decoration. */
  onMentionClick?: (name: string) => void;
  placeholder?: string;
  editable?: boolean;
  className?: string;
}

export const MarkdownEditor = forwardRef<
  MarkdownEditorHandle,
  MarkdownEditorProps
>(function MarkdownEditor(
  {
    content,
    onChange,
    onSave,
    nestId,
    onRequestDocLink,
    onWikiLinkClick,
    onMentionClick,
    placeholder = "Start writing...",
    editable = true,
    className,
  }: MarkdownEditorProps,
  ref: ForwardedRef<MarkdownEditorHandle>,
) {
  // Preview mode keeps the same TipTap instance mounted (so wiki-link,
  // task-checkbox, and mention decorations render identically) but
  // flips the doc to read-only — gives the user a true preview of what
  // a reader will see without having to leave the editor.
  const [previewing, setPreviewing] = useState(false);
  const effectiveEditable = editable && !previewing;

  // `[[` autocomplete state. Opens when the user types an unclosed
  // double-bracket; the dropdown searches nest docs so picks are
  // exact-title matches by default — reduces broken-link cases.
  const [wikiPopup, setWikiPopup] = useState<{
    query: string;
    from: number;
    to: number;
    coords: { left: number; top: number };
    selectedIdx: number;
  } | null>(null);
  const [wikiResults, setWikiResults] = useState<
    Array<{ id: string; title: string }>
  >([]);
  // Refs mirror state so the editor's static `handleKeyDown` (captured
  // once at useEditor time) can see the latest values without a re-init.
  const wikiPopupRef = useRef(wikiPopup);
  const wikiResultsRef = useRef(wikiResults);
  useEffect(() => {
    wikiPopupRef.current = wikiPopup;
  }, [wikiPopup]);
  useEffect(() => {
    wikiResultsRef.current = wikiResults;
  }, [wikiResults]);

  // In-doc find/replace (Cmd+F). Match state lives in the SearchReplace
  // plugin; these drive the bar UI + counter. openSearchRef lets the static
  // editor keydown handler open the bar.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [matchInfo, setMatchInfo] = useState({ current: 0, total: 0 });
  const openSearchRef = useRef<() => void>(() => {});

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: false,
      }),
      Placeholder.configure({ placeholder }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { target: "_blank" },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      WikiLink.configure({
        onWikiLinkClick,
        checkExists: nestId
          ? async (target) => {
              // Match target as id, title, or slug.
              try {
                const { nodes } = await api.listNodes(nestId);
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
      Mention.configure({ onMentionClick }),
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
    content,
    editable,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      const md = getEditorMarkdown(editor);
      const isEmpty =
        editor.isEmpty || editor.getText().trim().length === 0;
      onChange(isEmpty ? "" : md);
    },
    editorProps: {
      attributes: {
        class:
          "prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-[300px] px-6 py-4",
      },
      handleKeyDown: (_view, event) => {
        const popup = wikiPopupRef.current;
        const results = wikiResultsRef.current;
        if (popup && results.length > 0) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setWikiPopup((s) =>
              s
                ? { ...s, selectedIdx: (s.selectedIdx + 1) % results.length }
                : s,
            );
            return true;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setWikiPopup((s) =>
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
            if (pick) insertWikiPickRef.current?.(pick);
            return true;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setWikiPopup(null);
            return true;
          }
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
    if (editor && editor.isEditable !== effectiveEditable) {
      editor.setEditable(effectiveEditable);
    }
  }, [editor, effectiveEditable]);

  // Insertion handler kept in a ref so the static `handleKeyDown`
  // closure inside useEditor can call the latest version. Replaces
  // the partial `[[query` with `[[Title]] ` and clears the popup.
  const insertWikiPickRef = useRef<
    ((doc: { id: string; title: string }) => void) | null
  >(null);
  useEffect(() => {
    insertWikiPickRef.current = (doc) => {
      if (!editor) return;
      const popup = wikiPopupRef.current;
      if (!popup) return;
      const slug = slugFromNodeId(doc.id);
      editor
        .chain()
        .focus()
        .insertContentAt(
          { from: popup.from, to: popup.to },
          formatWikiLink(slug, doc.title),
        )
        .run();
      setWikiPopup(null);
    };
  }, [editor]);

  // Detect `[[query` at the cursor on every selection / doc update.
  // Trigger pattern: `[[` followed by 0+ non-`]` non-newline chars,
  // anchored at the cursor. Closing `]]` cancels the popup so the
  // user types past the bracket without it lingering.
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      if (!effectiveEditable) {
        setWikiPopup(null);
        return;
      }
      const { state, view } = editor;
      const { selection } = state;
      if (!selection.empty) {
        setWikiPopup(null);
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
      const m = /\[\[([^\]\n]*)$/.exec(before);
      if (!m) {
        setWikiPopup(null);
        return;
      }
      const query = m[1];
      const matchStart = $from.pos - m[0].length;
      const coords = view.coordsAtPos($from.pos);
      setWikiPopup((prev) => ({
        query,
        from: matchStart,
        to: $from.pos,
        coords: { left: coords.left, top: coords.bottom },
        selectedIdx: prev && prev.query === query ? prev.selectedIdx : 0,
      }));
    };
    editor.on("selectionUpdate", update);
    editor.on("update", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("update", update);
    };
  }, [editor, effectiveEditable]);

  // Fetch matching docs whenever the query changes. Empty query
  // (just `[[`) lists everything so users can browse without typing.
  useEffect(() => {
    if (!wikiPopup || !nestId) {
      setWikiResults([]);
      return;
    }
    let cancelled = false;
    const q = wikiPopup.query.trim();
    (async () => {
      try {
        const res = q
          ? await api.searchNodes(nestId, q)
          : await api.listNodes(nestId);
        if (cancelled) return;
        const list = ((res.nodes as Array<{ id: string; title: string }>) || [])
          .slice(0, 8);
        setWikiResults(list);
      } catch {
        if (!cancelled) setWikiResults([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wikiPopup?.query, nestId]);

  // Sync external content only when not focused — avoids selection
  // loss + onUpdate loop on re-render.
  useEffect(() => {
    if (!editor) return;
    if (editor.isFocused) return;
    if (content === getEditorMarkdown(editor)) return;
    editor.commands.setContent(content, { emitUpdate: false });
  }, [content, editor]);

  useImperativeHandle(
    ref,
    (): MarkdownEditorHandle => ({
      insertWikiLink: (slug, title) => {
        if (!editor) return;
        editor.chain().focus().insertContent(formatWikiLink(slug, title)).run();
      },
    }),
    [editor],
  );

  // Wire the keydown opener once.
  useEffect(() => {
    openSearchRef.current = () => setSearchOpen(true);
  }, []);

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
    replaceCurrent(editor, replaceText);
    syncMatchInfo(setSearch(editor, searchQuery));
  };
  const doReplaceAll = () => {
    if (!editor) return;
    replaceAll(editor, replaceText);
    syncMatchInfo(setSearch(editor, searchQuery));
  };
  const closeSearch = () => setSearchOpen(false);

  const setLink = () => {
    if (!editor) return;
    const previous = editor.getAttributes("link").href ?? "";
    const url = window.prompt("URL", previous);
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  if (!editor) {
    return (
      <div className="border rounded-lg bg-background shadow-sm">
        <div className="h-12 bg-muted/40 rounded-t-lg border-b" />
        <div className="animate-pulse bg-muted/20 h-[300px] rounded-b-lg" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative border rounded-lg bg-background shadow-sm",
        className,
      )}
    >
      {editable && (
        <div className="sticky top-0 z-20 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/75 border-b">
          <Toolbar
            editor={editor}
            onLink={setLink}
            onRequestDocLink={onRequestDocLink}
            previewing={previewing}
            onTogglePreview={() => setPreviewing((p) => !p)}
          />
        </div>
      )}

      {/* Find/replace bar (Cmd+F). Sticky under the toolbar. */}
      {editable && searchOpen && (
        <div className="sticky top-0 z-30 flex flex-wrap items-center gap-1 border-b bg-background/95 px-2 py-1 backdrop-blur">
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
          className="flex items-center gap-0.5 rounded-md border bg-popover p-1 shadow-md"
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

      <EditorContent
        editor={editor}
        className={cn(
          "min-h-[60vh] max-h-[60vh] overflow-y-auto",
          previewing && "bg-muted/20",
        )}
        data-testid="markdown-editor-content"
      />

      {wikiPopup && wikiResults.length > 0 && (
        <div
          className="fixed z-50 w-72 max-h-64 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md"
          style={{
            left: wikiPopup.coords.left,
            top: wikiPopup.coords.top + 4,
          }}
          // Avoid stealing editor focus so the cursor selection that
          // `insertContentAt` targets stays intact.
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground border-b">
            Link a document
          </div>
          <ul className="py-1">
            {wikiResults.map((doc, idx) => (
              <li key={doc.id}>
                <button
                  type="button"
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-sm hover:bg-muted",
                    idx === wikiPopup.selectedIdx && "bg-muted",
                  )}
                  onClick={() => insertWikiPickRef.current?.(doc)}
                >
                  <div className="truncate font-medium">{doc.title}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {doc.id}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
});

export default MarkdownEditor;

function Toolbar({
  editor,
  onLink,
  onRequestDocLink,
  previewing,
  onTogglePreview,
}: {
  editor: Editor;
  onLink: () => void;
  onRequestDocLink?: () => void;
  previewing: boolean;
  onTogglePreview: () => void;
}) {
  // In preview mode every formatting affordance is irrelevant — collapse
  // the toolbar to just the toggle so the user has one obvious way back
  // to editing.
  if (previewing) {
    return (
      <div className="flex items-center gap-0.5 p-1 flex-wrap">
        <ToolbarButton
          active
          onClick={onTogglePreview}
          title="Back to editing"
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
    <div className="flex items-center gap-0.5 p-1 flex-wrap">
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

      <ToolbarButton
        active={editor.isActive("heading", { level: 1 })}
        onClick={() =>
          editor.chain().focus().toggleHeading({ level: 1 }).run()
        }
        title="Heading 1"
      >
        <Heading1 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("heading", { level: 2 })}
        onClick={() =>
          editor.chain().focus().toggleHeading({ level: 2 }).run()
        }
        title="Heading 2"
      >
        <Heading2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("heading", { level: 3 })}
        onClick={() =>
          editor.chain().focus().toggleHeading({ level: 3 }).run()
        }
        title="Heading 3"
      >
        <Heading3 className="h-3.5 w-3.5" />
      </ToolbarButton>

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

      <ToolbarButton
        onClick={onTogglePreview}
        title="Preview — see how it will render"
      >
        <Eye className="h-3.5 w-3.5" />
      </ToolbarButton>

      <div className="ml-auto text-xs text-muted-foreground hidden sm:flex items-center gap-2 px-1">
        <span>[[wiki]]</span>
        <span>@mention</span>
        <span>[ ] task</span>
      </div>
    </div>
  );
}

function ToolbarButton({
  active,
  onClick,
  disabled,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  title: string;
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
        "h-7 w-7 p-0",
        active && "bg-muted text-foreground",
      )}
    >
      {children}
    </Button>
  );
}

function Divider() {
  return <span className="mx-1 inline-block h-5 w-px bg-border" />;
}
