/**
 * Pasted HTML (a document, Google Docs, a web page) → markdown, through the
 * same tiptap + tiptap-markdown pair the document editor uses. Loaded on
 * demand by the comment box, so tiptap only loads on a formatted paste.
 */
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";

export function htmlToMarkdown(html: string): string {
  // html: false — what markdown can't say is dropped, not kept as raw HTML.
  const editor = new Editor({ extensions: [StarterKit, Markdown.configure({ html: false })], content: html });
  try {
    return ((editor.storage as any).markdown.getMarkdown() as string).trim();
  } finally {
    editor.destroy();
  }
}
