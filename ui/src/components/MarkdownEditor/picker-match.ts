/**
 * Trigger detection + matching for the editor's inline picker.
 *
 * Two triggers share one popup: `[[query` browses documents, `@query`
 * browses the nest's people. Pure and DOM-free so both can be unit tested
 * against plain strings.
 */

export type PickerKind = "wiki" | "mention";

export interface PickerTrigger {
  kind: PickerKind;
  /** Text typed after the trigger chars, up to the caret. */
  query: string;
  /** Chars before the caret the trigger occupies — the replace range. */
  length: number;
}

// `[[` then anything but `]` / newline. A closing `]]` ends the trigger.
const WIKI_TRIGGER = /\[\[([^\]\n]*)$/;
// `@` at a word boundary. The char class allows emails (`@a@b.com`), which
// is what a pick inserts, so re-editing one keeps the popup open.
const MENTION_TRIGGER = /(?:^|\s)@([\w.@+-]*)$/;

/** Trigger ending at the caret, given the text before it. */
export function detectTrigger(before: string): PickerTrigger | null {
  const wiki = WIKI_TRIGGER.exec(before);
  if (wiki) return { kind: "wiki", query: wiki[1], length: wiki[0].length };

  const mention = MENTION_TRIGGER.exec(before);
  if (mention) {
    // The leading space is context, not part of what a pick replaces.
    const lead = /^\s/.test(mention[0]) ? 1 : 0;
    return {
      kind: "mention",
      query: mention[1],
      length: mention[0].length - lead,
    };
  }
  return null;
}

export interface MentionMember {
  email: string;
  /** Display name, when the roster carries one. */
  name?: string | null;
}

function candidates(member: MentionMember): string[] {
  const email = member.email.toLowerCase();
  return [email, email.split("@")[0], (member.name || "").toLowerCase()].filter(
    Boolean,
  );
}

/** Members matching the typed query. Empty query lists everyone. */
export function matchMembers<T extends MentionMember>(
  members: T[],
  query: string,
  limit = 8,
): T[] {
  const q = query.trim().toLowerCase();
  return members
    .filter((m) => !q || candidates(m).some((c) => c.includes(q)))
    .slice(0, limit);
}

/**
 * Does an `@name` written in the document resolve to ONE real member? Accepts
 * the full email, its local part, or the display name (`@(Name With Spaces)`).
 * Used to style unresolved mentions differently instead of passing off any
 * typed text as a valid mention.
 *
 * A bare local part shared by two people (`john@acme.com`, `john@other.com`)
 * names neither, and the server won't notify on it — so it styles as
 * unresolved here too, rather than promising a delivery that never happens.
 */
export function isMemberName(
  members: MentionMember[],
  name: string,
): boolean {
  const n = name.trim().toLowerCase();
  if (!n) return false;
  if (members.some((m) => m.email.toLowerCase() === n)) return true;
  return (
    members.filter((m) => candidates(m).includes(n)).length === 1
  );
}
