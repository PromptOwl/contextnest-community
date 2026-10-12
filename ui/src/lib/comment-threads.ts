/**
 * Which comment threads the document UI shows, and how.
 *
 * Resolved means "out of my way", not "gone": the rail lists open threads,
 * folds resolved ones under a "Resolved (n)" section, counts open threads
 * only, and only open threads paint a highlight in the document. A thread
 * whose quoted text is no longer in the document is "outdated" and says so,
 * instead of silently pointing nowhere.
 *
 * Pure functions over the /annotations payload, so the rules are unit-tested
 * without a DOM.
 */
import type { AnnotationThread } from "./api";
import { locateInText } from "./anchor-highlight";

/** Open and resolved threads, each newest first (replies inside a thread
 *  keep their own chronological order). */
export function splitThreads<T extends Pick<AnnotationThread, "status" | "createdAt">>(
  threads: readonly T[],
): { open: T[]; resolved: T[] } {
  const newestFirst = [...threads].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    open: newestFirst.filter((t) => t.status !== "resolved"),
    resolved: newestFirst.filter((t) => t.status === "resolved"),
  };
}

/** Threads that paint a highlight in the document: anchored AND open. A
 *  resolved thread's highlight is the thing that "just stays". */
export function paintableThreads<T extends Pick<AnnotationThread, "status" | "anchor">>(
  threads: readonly T[],
): T[] {
  return threads.filter((t) => t.status === "open" && !!t.anchor?.quote);
}

/** Ids of anchored threads whose quote can't be found in `text` (the
 *  document's rendered text). Whole-document threads are never outdated. */
export function outdatedThreadIds(
  threads: readonly Pick<AnnotationThread, "id" | "anchor">[],
  text: string,
): Set<string> {
  const out = new Set<string>();
  for (const t of threads) {
    if (!t.anchor?.quote) continue;
    if (!locateInText(text, t.anchor)) out.add(t.id);
  }
  return out;
}
