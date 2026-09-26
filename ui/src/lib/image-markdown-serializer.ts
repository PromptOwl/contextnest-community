/**
 * Markdown serializer for the editor's block-mode image node
 * (`TiptapImage.configure({ inline: false })` in MarkdownEditor.tsx).
 *
 * tiptap-markdown's built-in image serializer is inherited from
 * prosemirror-markdown, which assumes an image is *inline* — nested inside a
 * paragraph that itself calls `state.closeBlock()`. Configured as a
 * top-level block (a sibling of the paragraphs around it, needed so
 * tiptap-markdown round-trips `![alt](url)` instead of dropping it), nothing
 * ever closes its block: the default serializer just writes the `![…](…)`
 * text and returns. The next node's `write()` still flushes whatever block
 * was last *properly* closed, so the paragraph right after an image — e.g. a
 * bare video URL, which the read view (video-embed.ts) only turns into a
 * player when it is the *sole* content of its paragraph — lands on the very
 * next line with no blank line separating it. CommonMark's lazy-continuation
 * rule then folds that into the *same* paragraph as the image on reparse,
 * so it stops being "alone" and the video degrades to a plain link.
 *
 * Calling `state.closeBlock(node)` after writing the image is the fix:
 * it's the same thing every other block-level node's serializer does.
 */

export interface ImageMarkdownState {
  write(content: string): void;
  esc(text: string): string;
  closeBlock(node: unknown): void;
}

export interface ImageMarkdownNode {
  attrs: {
    src: string;
    alt?: string | null;
    title?: string | null;
  };
}

export function serializeImageNode(
  state: ImageMarkdownState,
  node: ImageMarkdownNode,
): void {
  const alt = state.esc(node.attrs.alt || "");
  const src = node.attrs.src.replace(/[()]/g, "\\$&");
  const title = node.attrs.title
    ? ` "${node.attrs.title.replace(/"/g, '\\"')}"`
    : "";
  state.write(`![${alt}](${src}${title})`);
  state.closeBlock(node);
}
