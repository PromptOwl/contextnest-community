/**
 * What counts as a tag. Tags are index keys — stewardship scopes, filters,
 * prime sets — so they stay short and typeable: no punctuation soup, no
 * emoji, no path separators, and a length a chip can render.
 */

export const MAX_TAG_LENGTH = 40;

/** Hard cap on the tag FIELD, which holds several tags at once — wide enough
 *  for a handful, narrow enough that a pasted paragraph is refused outright. */
export const TAG_INPUT_MAX_LENGTH = 120;

/** Everything outside this set is dropped (`a/b/c` → `abc`, `🚀rocket` → `rocket`). */
const DISALLOWED = /[^\p{L}\p{N}._-]+/gu;

export interface TagCandidate {
  /** The tag to store, or null when nothing usable survived. */
  tag: string | null;
  /** Set when the input was changed or refused, for inline feedback. */
  note: string | null;
}

/**
 * Of `candidates`, the ones that would actually be added. Tags are
 * case-insensitive, so a candidate matching an existing tag in any casing is a
 * no-op — as is a repeat within the same batch. Both the "will add" preview and
 * the commit read this, so what is promised is what lands.
 */
export function newTags(existing: string[], candidates: string[]): string[] {
  const have = new Set(existing.map((t) => t.toLowerCase()));
  const out: string[] = [];
  for (const t of candidates) {
    const key = t.toLowerCase();
    if (have.has(key)) continue;
    have.add(key);
    out.push(t);
  }
  return out;
}

export function normalizeTagInput(raw: string): TagCandidate {
  const bare = raw.trim().replace(/^#+/, "");
  if (!bare) return { tag: null, note: null };

  // Lowercased: tags are index keys, and folder paths and prime-tag matching
  // already canonicalise that way. Without it "Bug" and "bug" are two tags.
  const cleaned = bare
    .replace(DISALLOWED, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .toLowerCase();
  if (!cleaned) {
    return {
      tag: null,
      note: `"${bare}" has no letters or digits — tags are built from letters, digits, and . _ -`,
    };
  }
  if (cleaned.length > MAX_TAG_LENGTH) {
    return {
      tag: cleaned.slice(0, MAX_TAG_LENGTH),
      note: `Tags are capped at ${MAX_TAG_LENGTH} characters — "${bare}" was shortened.`,
    };
  }
  // Compared lowercased so a pure case change stays silent — only real
  // rewrites (dropped characters) are worth a note.
  if (cleaned !== bare.toLowerCase()) {
    return { tag: cleaned, note: `"${bare}" was simplified to "${cleaned}".` };
  }
  return { tag: cleaned, note: null };
}
