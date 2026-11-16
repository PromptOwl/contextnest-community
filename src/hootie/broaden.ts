/**
 * The search Hootie runs on its own when the model can't (a model or gateway
 * that refuses tools): a deterministic broadening of a weak first retrieval.
 * Weak = the question compiled to no tag or title, or fewer than two
 * documents came back. Broader = the question's keywords relaxed to their
 * stems (the scorer matches word prefixes, so "testing" → "test" also finds
 * "tests" and "tester"), then the link-graph neighbours of the best hits.
 */
import type { ContextResult } from "../nodes/context-service.js";
import { tokenizePrompt } from "../nodes/prompt-compiler.js";

export function isWeakRetrieval(r: ContextResult | null): boolean {
  if (!r) return true;
  const compiled = r.trace.compiled;
  const matched = compiled ? compiled.matched_tags.length + compiled.matched_titles.length : 0;
  return matched === 0 || r.nodes.length < 2;
}

/** Strip a common English ending, keeping a stem of at least 4 letters. */
export function stem(word: string): string {
  const m = /^(.{4,}?)(?:ations?|ments?|ings?|ers?|ies|es|ed|ly|s)$/.exec(word);
  return m ? m[1] : word;
}

/** The question's keywords, stemmed — null when stemming changes nothing
 *  (the first retrieval already ran exactly that). */
export function relaxedQuery(question: string): string | null {
  const tokens = tokenizePrompt(question);
  const stems = Array.from(new Set(tokens.map(stem)));
  return stems.length && stems.join(" ") !== tokens.join(" ") ? stems.join(" ") : null;
}
