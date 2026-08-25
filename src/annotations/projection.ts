/**
 * Pure projection helpers — no DB, no IO — so they're trivially testable.
 *
 *  - `clampAnchor` normalizes a client-supplied anchor (caps the context
 *    windows at 250 chars, trims, enforces a quote).
 *  - `projectThreadsToMarkdown` renders threads to the derived markdown node
 *    the nest ingests for the next iteration.
 */

import type { AnnotationAnchor, AnnotationThread } from "./types.js";

export const MAX_CONTEXT_CHARS = 250;
/** Hard ceiling on the stored quote — a highlight, not a document. Prevents a
 *  client from stuffing megabytes into anchor_json (re-serialised on every
 *  re-projection of the derived node). */
export const MAX_QUOTE_CHARS = 1000;

/**
 * Normalize a raw anchor from the client. Returns null when there is no usable
 * quote (→ treated as a whole-artifact comment). Context windows are clamped to
 * the trailing/leading 250 chars so a thread row stays small.
 */
export function clampAnchor(
  raw: Partial<AnnotationAnchor> | null | undefined,
): AnnotationAnchor | null {
  if (!raw) return null;
  const quote = (raw.quote ?? "").trim().slice(0, MAX_QUOTE_CHARS);
  if (!quote) return null;

  const before = (raw.before ?? "").slice(-MAX_CONTEXT_CHARS);
  const after = (raw.after ?? "").slice(0, MAX_CONTEXT_CHARS);
  const line =
    typeof raw.line === "number" && Number.isFinite(raw.line) && raw.line > 0
      ? Math.floor(raw.line)
      : undefined;

  return { quote, before, after, ...(line !== undefined ? { line } : {}) };
}

/** Collapse internal whitespace so a context window renders on one md line.
 *  Also neutralise `-->` so user text can't prematurely close the surrounding
 *  HTML comment in the derived node (which would corrupt the markdown / leak
 *  raw text into the rendered output). */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").replace(/--+>/g, "-→").trim();
}

/** Render the hidden, machine-readable anchor comment for one thread. */
function renderAnchor(anchor: AnnotationAnchor | null): string {
  if (!anchor) {
    return "<!-- anchor: whole-artifact -->";
  }
  const linePart = anchor.line !== undefined ? `line ${anchor.line} · ` : "";
  const context = `…${oneLine(anchor.before)}〈${oneLine(anchor.quote)}〉${oneLine(
    anchor.after,
  )}…`;
  return `<!-- anchor: ${linePart}quote "${oneLine(anchor.quote)}" · context ${context} -->`;
}

function statusHeading(thread: AnnotationThread): string {
  if (thread.status === "resolved") {
    const who = thread.resolvedBy ? `${thread.resolvedBy}, ` : "";
    const when = thread.resolvedAt ? `${thread.resolvedAt}` : "";
    const meta = who || when ? ` (${who}${when})` : "";
    return `✅ RESOLVED${meta}`;
  }
  return "🟠 OPEN";
}

/** Stable label for a snapshot bucket. `null` snapshot = unpinned. */
function snapshotLabel(v: number | null): string {
  return v == null ? "Unpinned" : `Snapshot v${v}`;
}

/** Order threads within a snapshot: open (to-do) first, then by creation. */
function orderThreads(threads: AnnotationThread[]): AnnotationThread[] {
  return [...threads].sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/**
 * Project a node's threads to the derived annotations markdown, **grouped by
 * the snapshot they were anchored against**. Each re-gen of the artifact mints
 * a new snapshot, so grouping keeps prior-iteration feedback distinct from the
 * current one — the agent reads the latest snapshot's open threads as its to-do
 * list and can still see what earlier snapshots already resolved. Snapshots
 * sort newest-first; within each, open threads precede resolved.
 */
export function projectThreadsToMarkdown(
  artifactTitle: string,
  threads: AnnotationThread[],
): string {
  const lines: string[] = [];
  lines.push(`# ${artifactTitle} — Annotations`);
  lines.push("");
  lines.push(
    "> Auto-generated from review comments, grouped by the artifact snapshot each was anchored to. **Open** threads are unresolved feedback for the next iteration; **resolved** threads were already addressed (don't re-break them).",
  );
  lines.push("");

  if (threads.length === 0) {
    lines.push("_No annotations yet._");
    lines.push("");
    return lines.join("\n");
  }

  // Bucket by snapshot version, newest-first (null sorts last).
  const buckets = new Map<number | null, AnnotationThread[]>();
  for (const t of threads) {
    const key = t.snapshotVersion ?? null;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(t);
  }
  const keys = [...buckets.keys()].sort((a, b) => {
    if (a == null) return 1;
    if (b == null) return -1;
    return b - a;
  });

  for (const key of keys) {
    lines.push(`## ${snapshotLabel(key)}`);
    lines.push("");
    for (const thread of orderThreads(buckets.get(key)!)) {
      lines.push(`### Thread · ${statusHeading(thread)}`);
      lines.push(renderAnchor(thread.anchor));
      for (const comment of thread.comments) {
        lines.push(
          `- **${comment.author}** · ${comment.createdAt} — ${comment.body}`,
        );
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
