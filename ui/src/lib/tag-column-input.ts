/**
 * What the tag board's add-column box lists for the typed text, and which row
 * Enter takes (CU-wdqcq05pad). Pure, so the node test env covers it
 * (test/board-pattern-columns.test.ts); TagColumnInput renders it.
 *
 * Enter adds what you typed unless you picked something: an exact tag match
 * is that tag; anything else is offered first as a new tag, with the fuzzy
 * matches below it to arrow down to. Pre-selecting the first fuzzy match
 * instead made typing "status" + Enter add "Status-Done".
 */
import { globMatch, isColumnPattern } from "./board-dimensions";

export interface ColumnInputRow {
  kind: "tag" | "new" | "pattern";
  value: string;
  label: string;
  /** Card count for a tag; the current matches for a pattern. */
  hint?: string;
}

const MAX_SHOWN = 50;

export function columnInputRows(
  text: string,
  suggestions: Array<{ value: string; count: number }>,
): { rows: ColumnInputRow[]; active: number } {
  const typed = text.trim().replace(/^#/, "");
  if (isColumnPattern(typed)) {
    const matches = suggestions.filter((s) => globMatch(typed, s.value));
    return {
      rows: [
        {
          kind: "pattern",
          value: typed,
          label: `Add a column for every tag matching “${typed}”`,
          hint: matches.length
            ? `${matches.length} now: ${matches
                .slice(0, 4)
                .map((m) => m.value)
                .join(", ")}${matches.length > 4 ? "…" : ""} — new matches appear by themselves`
            : "No tags match yet — matching tags will appear as columns when they're used",
        },
      ],
      active: 0,
    };
  }
  const q = typed.toLowerCase();
  const matches = (q ? suggestions.filter((s) => s.value.toLowerCase().includes(q)) : suggestions)
    .slice(0, MAX_SHOWN)
    .map((m): ColumnInputRow => ({ kind: "tag", value: m.value, label: m.value, hint: `${m.count}` }));
  if (!typed) return { rows: matches, active: -1 };
  const exact = matches.findIndex((m) => m.value.toLowerCase() === q);
  if (exact >= 0) return { rows: matches, active: exact };
  return { rows: [{ kind: "new", value: typed, label: `New tag “${typed}”` }, ...matches], active: 0 };
}
