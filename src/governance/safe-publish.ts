import { serializeDocument } from "@promptowl/contextnest-engine";

/**
 * serializeDocument with the same undefined-frontmatter pre-clean. Any write
 * of a node that came from readDocument must go through this — a doc with
 * `tags: []` on disk parses back with `tags: undefined` and blows up the
 * YAML dumper.
 */
export function serializeNodeSafe(
  node: Parameters<typeof serializeDocument>[0],
): string {
  return serializeDocument({
    ...node,
    frontmatter: stripUndefinedDeep(node.frontmatter) as typeof node.frontmatter,
  });
}

export function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((v) => v !== undefined)
      .map((v) => stripUndefinedDeep(v));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefinedDeep(v);
    }
    return out;
  }
  return value;
}
