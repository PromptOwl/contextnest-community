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

/**
 * Normalize a raw anchor from the client. Returns null when there is no usable
 * quote (→ treated as a whole-artifact comment). Context windows are clamped to
 * the trailing/leading 250 chars so a thread row stays small.
 */
export function clampAnchor(
  raw: Partial<AnnotationAnchor> | null | undefined,
): AnnotationAnchor | null {
  if (!raw) return null;
  const quote = (raw.quote ?? "").trim();
  if (!quote) return null;

  const before = (raw.before ?? "").slice(-MAX_CONTEXT_CHARS);
  const after = (raw.after ?? "").slice(0, MAX_CONTEXT_CHARS);
  const line =
    typeof raw.line === "number" && Number.isFinite(raw.line) && raw.line > 0
      ? Math.floor(raw.line)
      : undefined;

  return { quote, before, after, ...(line !== undefined ? { line } : {}) };
}

/** Collapse internal whitespace so a context window renders on one md line. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
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

/**
 * Project a node's threads to the derived annotations markdown. Open threads
 * sort first (they are the next iteration's to-do list); resolved follow.
 */
export function projectThreadsToMarkdown(
  artifactTitle: string,
  threads: AnnotationThread[],
): string {
  const lines: string[] = [];
  lines.push(`# ${artifactTitle} — Annotations`);
  lines.push("");
  lines.push(
    "> Auto-generated from review comments. **Open** threads are unresolved feedback for the next iteration; **resolved** threads were already addressed (don't re-break them).",
  );
  lines.push("");

  if (threads.length === 0) {
    lines.push("_No annotations yet._");
    lines.push("");
    return lines.join("\n");
  }

  const ordered = [...threads].sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  });

  for (const thread of ordered) {
    lines.push(`### Thread · ${statusHeading(thread)}`);
    lines.push(renderAnchor(thread.anchor));
    for (const comment of thread.comments) {
      lines.push(`- **${comment.author}** · ${comment.createdAt} — ${comment.body}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
