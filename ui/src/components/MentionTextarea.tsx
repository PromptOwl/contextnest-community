/**
 * MentionTextarea — a comment box with the editor's `@` picker.
 *
 * The rich editor decorates and completes `@name` through ProseMirror; a
 * comment is a plain textarea, so the same behaviour is assembled here from
 * the shared pure helpers (picker-match's trigger detection + matching,
 * comment-mentions' insert). Nothing about what an `@` means, or which names
 * resolve, is re-decided here.
 *
 * The list is anchored to the box rather than the caret: a textarea gives no
 * caret rect without mirroring its content into a hidden div, and a comment
 * box is a few lines tall — the panel sits directly under it either way.
 */
import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import {
  detectTrigger,
  matchMembers,
  type MentionMember,
} from "./MarkdownEditor/picker-match";
import { applyMentionPick, mentionSegments } from "../lib/comment-mentions";
import { applyFormat, mentionsToLinks, type CommentFormat } from "../lib/comment-format";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bold, Heading, List, ListOrdered } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "../auth/AuthContext";

export interface MentionTextareaProps
  extends Omit<
    React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    "value" | "onChange"
  > {
  value: string;
  onValueChange: (next: string) => void;
  /** The nest's people. Empty (or still loading) → the box is a plain
   *  textarea, never a popup with nothing in it. */
  members: MentionMember[];
  /** Comment boxes: a markdown toolbar, and formatted paste kept as markdown. */
  formatting?: boolean;
}

const FORMATS: Array<{ kind: CommentFormat; label: string; Icon: typeof Bold }> = [
  { kind: "bold", label: "Bold", Icon: Bold },
  { kind: "heading", label: "Heading", Icon: Heading },
  { kind: "bullet", label: "Bulleted list", Icon: List },
  { kind: "numbered", label: "Numbered list", Icon: ListOrdered },
];

export const MentionTextarea = forwardRef<
  HTMLTextAreaElement,
  MentionTextareaProps
