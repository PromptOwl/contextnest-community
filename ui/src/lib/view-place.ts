/**
 * Keep the reader's place across view switches, and find comment anchors in
 * text that isn't the text they were made on.
 *
 * The document and artifact pages show one body several ways — rich editor,
 * rendered/comment view, raw markdown; artifact preview vs. its extracted
 * text — and switching used to remount the surface and throw you to the top.
 * A "place" is the text at the top of the viewport (a short snippet plus how
 * far through the body it sat). On a switch the new surface finds the same
 * snippet and scrolls it to the same height on screen.
 *
 * The surfaces disagree on formatting — markdown has `**`, the DOM has no
 * space between blocks, extracted text has newlines — so matching runs on a
 * folded form with whitespace and markdown punctuation removed, with a map
 * back to real offsets. The same fold maps comment quotes (made on rendered
 * text) onto the raw markdown source for highlighting there.
 *
 * Pure helpers first (unit-tested); DOM helpers and the hook after.
 */
import { useEffect, useLayoutEffect, useRef } from "react";

const DROP = /[\s*_`~#>[\]|\\]/;

/** `s` without whitespace and markdown punctuation; map[i] = index in `s`. */
export function foldText(s: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (DROP.test(s[i])) continue;
    folded += s[i];
    map.push(i);
  }
  return { folded, map };
}

/** The words at `offset`, whitespace-normalized — what a place remembers. */
export function placeSnippet(text: string, offset: number, len = 48): string {
  if (offset >= text.length) return "";
  return text
    .slice(offset, offset + len * 2)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, len);
}

export interface Place {
  snippet: string;
  /** Position through the body, 0..1 — picks among repeats, and the fallback. */
  frac: number;
  /** Viewport y the snippet sat at; null when unknown (came from the iframe). */
  y: number | null;
}

function nearest(hay: string, needle: string, want: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const d = Math.abs(i - want);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/**
 * Offset in `text` of the place's snippet: the occurrence nearest `frac`,
 * retrying with shorter prefixes if the tail changed. Null if absent.
 */
export function findPlace(text: string, place: Pick<Place, "snippet" | "frac">): number | null {
  const f = foldText(text);
  const s = foldText(place.snippet).folded;
  if (!s || !f.folded) return null;
  const want = place.frac * f.folded.length;
  for (let len = Math.min(s.length, 40); len >= Math.min(8, s.length); len = Math.floor(len / 2)) {
    const at = nearest(f.folded, s.slice(0, len), want);
    if (at >= 0) return f.map[at];
    if (len <= 1) break;
  }
  return null;
}

export interface SourceRange {
  id: string;
  start: number;
  end: number;
}

/**
 * Where each thread's quote sits in the raw markdown source. Quotes are made
 * on rendered text, so the match is folded (a quote across `**bold**` still
 * lands); `before` picks between repeats, as anchor-highlight does. Threads
 * whose quote isn't in the source are left out rather than painted wrong.
 */
export function sourceRangesForAnchors(
  source: string,
  threads: readonly { id: string; anchor: { quote: string; before?: string } | null }[],
): SourceRange[] {
  const f = foldText(source);
  const out: SourceRange[] = [];
  for (const t of threads) {
    if (!t.anchor?.quote) continue;
    const q = foldText(t.anchor.quote).folded;
    if (!q) continue;
    const tail = foldText(t.anchor.before ?? "").folded.slice(-24);
    let at = -1;
    let first = -1;
    for (let i = f.folded.indexOf(q); i !== -1; i = f.folded.indexOf(q, i + 1)) {
      if (first < 0) first = i;
      if (tail && f.folded.slice(Math.max(0, i - tail.length), i) === tail) {
        at = i;
        break;
      }
    }
    if (at < 0) at = first;
    if (at < 0) continue;
    out.push({ id: t.id, start: f.map[at], end: f.map[at + q.length - 1] + 1 });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ── DOM ──────────────────────────────────────────────────────────────────

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA"]);

interface Seg {
  node: Text;
  start: number;
}

function textIndex(root: HTMLElement): { text: string; segs: Seg[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement && SKIP_TAGS.has(n.parentElement.tagName)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const segs: Seg[] = [];
  let text = "";
  let n: Node | null;
  while ((n = walker.nextNode())) {
    segs.push({ node: n as Text, start: text.length });
    text += (n as Text).data;
  }
  return { text, segs };
}

function charRect(node: Text, off: number): DOMRect {
  const r = document.createRange();
  r.setStart(node, off);
  r.setEnd(node, Math.min(off + 1, node.data.length));
  return r.getBoundingClientRect();
}

const hasBox = (b: DOMRect) => b.width > 0 || b.height > 0;

/** First non-blank char at or after `off` in `node` that has a box. */
function firstBoxed(node: Text, off: number): { off: number; rect: DOMRect } | null {
  for (let j = off; j < node.data.length && j < off + 400; j++) {
    if (/\s/.test(node.data[j])) continue;
    const b = charRect(node, j);
    if (hasBox(b)) return { off: j, rect: b };
  }
  return null;
}

function pinned(el: Element | null): boolean {
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    const pos = getComputedStyle(e).position;
    if (pos === "sticky" || pos === "fixed") return true;
  }
  return false;
}

/**
 * The first y at which `root` can be seen: below its own top edge, and below
 * whatever is pinned over the page there — the app header, the page's top
 * bar, the editor's sticky toolbar — whatever their heights. Probed with
 * elementFromPoint down the root's column.
 */
export function visibleTop(root: HTMLElement): number {
  return Math.max(pinnedInset(root), root.getBoundingClientRect().top);
}

/** Height of what's pinned over the top of the viewport in root's column. */
function pinnedInset(root: HTMLElement): number {
  const b = root.getBoundingClientRect();
  const x = b.left + Math.min(b.width / 2, 200);
  let y = 0;
  while (y < window.innerHeight / 2 && pinned(document.elementFromPoint(x, y))) y += 8;
  return y;
}

/** The place at the top of the visible part of `root`, or null if none of
 *  its text is on screen or below it. */
export function capturePlace(root: HTMLElement): Place | null {
  const idx = textIndex(root);
  if (!idx.text.trim()) return null;
  const top = visibleTop(root);
  const r = document.createRange();
  for (const seg of idx.segs) {
    if (!seg.node.data.trim()) continue;
    r.selectNodeContents(seg.node);
    const b = r.getBoundingClientRect();
    if (!hasBox(b) || b.bottom <= top) continue;
    // Chars in one text node run top to bottom: binary-search the first one
    // whose box ends below the visible top edge.
    let lo = 0;
    let hi = seg.node.data.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (charRect(seg.node, mid).bottom > top) hi = mid;
      else lo = mid + 1;
    }
    const hit = firstBoxed(seg.node, lo);
    if (!hit) continue;
    const offset = seg.start + hit.off;
    return {
      snippet: placeSnippet(idx.text, offset),
      frac: offset / idx.text.length,
      y: hit.rect.top,
    };
  }
  return null;
}

/**
 * Scroll so `place` sits where it was. False while the snippet
 * isn't in `root` (a surface still mounting shows a placeholder or nothing)
 * — the caller retries, and passes `fallback` on its last try to settle for
 * the same fraction of the way through.
 */
export function restorePlace(root: HTMLElement, place: Place, fallback = false): boolean {
  const idx = textIndex(root);
  if (!idx.text.trim()) return false;
  let off = findPlace(idx.text, place);
  if (off == null && !fallback) return false;
  if (off == null) off = Math.round(place.frac * (idx.text.length - 1));
  let seg = idx.segs[0];
  for (const s of idx.segs) {
    if (s.start > off) break;
    seg = s;
  }
  const hit = firstBoxed(seg.node, Math.max(0, off - seg.start));
  if (!hit) return true; // nothing visible to align — leave the scroll alone
  // No remembered height (the place came from the iframe): just under
  // whatever is pinned at the top — the root itself is about to move.
  let y = place.y ?? pinnedInset(root);
  // Some surfaces scroll inside their own box (the read view's 60vh pane)
  // rather than the page; move that box, and never above its top edge.
  const box = scrollBox(seg.node.parentElement);
  if (box) {
    y = Math.max(y, box.getBoundingClientRect().top);
    box.scrollTop += hit.rect.top - y;
  } else {
    window.scrollBy({ top: hit.rect.top - y, behavior: "instant" as ScrollBehavior });
  }
  return true;
}

/** Nearest ancestor that scrolls vertically itself, or null for the page. */
function scrollBox(el: Element | null): HTMLElement | null {
  for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    const oy = getComputedStyle(e).overflowY;
    if ((oy === "auto" || oy === "scroll") && e.scrollHeight > e.clientHeight + 1) {
      return e as HTMLElement;
    }
  }
  return null;
}

/**
 * Remember the place while the user scrolls the current surface; when
 * `surfaceKey` changes, put the new surface at the same place.
 *
 * `getSurface` returns the DOM element holding the current surface's text,
 * or null for a surface the page can't read (the artifact iframe) — then
 * `restoreElsewhere` gets the place instead, and the caller feeds the place
 * from that surface into the returned ref itself.
 */
export function useKeepPlace(opts: {
  surfaceKey: string;
  /** Changing it forgets the place (another document). */
  resetKey: string;
  getSurface: () => HTMLElement | null;
  restoreElsewhere?: (place: Place) => void;
}) {
  const placeRef = useRef<Place | null>(null);
  // While a restore waits for the new surface, scrolls are the layout
  // settling (a page that briefly collapses clamps to the top) — not the
  // reader moving, so they must not overwrite the place being restored.
  const restoringRef = useRef(false);
  const getSurface = useRef(opts.getSurface);
  getSurface.current = opts.getSurface;
  const restoreElsewhere = useRef(opts.restoreElsewhere);
  restoreElsewhere.current = opts.restoreElsewhere;

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (restoringRef.current) return;
        const el = getSurface.current();
        const p = el && capturePlace(el);
        // Never overwrite with null: a surface still loading has no text.
        if (p) placeRef.current = p;
      }, 150);
    };
    // Capture phase: a surface's own scroll box doesn't bubble to window.
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    placeRef.current = null;
  }, [opts.resetKey]);

  const prevKey = useRef(opts.surfaceKey);
  useLayoutEffect(() => {
    if (prevKey.current === opts.surfaceKey) return;
    prevKey.current = opts.surfaceKey;
    const place = placeRef.current;
    if (!place) return;
    let raf = 0;
    const deadline = performance.now() + 3000;
    const done = () => {
      // Let the scroll this restore caused pass before capturing again.
      setTimeout(() => {
        restoringRef.current = false;
      }, 250);
    };
    const attempt = () => {
      const el = getSurface.current();
      if (!el) {
        restoreElsewhere.current?.(place);
        done();
        return;
      }
      // The new surface may mount its text late (TipTap, a lazy viewer).
      const last = performance.now() > deadline;
      if (restorePlace(el, place, last) || last) done();
      else raf = requestAnimationFrame(attempt);
    };
    restoringRef.current = true;
    attempt();
    return () => {
      cancelAnimationFrame(raf);
      restoringRef.current = false;
    };
  }, [opts.surfaceKey]);

  return placeRef;
}
