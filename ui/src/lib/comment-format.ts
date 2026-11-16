/**
 * Comment formatting. A comment body is markdown — the same format as a
 * document — typed in a plain textarea, so the toolbar inserts the syntax
 * (applyFormat) and CommentBody renders it, mentions kept (mentionsToLinks).
 */
import type { MentionSegment } from "./comment-mentions";

export type CommentFormat = "bold" | "heading" | "bullet" | "numbered";

/** `value` with `kind` applied to the selection [start, end), and the selection to restore. */
export function applyFormat(
  value: string,
  start: number,
  end: number,
  kind: CommentFormat,
): { value: string; start: number; end: number } {
  if (kind === "bold") {
    const next = `${value.slice(0, start)}**${value.slice(start, end)}**${value.slice(end)}`;
    return { value: next, start: start + 2, end: end + 2 };
  }
  // Line formats prefix every line the selection touches.
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const nl = value.indexOf("\n", end);
  const to = nl === -1 ? value.length : nl;
  const lines = value.slice(from, to).split("\n");
  const block = lines
    .map((l, i) => (kind === "heading" ? "### " : kind === "bullet" ? "- " : `${i + 1}. `) + l)
    .join("\n");
  return { value: value.slice(0, from) + block + value.slice(to), start: from, end: from + block.length };
}

/** Markdown with each mention as a `#mention-<i>` link, so the renderer can style it as segment i. */
export function mentionsToLinks(segments: MentionSegment[]): string {
  return segments
    .map((s, i) => (s.kind === "text" ? s.text : `[${s.text.replace(/[[\]\\]/g, "\\$&")}](#mention-${i})`))
    .join("");
}
