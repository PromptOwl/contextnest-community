/**
 * Pasted HTML (a document, Google Docs, a web page) → markdown, through the
 * same tiptap + tiptap-markdown pair the document editor uses. Loaded on
 * demand by the comment box, so tiptap only loads on a formatted paste.
 */
import { Editor } from "@tiptap/core";
import { DOMParser as PMDOMParser } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";

export function htmlToMarkdown(html: string): string {
  // html: false — what markdown can't say is dropped, not kept as raw HTML.
  const editor = new Editor({ extensions: [StarterKit, Markdown.configure({ html: false })] });
  try {
    // Parsed as HTML here: string `content` goes through tiptap-markdown, which
    // reads it as markdown and keeps every tag as text (po-1519).
    const body = new DOMParser().parseFromString(html, "text/html").body;
    // No table support here: cells would run together. "" = paste as plain text.
    if (body.querySelector("table")) return "";
    const doc = PMDOMParser.fromSchema(editor.schema).parse(body);
    return (editor.storage as any).markdown.serializer.serialize(doc).trim();
  } finally {
    editor.destroy();
  }
}
