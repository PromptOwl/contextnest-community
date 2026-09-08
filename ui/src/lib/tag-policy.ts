/**
 * What counts as a tag. Tags are index keys — stewardship scopes, filters,
 * prime sets — so they stay short and typeable: no punctuation soup, no
 * emoji, no path separators, and a length a chip can render.
 */

export const MAX_TAG_LENGTH = 40;

/** Hard cap on the tag FIELD, which holds several tags at once — wide enough
 *  for a handful, narrow enough that a pasted paragraph is refused outright. */
export const TAG_INPUT_MAX_LENGTH = 120;

/** Everything outside this set is dropped (`a/b/c` → `abc`, `🚀rocket` → `rocket`,
 *  `café` → `caf`). The alphabet is the ENGINE's TAG_PATTERN
 *  (`^#?[a-zA-Z][a-zA-Z0-9_:-]*$`) — accepting more here only produced a tag the
 *  server had to refuse, and the whole save failed with it. */
const DISALLOWED = /[^a-zA-Z0-9_:-]+/g;

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
  const have = new Set(existing.map(tagKey));
  const out: string[] = [];
  for (const t of candidates) {
    const key = tagKey(t);
    if (have.has(key)) continue;
    have.add(key);
    out.push(t);
  }
  return out;
}

/**
 * The value two tags are compared by. A legacy tag stored with its "#" (or in
 * mixed case) has to key the same as the bare, lowercased form the normalizer
 * produces — otherwise "#bug" and "bug" land on one document as two tags.
 */
export function tagKey(tag: string): string {
  return normalizeTagInput(tag).tag ?? tag.trim().toLowerCase();
}

export function normalizeTagInput(raw: string): TagCandidate {
  const bare = raw.trim().replace(/^#+/, "");
  if (!bare) return { tag: null, note: null };

  // Lowercased: tags are index keys, and folder paths and prime-tag matching
  // already canonicalise that way. Without it "Bug" and "bug" are two tags.
  // A tag has to OPEN with a letter (engine rule), so leading digits and
  // punctuation go with the disallowed characters.
  const cleaned = bare
    .replace(DISALLOWED, "")
    .replace(/^[^a-zA-Z]+|[_:-]+$/g, "")
    .toLowerCase();
  if (!cleaned) {
    return {
      tag: null,
      note: `"${bare}" has no usable characters — a tag starts with a letter and is built from letters a-z, digits, and _ : -`,
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

/**
 * Each whitespace/comma-separated token trimmed to the real tag limit. The
 * field holds several tags at once, so a flat 40-char cap on the input itself
 * would eat a pasted "api, v2, docs" — cap per token instead, so nothing typed
 * past the limit survives to be silently discarded on commit.
 */
export function clampTagInput(raw: string): string {
  return raw.replace(/[^\s,]+/g, (token) => {
    // Leading #s are stripped before the length check, so they don't count
    // against the tag limit.
    const hashes = /^#*/.exec(token)![0];
    return hashes + token.slice(hashes.length, hashes.length + MAX_TAG_LENGTH);
  });
}
