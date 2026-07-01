/**
 * Prompt → selector compiler.
 *
 * Takes a natural-language prompt and returns a union selector of tags + wiki
 * links that the engine's GraphQueryEngine can run. This is deliberately
 * simple: no LLM, no embeddings. Tokenize the prompt, drop stopwords, match
 * against the nest's known tags (from node_tag_index) and known titles (from
 * the engine-cache's document list). Build `#tag1 | #tag2 | [[Title3]]`.
 *
 * If nothing matches, we fall back to null — callers should switch to a
 * broader strategy (e.g. full-text search) rather than running an empty
 * selector that returns everything.
 */

import { getDb } from "../db/client.js";
import { normalizeTag } from "../governance/tag-index-service.js";

const STOPWORDS = new Set<string>([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "so", "as",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "done", "can", "could", "should", "would", "may",
  "might", "must", "shall", "will", "about", "above", "after", "again",
  "against", "all", "am", "any", "because", "before", "below", "between",
  "both", "by", "during", "each", "few", "for", "from", "further", "here",
  "how", "i", "me", "my", "myself", "we", "us", "our", "ours", "you",
  "your", "yours", "he", "him", "his", "she", "her", "hers", "it", "its",
  "they", "them", "their", "theirs", "this", "that", "these", "those",
  "to", "too", "very", "of", "on", "off", "over", "under", "up", "down",
  "in", "out", "into", "onto", "some", "such", "same", "other", "than",
  "what", "when", "where", "which", "who", "whom", "why", "with", "without",
  "just", "also", "only", "more", "most", "use", "using", "used", "get",
  "got", "make", "made", "need", "want", "like", "help", "show", "tell",
  "give", "take", "find", "look", "know", "think", "say", "mean", "tell",
  "not", "no", "yes", "okay", "ok", "please", "thanks", "thank",
]);

/** Normalize + tokenize the prompt into distinct lowercase keywords. */
export function tokenizePrompt(prompt: string): string[] {
  const words = prompt
    .toLowerCase()
    // split on anything that isn't a letter/digit/hyphen/underscore
    .split(/[^a-z0-9_-]+/)
    .filter(Boolean)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  // Dedupe, keep order
  return Array.from(new Set(words));
}

export interface CompiledSelector {
  /** Final selector string, or null if no matches */
  selector: string | null;
  /** Tags that matched the prompt's tokens */
  matchedTags: string[];
  /** Titles that matched (used as [[Title]]) */
  matchedTitles: string[];
  /** Tokens from the prompt that found no match */
  unmatched: string[];
}

/**
 * Compile a prompt into a selector by matching its tokens against the nest's
 * known tags (from node_tag_index) and known titles (from storage). Call-site
 * supplies the title list so the compiler stays sync-only and testable.
 */
export async function compilePrompt(
  prompt: string,
  nestId: string,
  titles: string[],
): Promise<CompiledSelector> {
  const tokens = tokenizePrompt(prompt);
  if (tokens.length === 0) {
    return { selector: null, matchedTags: [], matchedTitles: [], unmatched: [] };
  }

  // ── Tag match ──
  // Pull every active tag from node_tag_index, compare against each token.
  const db = getDb();
  const tagRows = await db
    .all(
      "SELECT DISTINCT tag_name FROM node_tag_index WHERE nest_id = ?",
      [nestId],
    ) as Array<{ tag_name: string }>;
  const knownTags = new Set(tagRows.map((r) => r.tag_name));

  const matchedTags = new Set<string>();
  for (const token of tokens) {
    const norm = normalizeTag(token);
    if (knownTags.has(norm)) matchedTags.add(norm);
  }

  // ── Title match ──
  // Look for tokens that appear in a title. We match a title if ANY of its
  // significant words matches a prompt token. This catches "authentication"
  // in a doc titled "API Authentication Guide".
  const matchedTitles = new Set<string>();
  for (const title of titles) {
    const titleTokens = tokenizePrompt(title);
    if (titleTokens.length === 0) continue;
    const hit = titleTokens.some((t) => tokens.includes(t));
    if (hit) matchedTitles.add(title);
  }

  const unmatched = tokens.filter(
    (t) => !matchedTags.has(normalizeTag(t)) &&
      !Array.from(matchedTitles).some((title) =>
        tokenizePrompt(title).includes(t),
      ),
  );

  // ── Build selector ──
  // Engine's selector grammar supports #tag, URIs, and filters — NOT
  // [[wiki links]]. We emit tags here; title matches are returned
  // separately for the caller to resolve via direct node lookup, then
  // merge into the final result set.
  const tagParts = Array.from(matchedTags).map((t) => `#${t}`);

  return {
    selector: tagParts.length > 0 ? tagParts.join(" | ") : null,
    matchedTags: Array.from(matchedTags),
    matchedTitles: Array.from(matchedTitles),
    unmatched,
  };
}
