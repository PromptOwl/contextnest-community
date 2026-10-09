/**
 * Anchor highlighting via the CSS Custom Highlight API.
 *
 * We can't wrap react-markdown output in <mark> elements — react-markdown owns
 * that DOM and would reconcile our mutations away (or throw). Instead we build
 * Range objects over the rendered text and register them as paint-only
 * highlights (CSS.highlights). Click/hover hit-testing is done separately via
 * caret-from-point, so the highlights stay in sync with React with zero DOM
 * surgery. Falls back to a no-op when the API is unavailable (older browsers);
 * the click-to-flash path still works.
 */
import type { AnnotationAnchor } from "./api";

interface TextIndex {
  text: string;
  segs: { node: Text; start: number }[];
}

/** Flatten a container's text nodes into one string + offset map. */
export function buildTextIndex(root: HTMLElement): TextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segs: { node: Text; start: number }[] = [];
  let text = "";
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    segs.push({ node: t, start: text.length });
    text += t.data;
  }
  return { text, segs };
}

function pointAt(idx: TextIndex, offset: number): { node: Text; offset: number } | null {
  if (!idx.segs.length) return null;
  for (let i = idx.segs.length - 1; i >= 0; i--) {
    const seg = idx.segs[i];
    if (offset >= seg.start) {
      return { node: seg.node, offset: Math.min(offset - seg.start, seg.node.data.length) };
    }
  }
  return { node: idx.segs[0].node, offset: 0 };
}

/**
 * Locate a quote in flattened document text, disambiguating with the `before`
 * tail. Null when the quote is no longer in the text — the thread is about
 * words the current version doesn't have. Pure (no DOM), so it is the one
 * place both highlighting and the "text changed" label decide that.
 */
export function locateInText(
  text: string,
  anchor: AnnotationAnchor,
): { start: number; end: number } | null {
  const q = anchor.quote;
  if (!q) return null;
  const offsets: number[] = [];
  let i = text.indexOf(q);
  while (i !== -1) {
    offsets.push(i);
    i = text.indexOf(q, i + 1);
  }
  if (!offsets.length) return null;
  let chosen = offsets[0];
  if (offsets.length > 1 && anchor.before) {
    const tail = anchor.before.slice(-24);
    const better = offsets.find((c) =>
      text.slice(Math.max(0, c - tail.length), c).endsWith(tail),
    );
    if (better !== undefined) chosen = better;
  }
  return { start: chosen, end: chosen + q.length };
}

function locate(idx: TextIndex, anchor: AnnotationAnchor): { start: number; end: number } | null {
  return locateInText(idx.text, anchor);
}

/** Build a DOM Range for an anchor against the rendered container. */
export function rangeForAnchor(
  root: HTMLElement,
  idx: TextIndex,
  anchor: AnnotationAnchor,
): Range | null {
  const loc = locate(idx, anchor);
  if (!loc) return null;
  const s = pointAt(idx, loc.start);
  const e = pointAt(idx, loc.end);
  if (!s || !e) return null;
  try {
    const r = document.createRange();
    r.setStart(s.node, s.offset);
    r.setEnd(e.node, e.offset);
    return r;
  } catch {
    return null;
  }
}

export function highlightSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS;
}

/** Register a named paint-only highlight from a set of ranges. */
export function setHighlight(name: string, ranges: Range[]): void {
  if (!highlightSupported()) return;
  const HighlightCtor = (window as any).Highlight;
  if (!HighlightCtor) return;
  if (!ranges.length) {
    (CSS as any).highlights.delete(name);
    return;
  }
  (CSS as any).highlights.set(name, new HighlightCtor(...ranges));
}

export function clearHighlight(name: string): void {
  if (highlightSupported()) (CSS as any).highlights.delete(name);
}

/** Caret (node, offset) under a viewport point, across browser APIs. */
export function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as any;
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}
