/**
 * Security-relevant string utilities shared by both repos.
 * Ported from TheOwl lib/regexHelper.ts so the parser logic that depends
 * on them can ship in the same package.
 */

/**
 * Escape regex metacharacters in user-supplied input before passing to `new RegExp()`.
 * Prevents regex injection (CWE-730) and ReDoS via crafted input.
 */
export function escapeRegex(str: string): string {
  if (!str) return "";
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip HTML/XML tags iteratively until input stabilizes.
 * Defeats nested-tag bypasses like `<scr<script>ipt>` that a single-pass
 * regex strip leaves behind. Case-insensitive. Trims trailing whitespace
 * left by stripped tags.
 */
export function stripHtmlTagsSafe(text: string): string {
  let prev: string;
  let curr = text;
  do {
    prev = curr;
    curr = curr.replace(/<[^>]*>/gi, "");
  } while (curr !== prev);
  return curr.trim();
}
