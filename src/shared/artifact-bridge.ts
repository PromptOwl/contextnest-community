/**
 * The viewer bridge appended to a hosted artifact when the in-app viewer
 * embeds it (`/hosted?embed=1`).
 *
 * The iframe is opaque-origin (see artifact-sandbox.ts), so the viewer can't
 * read its scroll position or touch its DOM. Without that, flipping between
 * Preview and Annotate lost your place, and the preview showed none of the
 * comment highlights. This script runs INSIDE the sandbox and talks to the
 * parent over postMessage only:
 *
 *   iframe → parent  cn-ready                      loaded, send me highlights
 *                    cn-place   {snippet, frac}    the text at the top of the view
 *                    cn-activate {id}              a highlighted quote was clicked
 *   parent → iframe  cn-goto    {snippet, frac}    scroll to this text
 *                    cn-highlights {items, active} paint these anchored quotes
 *
 * It grants the artifact nothing new: the page could already postMessage its
 * parent, and the parent validates every message (ui/src/lib/artifact-bridge.ts).
 * The parent sends only quotes taken from the artifact's own text, plus thread
 * ids — never comment bodies or authors. What the artifact's own scripts CAN
 * learn is which of its passages have open threads (and their opaque ids);
 * that is the accepted cost of painting highlights inside the frame.
 *
 * Matching ignores whitespace on both sides: the viewer's quotes come from the
 * extracted text (block newlines, collapsed runs), the DOM has neither.
 *
 * Plain `/hosted` (Open in new tab, the text fetch) never carries it.
 */
