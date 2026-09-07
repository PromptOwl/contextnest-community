/**
 * `@mention` parsing — the server's half of the editor's mention support.
 *
 * The editor decorates `@name` and offers a picker of the nest's people; this
 * reads the same syntax back out of stored markdown so a mention can notify
 * the person it names. Pure and DB-free so it stays testable on strings.
 */

/**
 * `@username`, `@user@email.com`, or `@(Name With Spaces)`. Mirrors the
 * editor's decoration regex (ui/src/components/MarkdownEditor/extensions/
 * Mention.ts) — if one moves, the other has to.
 */
const MENTION = /(?:^|\s)@(?:\(([^)]+)\)|([a-zA-Z0-9._@-]+))/g;

/** Body with code fences and inline code blanked — `@name` there is source. */
function stripCode(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

/** Every distinct name mentioned in a document body, in order of appearance. */
export function extractMentions(markdown: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const text = stripCode(markdown || "");
  let match;
  MENTION.lastIndex = 0;
  while ((match = MENTION.exec(text)) !== null) {
    const name = (match[1] || match[2] || "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/** Mentions present in `next` that weren't in `previous`. */
export function newMentions(previous: string, next: string): string[] {
  const before = new Set(extractMentions(previous).map((n) => n.toLowerCase()));
  return extractMentions(next).filter((n) => !before.has(n.toLowerCase()));
}

export interface MentionablePerson {
  email: string;
  name?: string | null;
}

/**
 * The person an `@name` refers to, or undefined when it names nobody. Accepts
 * the full email, its local part, or the display name — the three forms the
 * editor's picker and its unresolved styling recognize.
 *
 * A full email is unique, so it always wins. A local part or display name is
 * not: two collaborators can be `john@acme.com` and `john@other.com`, and
 * picking whichever came first would notify the wrong John with nothing to
 * show for it. An ambiguous name resolves to nobody, which the editor already
 * draws as unresolved — the writer sees the mention didn't land and can write
 * the full address (what the picker inserts anyway).
 */
export function resolveMention<T extends MentionablePerson>(
  people: T[],
  name: string,
): T | undefined {
  const n = name.trim().toLowerCase();
  if (!n) return undefined;
  const exact = people.find((p) => p.email.toLowerCase() === n);
  if (exact) return exact;
  const matches = people.filter(
    (p) =>
      p.email.toLowerCase().split("@")[0] === n ||
      (p.name || "").toLowerCase() === n,
  );
  return matches.length === 1 ? matches[0] : undefined;
}
