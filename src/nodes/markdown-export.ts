/**
 * Plain-text/markdown serialization for LLM-pointed export (wdqcpzrtt2).
 * One stable shape — YAML frontmatter + body — reused by the single-node
 * read (`?format=markdown`) and the nest-level `/export` concatenation so
 * agents get identical output from either endpoint.
 */
import { parseDocument } from "@promptowl/contextnest-engine";

export interface MarkdownExportFields {
  id: string;
  title?: string;
  tags?: string[];
  status?: string;
  body?: string;
}

/** Serialize one node as frontmatter + body. */
export function nodeToMarkdown(node: MarkdownExportFields): string {
  const tags = node.tags ?? [];
  return (
    [
      "---",
      `title: ${JSON.stringify(node.title ?? "")}`,
      `tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`,
      `status: ${JSON.stringify(node.status ?? "")}`,
      `id: ${JSON.stringify(node.id)}`,
      "---",
      "",
    ].join("\n") + (node.body ?? "")
  );
}

/** Concatenate multiple nodes with the agent-facing `---` separator. */
export function nodesToMarkdown(nodes: MarkdownExportFields[]): string {
  return nodes.map(nodeToMarkdown).join("\n\n---\n\n");
}

/** True when the caller requested markdown via `?format=markdown`. */
export function isMarkdownFormat(c: {
  req: { query: (k: string) => string | undefined };
}): boolean {
  return c.req.query("format") === "markdown";
}

/**
 * True when the caller requested the raw node BODY (`?format=raw`, or an
 * `Accept: text/markdown` header). The query param always wins when both are
 * present — `?format=markdown` + `Accept: text/markdown` still serves the
 * frontmatter+body markdown export, and any other explicit `format` value
 * disables the Accept-header trigger.
 */
export function isRawFormat(c: {
  req: {
    query: (k: string) => string | undefined;
    header: (k: string) => string | undefined;
  };
}): boolean {
  const format = c.req.query("format");
  if (format !== undefined) return format === "raw";
  const accept = c.req.header("Accept") ?? "";
  // DELIBERATE response-shape change (CU-wdqcpzwf2k): before this feature a
  // client sending `Accept: text/markdown` still received the JSON envelope;
  // now that header opts into the raw text body. Any client that needs the
  // old behavior can pin it with an explicit `format` query param — the
  // param always wins over the header.
  // Exact media-type match only — `text/*` or `*/*` (browser defaults) must
  // NOT flip the response away from JSON.
  return accept
    .split(",")
    .some((part) => part.trim().split(";")[0].trim().toLowerCase() === "text/markdown");
}

/**
 * Content-Type for the `?format=raw` direct fetch, per node type:
 *   - `artifact`      → `text/html`     (artifact bodies are HTML)
 *   - `tool`, `table` → `text/plain`    (JSON/CSV-ish payloads, not markdown)
 *   - everything else (`document`, `agent`, `skill`, …) → `text/markdown`
 */
const RAW_CONTENT_TYPES: Record<string, string> = {
  artifact: "text/html; charset=utf-8",
  tool: "text/plain; charset=utf-8",
  table: "text/plain; charset=utf-8",
};
export function rawContentType(nodeType: string | undefined): string {
  return RAW_CONTENT_TYPES[nodeType || "document"] ?? "text/markdown; charset=utf-8";
}

/**
 * Extract the leading YAML frontmatter block from a stored raw document
 * string, delimiters included, for `?format=raw&frontmatter=1`. Returned
 * exactly as stored; "" when the document has none.
 *
 * Delimiter parsing is delegated to the engine's `parseDocument` (gray-matter
 * — the same library `serializeDocument`/`matter.stringify` writes with on
 * the storage write path), so the split can't disagree with how the engine
 * itself reads the file: the block is the stored prefix that precedes the
 * parsed body. That keeps a `---` horizontal rule at the top of the BODY out
 * of the frontmatter block, and makes block + body reconstruct the stored
 * bytes exactly.
 */
export function frontmatterBlockOf(raw: string | undefined | null): string {
  if (!raw || !raw.startsWith("---")) return "";
  try {
    const body = parseDocument("frontmatter-split.md", raw, "frontmatter-split").body ?? "";
    if (raw.endsWith(body)) return raw.slice(0, raw.length - body.length);
  } catch {
    /* unparseable frontmatter — fall through to the conservative regex */
  }
  // Fallback for raw strings gray-matter can't parse: first `---` fence pair.
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? `---\n${m[1]}\n---\n\n` : "";
}
