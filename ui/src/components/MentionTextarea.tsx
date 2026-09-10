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
import { cn } from "@/lib/utils";

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
}

export const MentionTextarea = forwardRef<
  HTMLTextAreaElement,
  MentionTextareaProps
>(function MentionTextarea(
  { value, onValueChange, members, className, onKeyDown, ...rest },
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

  const results = useMemo(
    () => (trigger ? matchMembers(members, trigger.query) : []),
    [trigger, members],
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

  return (
    <div className="relative">
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
  return (
    <div className={cn("whitespace-pre-wrap", className)}>
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <span
            key={i}
            className={
              seg.resolved
                ? "rounded bg-primary/10 px-0.5 font-medium text-primary"
                : "rounded bg-muted px-0.5 text-muted-foreground line-through decoration-dotted"
            }
            title={
              seg.resolved
                ? seg.name
                : `No member named "${seg.name}" in this nest`
            }
          >
            {seg.text}
          </span>
        ),
      )}
    </div>
  );
}