>(function MentionTextarea(
  { value, onValueChange, members, className, onKeyDown, formatting, ...rest },
  forwardedRef,
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);

  const setRefs = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof forwardedRef === "function") forwardedRef(el);
    else if (forwardedRef) forwardedRef.current = el;
  };

  // The trigger is derived from the text before the caret, so it re-resolves
  // on every keystroke and cursor move without any state of its own.
  const trigger = useMemo(() => {
    if (!open) return null;
    const t = detectTrigger(value.slice(0, caret));
    return t?.kind === "mention" ? t : null;
  }, [open, value, caret]);

  // Never offer the author to themselves — the server skips a self-mention,
  // so picking it would only look delivered. `members` stays whole: someone
  // else's mention of the author still has to render as resolved.
  const me = useAuth().adminStatus?.me?.email?.toLowerCase();
  const results = useMemo(
    () =>
      trigger
        ? matchMembers(
            members.filter((m) => m.email.toLowerCase() !== me),
            trigger.query,
          )
        : [],
    [trigger, members, me],
  );

  useEffect(() => setHighlight(0), [trigger?.query, results.length]);

  const pick = (email: string) => {
    const el = innerRef.current;
    const next = applyMentionPick(value, caret, email);
    if (!next) return;
    onValueChange(next.value);
    setOpen(false);
    // Put the caret after the inserted address, not at the end of the box —
    // React restores the DOM value first, so this waits a frame.
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
  };

  const showList = !!trigger && results.length > 0;

  // Replace the selection with `next`, then restore the caret/selection a frame later.
  const commit = (next: { value: string; start: number; end: number }) => {
    const el = innerRef.current;
    onValueChange(next.value);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.start, next.end);
      setCaret(next.end);
    });
  };

  const format = (kind: CommentFormat) => {
    const el = innerRef.current;
    if (!el) return;
    commit(applyFormat(value, el.selectionStart ?? value.length, el.selectionEnd ?? value.length, kind));
  };

  return (
    <div className="relative">
      {formatting && !rest.readOnly && (
        <div className="mb-1 flex gap-0.5" role="toolbar" aria-label="Formatting">
          {FORMATS.map(({ kind, label, Icon }) => (
            <button
              key={kind}
              type="button"
              title={label}
              aria-label={label}
              // Mouse-down: keep the textarea's focus and selection.
              onMouseDown={(e) => {
                e.preventDefault();
                format(kind);
              }}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      )}
      <textarea
        {...rest}
        ref={setRefs}
        value={value}
        className={className}
        onChange={(e) => {
          onValueChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setOpen(true);
        }}
        onKeyUp={(e) =>
          setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)
        }
        // A paste moves the caret without a keystroke, so `@name` pasted at
        // the end would be read against a stale position until the next key or
        // click. Deferred a frame: on paste the value hasn't been applied yet.
        onPaste={(e) => {
          const el = e.currentTarget;
          const html = formatting ? e.clipboardData.getData("text/html") : "";
          if (html) {
            // Formatted paste → markdown, so headings/bold/lists survive.
            e.preventDefault();
            const plain = e.clipboardData.getData("text/plain");
            const start = el.selectionStart ?? el.value.length;
            const end = el.selectionEnd ?? start;
            void import("../lib/html-to-markdown")
              .then(({ htmlToMarkdown }) => htmlToMarkdown(html))
              .catch(() => "")
              .then((md) => {
                const text = md || plain;
                const at = start + text.length;
                commit({ value: el.value.slice(0, start) + text + el.value.slice(end), start: at, end: at });
              });
            return;
          }
          requestAnimationFrame(() => setCaret(el.selectionStart ?? 0));
        }}
        onClick={(e) =>
          setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)
        }
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (showList) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((i) => (i + 1) % results.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((i) => (i <= 0 ? results.length - 1 : i - 1));
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              // Enter picks the highlighted person instead of adding a newline
              // — the same trade the editor's picker makes. Indexed
              // defensively: the reset effect runs after the render that
              // shrank `results`, so for one commit the index can point past
              // the end.
              e.preventDefault();
              const chosen = results[highlight] ?? results[0];
              if (chosen) pick(chosen.email);
              return;
            }
            if (e.key === "Escape") {
              // Dismiss the list without closing the dialog/panel around it.
              e.stopPropagation();
              setOpen(false);
              return;
            }
          }
          onKeyDown?.(e);
        }}
      />

      {showList && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
          data-testid="mention-picker"
        >
          {results.map((m, i) => (
            <li key={m.email}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlight}
                // Mouse-down: the textarea's blur would close the list first.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(m.email);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full flex-col items-start px-3 py-1.5 text-left text-sm",
                  i === highlight ? "bg-accent text-accent-foreground" : "",
                )}
              >
                <span className="truncate font-medium">
                  {m.name || m.email.split("@")[0]}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {m.email}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

/**
 * A stored comment body with its mentions styled — resolved ones as a live
 * reference, a name that matches nobody marked as such, so a typo can't pass
 * for a delivered mention (the server won't have notified anyone).
 */
export function CommentBody({
  body,
  members,
  className,
}: {
  body: string;
  members: MentionMember[];
  className?: string;
}) {
  const segments = useMemo(
    () => mentionSegments(body, members),
    [body, members],
  );
  const markdown = useMemo(() => mentionsToLinks(segments), [segments]);
  return (
    // Markdown, like a document. `anywhere`, not `break-word`: it also lowers
    // the min-content width, so a long URL can't widen the panel. Paragraphs
    // keep single line breaks, so plain-text comments read as they were typed.
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none [overflow-wrap:anywhere] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_p]:whitespace-pre-wrap [&_li]:whitespace-pre-wrap",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const i = /^#mention-(\d+)$/.exec(href ?? "")?.[1];
            const seg = i === undefined ? undefined : segments[Number(i)];
            if (seg?.kind !== "mention") {
              return (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {children}
                </a>
              );
            }
            return (
              <span
                className={
                  seg.resolved
                    ? "rounded bg-primary/10 px-0.5 font-medium text-primary"
                    : "rounded bg-muted px-0.5 text-muted-foreground line-through decoration-dotted"
                }
                title={seg.resolved ? seg.name : `No member named "${seg.name}" in this nest`}
              >
                {seg.text}
              </span>
            );
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
