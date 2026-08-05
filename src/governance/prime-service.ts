import { nestPrimeTags } from "../nests/service.js";
import { normalizeTag } from "./tag-index-service.js";

/**
 * A **prime** document is high-stakes content that must always carry a steward's
 * approval before AI treats it as authoritative (messaging architecture, sales
 * playbook, and the like). Prime is an escalation layered on top of the existing
 * governance posture: a prime document goes through draft → pending → approved
 * even when the actor would otherwise auto-publish.
 *
 * Resolution mirrors the steward scope order — **document → tag → nest**, first
 * match wins:
 *
 *   1. `metadata.prime` on the document, when it is an explicit boolean. `false`
 *      is meaningful: it exempts one document from an otherwise-prime tag.
 *   2. Any of the document's tags is in the nest's prime tag set.
 *   3. Nothing matched — not prime (the nest default is self-publish).
 */
export async function isPrimeDocument(
  nestId: string,
  tags: readonly unknown[] | undefined,
  metadata: unknown,
): Promise<boolean> {
  const flag = documentPrimeFlag(metadata);
  if (flag !== undefined) return flag;

  const primeTags = await nestPrimeTags(nestId);
  if (!primeTags.length) return false;
  const wanted = new Set(primeTags);
  return (tags || []).some((t) => wanted.has(normalizeTag(String(t))));
}

/**
 * The document-scope prime flag, or undefined when the document doesn't set one
 * (so tag/nest scope decides). YAML frontmatter round-trips `prime: true` as a
 * boolean, but a hand-edited vault file can land the string "true" instead —
 * accept both rather than silently dropping the flag.
 */
export function documentPrimeFlag(metadata: unknown): boolean | undefined {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.prime;
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}