const BRIDGE_JS = String.raw`(function () {
  var P = window.parent;
  if (!P || P === window) return;
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, TEXTAREA: 1 };
  var WS = /\s/;
  function post(m) { try { P.postMessage(m, "*"); } catch (e) {} }

  // Whitespace-free text of the page + where each char lives. Built once and
  // reused until the DOM changes — scrolling alone never rebuilds it.
  // A page that re-renders gets its highlights repainted (debounced); our own
  // <style> insert is skipped so painting can't retrigger itself.
  // Back-off: a page that keeps changing (a clock, a ticker, a chart) would
  // otherwise rebuild the index and repaint every 250ms forever. A repaint
  // that follows the last within 2s doubles the wait, up to 8s; a quiet
  // spell resets it to 250ms.
  var cache = null, repaintT = 0, last = null, delay = 250, lastRepaint = 0;
  try {
    new MutationObserver(function (records) {
      var ours = records.every(function (r) {
        for (var i = 0; i < r.addedNodes.length; i++) if (r.addedNodes[i] !== styleEl) return false;
        return r.type === "childList" && r.removedNodes.length === 0 && r.addedNodes.length > 0;
      });
      if (ours) return;
      cache = null;
      // Throttle, not debounce: a page that never stops changing would keep
      // pushing a debounce back forever and never get repainted.
      if (last && last.items.length && !repaintT) {
        delay = Date.now() - lastRepaint < 2000 ? Math.min(delay * 2, 8000) : 250;
        repaintT = setTimeout(function () {
          repaintT = 0;
          lastRepaint = Date.now();
          paint(last.items, last.active);
        }, delay);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  } catch (e) {}
  // Index at most this much text: a huge or constantly-changing page costs
  // a bounded rebuild, and the place/highlights simply stop past the cap.
  var MAX_CHARS = 300000;
  function index() { return cache || (cache = build()); }
  function build() {
    var root = document.body || document.documentElement;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentNode;
        return p && SKIP[p.nodeName] ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    var text = "", nodes = [], offs = [], starts = new Map(), n;
    while ((n = w.nextNode())) {
      var d = n.data;
      starts.set(n, text.length);
      for (var i = 0; i < d.length; i++) {
        var c = d.charAt(i);
        if (WS.test(c)) continue;
        text += c; nodes.push(n); offs.push(i);
      }
      if (text.length >= MAX_CHARS) break;
    }
    return { text: text, nodes: nodes, offs: offs, starts: starts };
  }
  function strip(s) { return String(s || "").replace(/\s+/g, ""); }
  function charRect(idx, i) {
    var r = document.createRange();
    r.setStart(idx.nodes[i], idx.offs[i]);
    r.setEnd(idx.nodes[i], idx.offs[i] + 1);
    return r.getBoundingClientRect();
  }
  function visible(b) {
    return (b.width || b.height) && b.bottom > 0 && b.top < innerHeight &&
      b.right > 0 && b.left < innerWidth;
  }

  // The first text at the top of the view: hit-test a few points down the
  // page (cheap), and only if none lands on text, scan node by node.
  function place() {
    var idx = index();
    if (!idx.text.length) return null;
    var xs = [innerWidth / 2, innerWidth / 4, (innerWidth * 3) / 4, 24];
    for (var y = 2; y < innerHeight / 2; y += 12) {
      for (var k = 0; k < xs.length; k++) {
        var c = caret(xs[k], y);
        if (!c || !c.node || c.node.nodeType !== 3 || !idx.starts.has(c.node)) continue;
        // A node that begins inside the view counts from its start (a point
        // right of a short heading resolves to the heading's end).
        var nr = document.createRange();
        nr.selectNodeContents(c.node);
        var off = nr.getBoundingClientRect().top >= -4 ? 0 : c.offset;
        var at = idx.starts.get(c.node) + c.node.data.slice(0, off).replace(/\s+/g, "").length;
        if (at < idx.text.length) return { snippet: idx.text.slice(at, at + 40), frac: at / idx.text.length };
      }
    }
    var r = document.createRange(), last = null;
    for (var i = 0; i < idx.nodes.length; i++) {
      var nd = idx.nodes[i];
      if (nd === last) continue;
      last = nd;
      r.selectNodeContents(nd);
      var b = r.getBoundingClientRect();
      if (!(b.width || b.height) || b.bottom <= 0 || b.top >= innerHeight) continue;
      for (var j = i; j < idx.nodes.length && idx.nodes[j] === nd; j++) {
        if (visible(charRect(idx, j))) {
          return { snippet: idx.text.slice(j, j + 40), frac: j / idx.text.length };
        }
      }
    }
    return null;
  }

  function find(text, needle, frac) {
    if (!needle) return -1;
    var best = -1, bestD = Infinity, want = frac * text.length;
    for (var i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
      var d = Math.abs(i - want);
      if (d < bestD) { best = i; bestD = d; }
    }
    return best;
  }

  // A frame that was display:none has no viewport yet when it is shown;
  // hold the request until it has one, then scroll on the next frame.
  var pendingGo = null;
  function goTo(snippet, frac) {
    if (!innerHeight) { pendingGo = [snippet, frac]; return; }
    requestAnimationFrame(function () { scrollToText(snippet, frac); });
  }
  function scrollToText(snippet, frac) {
    var idx = index();
    if (!idx.text.length) return;
    var s = strip(snippet), at = -1;
    for (var len = Math.min(s.length, 40); len >= 8 && at < 0; len = Math.floor(len / 2)) {
      at = find(idx.text, s.slice(0, len), frac);
    }
    if (at < 0) at = Math.min(idx.text.length - 1, Math.max(0, Math.round(frac * idx.text.length)));
    var el = idx.nodes[at].parentElement;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "start" });
  }

  var ranges = [];
  var styleEl = null;
  function paint(items, active) {
    if (!(window.CSS && CSS.highlights && window.Highlight)) return;
    last = { items: items, active: active };
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.textContent = "::highlight(cn-comment){background-color:rgba(251,191,36,.35)}" +
        "::highlight(cn-comment-active){background-color:rgba(251,191,36,.75)}";
      (document.head || document.documentElement).appendChild(styleEl);
    }
    var idx = index();
    ranges = [];
    for (var k = 0; k < items.length; k++) {
      var q = strip(items[k].quote), tail = strip(items[k].before).slice(-24);
      if (!q) continue;
      var at = -1, first = -1;
      for (var i = idx.text.indexOf(q); i !== -1; i = idx.text.indexOf(q, i + 1)) {
        if (first < 0) first = i;
        if (tail && idx.text.slice(Math.max(0, i - tail.length), i) === tail) { at = i; break; }
      }
      // No context match: only trust the quote if it occurs exactly once. A
      // short, common quote ("the") would otherwise paint — and click
      // through to — the wrong place.
      if (at < 0 && first >= 0 && idx.text.indexOf(q, first + 1) === -1) at = first;
      if (at < 0) continue;
      var e = at + q.length - 1, r = document.createRange();
      r.setStart(idx.nodes[at], idx.offs[at]);
      r.setEnd(idx.nodes[e], idx.offs[e] + 1);
      ranges.push({ id: items[k].id, range: r });
    }
    CSS.highlights.set("cn-comment", new Highlight(...ranges.map(function (x) { return x.range; })));
    var hit = ranges.filter(function (x) { return x.id === active; });
    if (hit.length) CSS.highlights.set("cn-comment-active", new Highlight(hit[0].range));
    else CSS.highlights.delete("cn-comment-active");
  }

  function caret(x, y) {
    if (document.caretPositionFromPoint) {
      var p = document.caretPositionFromPoint(x, y);
      return p && { node: p.offsetNode, offset: p.offset };
    }
    if (document.caretRangeFromPoint) {
      var r = document.caretRangeFromPoint(x, y);
      return r && { node: r.startContainer, offset: r.startOffset };
    }
    return null;
  }

  var t = 0;
  function report() {
    clearTimeout(t);
    t = setTimeout(function () { var p = place(); if (p) post({ type: "cn-place", snippet: p.snippet, frac: p.frac }); }, 200);
  }
  addEventListener("scroll", report, true);
  addEventListener("keyup", report);
  addEventListener("resize", function () {
    if (pendingGo && innerHeight) { var g = pendingGo; pendingGo = null; goTo(g[0], g[1]); }
    report();
  });
  addEventListener("hashchange", report);
  addEventListener("click", function (ev) {
    report();
    var c = caret(ev.clientX, ev.clientY);
    if (!c) return;
    for (var i = 0; i < ranges.length; i++) {
      try {
        if (ranges[i].range.isPointInRange(c.node, c.offset)) {
          post({ type: "cn-activate", id: ranges[i].id });
          return;
        }
      } catch (e) {}
    }
  });
  addEventListener("message", function (ev) {
    if (ev.source !== P) return;
    var m = ev.data || {};
    if (m.type === "cn-goto") goTo(m.snippet, +m.frac || 0);
    else if (m.type === "cn-highlights" && Array.isArray(m.items)) {
      var items = m.items.slice(0, 500).filter(function (it) {
        return it && typeof it.id === "string" && typeof it.quote === "string" &&
          (it.before === undefined || typeof it.before === "string");
      });
      paint(items, typeof m.active === "string" ? m.active : null);
    }
  });
  function ready() { post({ type: "cn-ready" }); report(); }
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", ready);
  else ready();
})();`;

/**
 * The artifact with the bridge appended. Appended, not prepended: a script
 * ahead of `<!doctype html>` would drop the page into quirks mode. Content
 * after `</html>` is parsed into the body, which is where it should run.
 *
 * Known gap: an artifact whose markup ends inside an unclosed `<script>`,
 * `<!--`, `<textarea>` or `<plaintext>` swallows the bridge as text. Nothing
 * breaks — the viewer never hears `cn-ready`, so that preview simply gets no
 * highlights and no place-keeping.
 */
export function injectArtifactBridge(html: string): string {
  return `${html}\n<script data-cn-bridge>${BRIDGE_JS}</script>\n`;
}
