/**
 * Pack setup placeholders — pure, framework-free, unit-testable in node.
 *
 * Starter packs mark fill-me spots with {{double-brace}} tokens. Nothing
 * server-side parses them; this lib makes them DO something client-side:
 * an installed pack shows a "Finish setup" checklist until every
 * placeholder is replaced with the user's real facts.
 */

const placeholderRegex = /\{\{([^{}]{1,120}?)\}\}/g;

export interface DocSetupStatus {
  id: string;
  title: string;
  /** Unique placeholder labels still present in the doc. */
  placeholders: string[];
}

/** Unique placeholder labels in one markdown body, skipping fenced code. */
export function extractPlaceholders(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let inFence = false;
  for (const line of (content ?? "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let m: RegExpExecArray | null;
    const re = new RegExp(placeholderRegex.source, "g");
    while ((m = re.exec(line)) !== null) {
      const label = m[1].trim();
      if (label && !seen.has(label)) {
        seen.add(label);
        out.push(label);
      }
    }
  }
  return out;
}

/** Docs that still carry placeholders, in list order. */
export function nestSetupStatus(
  nodes: Array<{ id: string; title: string; content?: string }>,
): DocSetupStatus[] {
  const out: DocSetupStatus[] = [];
  for (const n of nodes) {
    const placeholders = extractPlaceholders(n.content ?? "");
    if (placeholders.length > 0) {
      out.push({ id: n.id, title: n.title, placeholders });
    }
  }
  return out;
}
