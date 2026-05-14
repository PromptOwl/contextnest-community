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
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Link from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import * as api from "../../lib/api";
import { WikiLink } from "./extensions/WikiLink";
import { TaskCheckbox } from "./extensions/TaskCheckbox";
import { Mention } from "./extensions/Mention";
import "./editor-styles.css";

export interface MarkdownEditorHandle {
  /** Insert `[[Title]]` at the cursor — called by the parent after a
   *  pick in `DocumentPickerModal`. */
  insertWikiLink: (title: string) => void;
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
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: false,
      }),
      Placeholder.configure({ placeholder }),
      Link.configure({ openOnClick: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      WikiLink.configure({
        onWikiLinkClick,
        checkExists: nestId
          ? async (title) => {
              try {
                const { nodes } = await api.searchNodes(nestId, title);
                const exact = (nodes as Array<{ id: string; title: string }>)
                  .find((n) => n.title.toLowerCase() === title.toLowerCase());
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
    ],
    content,
    editable,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      const isEmpty =
        editor.isEmpty || editor.getText().trim().length === 0;
      onChange(isEmpty ? "" : html);
    },
    editorProps: {
      attributes: {
        class:
          "prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-[300px] px-6 py-4",
      },
      handleKeyDown: (_view, event) => {
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

  // Sync external `content` into the editor only when it differs *and*
  // the user isn't actively editing. Without the focus guard, every
  // `onChange → setState → re-render` round trip would re-set the doc
  // (because `getHTML()` normalises slightly differently from React's
  // stored value), nuking the selection and making toolbar toggles act
  // on whatever the cursor landed on rather than the original range.
  // The `false` second arg further blocks the resulting `onUpdate`
  // event from firing back into onChange and looping.
  useEffect(() => {
    if (!editor) return;
    if (editor.isFocused) return;
    if (content === editor.getHTML()) return;
    editor.commands.setContent(content, false);
  }, [content, editor]);

  useImperativeHandle(
    ref,
    (): MarkdownEditorHandle => ({
      insertWikiLink: (title) => {
        if (!editor) return;
        editor.chain().focus().insertContent(`[[${title}]] `).run();
      },
    }),
    [editor],
  );

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

      <EditorContent
        editor={editor}
        className={cn(
          "min-h-[60vh] max-h-[60vh] overflow-y-auto",
          previewing && "bg-muted/20",
        )}
        data-testid="markdown-editor-content"
      />
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
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
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
