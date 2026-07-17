/**
 * Plain-text/markdown serialization for LLM-pointed export (wdqcpzrtt2).
 * One stable shape — YAML frontmatter + body — reused by the single-node
 * read (`?format=markdown`) and the nest-level `/export` concatenation so
 * agents get identical output from either endpoint.
 */

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
 * string, delimiters included, for `?format=raw&frontmatter=1`. The YAML
 * lines are returned exactly as stored; "" when the document has none.
 */
export function frontmatterBlockOf(raw: string | undefined | null): string {
  if (!raw) return "";
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? `---\n${m[1]}\n---\n\n` : "";
}
