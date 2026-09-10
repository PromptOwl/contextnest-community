/**
 * `@mention` support for plain-textarea surfaces — the comments composer.
 *
 * The rich editor gets mentions from its ProseMirror plugin (MarkdownEditor/
 * extensions/Mention.ts) and its trigger/matching helpers (picker-match.ts).
 * A comment box is a `<textarea>`, so it needs the same two behaviours over a
 * plain string: turn a picked person into text at the caret, and split a
 * stored body into runs so a mention can be styled when it is rendered.
 *
 * Trigger detection and member matching are NOT re-implemented here — they
 * come from picker-match.ts, so the box and the editor agree on what an `@`
 * means and on which names resolve. Pure and DOM-free, like the rest of
 * ui/src/lib.
 */
import { detectTrigger, isMemberName, type MentionMember } from "../components/MarkdownEditor/picker-match";

/**
 * The textarea value after picking `email` for the `@` trigger at `caret`.
 * `null` when there is no mention trigger there — the caller leaves the value
 * untouched rather than inserting at random.
 *
 * The inserted text is the full address plus one space: unique (so it resolves
 * for certain) and finished (so the next word doesn't extend the mention),
 * which is exactly what the editor's picker inserts.
 */
export function applyMentionPick(
  value: string,
  caret: number,
  email: string,
): { value: string; caret: number } | null {
  const before = value.slice(0, caret);
  const trigger = detectTrigger(before);
  if (!trigger || trigger.kind !== "mention") return null;

  const start = caret - trigger.length;
  const insert = `@${email} `;
  const after = value.slice(caret);
  // The insert already ends in a space; don't add a second one when the caret
  // sits right before existing text.
  const tail = after.startsWith(" ") ? after.slice(1) : after;
  return { value: value.slice(0, start) + insert + tail, caret: start + insert.length };
}

export type MentionSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; text: string; name: string; resolved: boolean };

// One pass, two alternatives: a code span — fenced block or inline, emitted as
// plain text because an `@name` there is source — or a mention in one of its
// three written forms. Both halves mirror src/shared/mentions.ts, whose
// `stripCode` blanks fenced blocks first and then inline spans, so what the
// server declines to notify for is exactly what this declines to decorate; if
// one moves, so does the other.
const SEGMENT =
  /((?:```[\s\S]*?```)|(?:`[^`\n]*`))|(?:(^|\s)@(?:\(([^)]+)\)|([a-zA-Z0-9._@-]+)))/g;

/**
 * A comment body split into text and mention runs, in order, concatenating
 * back to the original string. `resolved` says whether the name matches
 * exactly one member — an unresolved mention is styled as broken rather than
 * passed off as a live reference, because the server won't notify on it.
 *
 * With no roster to check against — still loading, or a public reader who
 * isn't allowed one — every mention reads as resolved. Same contract as the
 * editor's decoration: an optimistic mention is a plain name, whereas marking
 * them all broken would tell a reader that a whole thread of real mentions
 * went nowhere.
 */
export function mentionSegments(
  body: string,
  members: MentionMember[],
): MentionSegment[] {
  const segments: MentionSegment[] = [];
  const text = body || "";
  const rosterKnown = members.length > 0;
  let last = 0;
  const pushText = (s: string) => {
    if (!s) return;
    const prev = segments[segments.length - 1];
    // Merge adjacent text runs so a body with no mentions is one segment.
    if (prev?.kind === "text") prev.text += s;
    else segments.push({ kind: "text", text: s });
  };

  SEGMENT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SEGMENT.exec(text)) !== null) {
    const [full, code, lead, bracketed, bare] = match;
    if (code) {
      // Code span: nothing to decorate, but it must not be dropped either.
      pushText(text.slice(last, match.index + full.length));
      last = match.index + full.length;
      continue;
    }
    const name = (bracketed || bare || "").trim();
    const start = match.index + (lead ? lead.length : 0);
    pushText(text.slice(last, start));
    segments.push({
      kind: "mention",
      text: text.slice(start, match.index + full.length),
      name,
      resolved: !rosterKnown || isMemberName(members, name),
    });
    last = match.index + full.length;
  }
  pushText(text.slice(last));
  return segments;
}
