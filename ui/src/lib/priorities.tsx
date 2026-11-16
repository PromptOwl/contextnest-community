/**
 * The nest's priority levels (task_rules.priorities), most urgent first.
 * A nest that defines none gets the four built-ins. Cards, the list, the
 * board and the create dialog all read them from here, so a nest that calls
 * its levels "P0 – P3" sees that everywhere.
 */
import { createContext, useContext } from "react";

export interface PriorityLevel {
  key: string;
  label: string;
}

export const DEFAULT_PRIORITY_LEVELS: readonly PriorityLevel[] = [
  { key: "urgent", label: "Urgent" },
  { key: "high", label: "High" },
  { key: "medium", label: "Medium" },
  { key: "low", label: "Low" },
];

/** The nest's levels, else the defaults. */
export const levelsOrDefault = (configured: readonly PriorityLevel[] | undefined): readonly PriorityLevel[] =>
  configured && configured.length >= 2 ? configured : DEFAULT_PRIORITY_LEVELS;

export const PriorityLevelsContext = createContext<readonly PriorityLevel[]>(DEFAULT_PRIORITY_LEVELS);
export const usePriorityLevels = () => useContext(PriorityLevelsContext);

export const levelLabel = (levels: readonly PriorityLevel[], key: string): string =>
  levels.find((l) => l.key === key)?.label ?? key;

/** Sort weight: most urgent first, no priority (or a retired key) last. */
export function levelRank(levels: readonly PriorityLevel[], key: string | undefined): number {
  const i = levels.findIndex((l) => l.key === key);
  return i === -1 ? levels.length : i;
}

/**
 * How a level is drawn. The top level is the alert square; the rest share
 * three bars, most bars for the most urgent, so any number of levels reads at
 * a glance (Linear's glyphs, generalised): with 4 levels it is the familiar
 * alert / 3 bars / 2 bars / 1 bar.
 */
export function levelGlyph(
  levels: readonly PriorityLevel[],
  key: string | undefined,
): { kind: "none" } | { kind: "alert" } | { kind: "bars"; filled: 1 | 2 | 3 } {
  const i = levels.findIndex((l) => l.key === key);
  if (i === -1) return { kind: "none" };
  if (i === 0) return { kind: "alert" };
  const rest = levels.length - 1; // levels sharing the bars
  const filled = Math.max(1, Math.min(3, Math.round(((rest - (i - 1)) / rest) * 3))) as 1 | 2 | 3;
  return { kind: "bars", filled };
}
