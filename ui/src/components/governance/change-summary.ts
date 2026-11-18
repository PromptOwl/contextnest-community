/**
 * A plain-language summary of a change, worked out from the two versions
 * themselves — no model involved, so it is instant, free and always the same
 * for the same change. It sits above the diff on the Changes tab so a reviewer
 * knows what they are about to read: how much moved and which sections.
 */
import { unifiedDiff } from "./diff-util";

export interface ChangeSummary {
  added: number;
  removed: number;
  /** Headings of the sections that contain a change, in document order.
   *  Text before the first heading is reported as "Introduction". */
  sections: string[];
  /** Nothing differs. */
  unchanged: boolean;
  /** One line a person can read at a glance. */
  text: string;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function summarizeChange(before: string, after: string): ChangeSummary {
  const lines = unifiedDiff(before ?? "", after ?? "").split("\n");
  let added = 0;
  let removed = 0;
  // The heading in force, tracked on the NEW text where a line survives or is
  // added, and on the old text for a removed line, so a deleted section is
  // still named after the section it came from.
  let current = "Introduction";
  const sections: string[] = [];
  const note = () => {
    if (!sections.includes(current)) sections.push(current);
  };
  for (const raw of lines) {
    const tag = raw.slice(0, 2);
    const line = raw.slice(2);
    const h = HEADING.exec(line);
    if (tag === "  ") {
      if (h) current = h[2] || current;
    } else if (tag === "+ ") {
      added++;
      if (h) current = h[2] || current;
      note();
    } else if (tag === "- ") {
      removed++;
      if (h && !sections.includes(h[2])) current = h[2] || current;
      note();
    }
  }
  // An empty diff is one unchanged blank line, never an add or a remove.
  if (added === 0 && removed === 0) {
    return { added, removed, sections: [], unchanged: true, text: "No differences from the published version." };
  }
  const counts = [
    added ? `${plural(added, "line")} added` : "",
    removed ? `${plural(removed, "line")} removed` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const shown = sections.slice(0, 3).join(", ");
  const more = sections.length > 3 ? ` and ${sections.length - 3} more` : "";
  const where = sections.length
    ? ` in ${plural(sections.length, "section")}: ${shown}${more}`
    : "";
  return { added, removed, sections, unchanged: false, text: `${counts}${where}.` };
}
