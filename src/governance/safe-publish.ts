import {
  publishDocument,
  serializeDocument,
  type NestStorage,
  type PublishOptions,
  type PublishResult,
} from "@promptowl/contextnest-engine";

/**
 * Wrapper around engine's publishDocument that pre-cleans `undefined`
 * frontmatter values before serialization.
 *
 * Engine's parser sets `frontmatter.tags = undefined` when YAML contains
 * `tags: []` (normalizeTags returns undefined for empty arrays). js-yaml v3
 * — used by gray-matter inside serializeDocument — throws
 * "unacceptable kind of an object to dump [object Undefined]" when an
 * object value is undefined.
 *
 * We read the doc, strip undefined keys (deep — also cleans metadata),
 * re-serialize and write back, then call publishDocument which re-reads
 * from disk and runs cleanly.
 */
export async function safePublishDocument(
  storage: NestStorage,
  docId: string,
  options: PublishOptions,
): Promise<PublishResult> {
  const node = await storage.readDocument(docId);
  const cleanedFrontmatter = stripUndefinedDeep(node.frontmatter) as typeof node.frontmatter;
  const cleanedNode = { ...node, frontmatter: cleanedFrontmatter };
  await storage.writeDocument(docId, serializeDocument(cleanedNode));
  return publishDocument(storage, docId, options);
}

function stripUndefinedDeep(value: unknown): unknown {
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
