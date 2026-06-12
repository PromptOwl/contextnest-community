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
