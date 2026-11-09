/**
 * A message as one line of plain text (PO-1189): My Work's mention rows show
 * an excerpt, and raw markdown or a full email address in it reads as noise.
 * Markup is dropped and the words kept; a mention shows by display name when
 * the row names that person (the viewer, the author), and otherwise by the
 * part before the `@domain`, as the editor shows it.
 */
export interface NamedPerson {
  email: string;
  name?: string | null;
}

const lastSegment = (target: string) => target.replace(/\/+$/, "").split("/").pop() || target;

export function plainExcerpt(text: string, people: NamedPerson[]): string {
  const nameOf = (email: string) => people.find((p) => p.email.toLowerCase() === email.toLowerCase())?.name || null;
  return (text || "")
    // Code: keep what is inside, drop the fences and the language tag.
    .replace(/```[^\n`]*\n?([\s\S]*?)```/g, "$1")
    .replace(/`([^`\n]*)`/g, "$1")
    // Images and links keep their text; wikilinks their alias or last segment.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^[\]\n|]+)(?:\|([^\]\n]*))?\]\]/g, (_m, target: string, alias?: string) => alias?.trim() || lastSegment(target.trim()))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // Mentions.
    .replace(/(^|\s)@\(([^)]+)\)/g, "$1@$2")
    .replace(/(^|\s)@([A-Za-z0-9._-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g, (_m, lead: string, email: string) => {
      const address = email.replace(/\.+$/, "");
      return `${lead}@${nameOf(address) || address.split("@")[0]}${email.slice(address.length)}`;
    })
    // Block markers at the start of a line.
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)/gm, "")
    // Emphasis around a word or phrase (not a lone * or the _ inside a_b_c).
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
