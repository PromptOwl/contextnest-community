/**
 * Pure-core unit tests for §1.12 view serving (src/views/core.ts, render.ts).
 * No HTTP, no DB: every vault read goes through a fake `ViewDeps`.
 *
 *   AC-4  escaping: no literal `<`, U+2028/2029 escaped, JSON round-trips
 *   AC-5  caps: row cap, per-entry byte cap, whole-payload byte cap
 *   AC-6  errors as data: missing / denied refs look identical, unsupported
 *         binding and unsupported kind
 *   AC-9  trust: an untrustworthy author short-circuits BEFORE any ACL call
 *   AC-16 kill switch: every entry withheld
 *   AC-18 injectNestData placement; buildNestData never includes an
 *         undeclared id
 */
import { describe, it, expect, vi } from "vitest";
import type { ViewMeta } from "@promptowl/contextnest-engine";
import {
  CAPS,
  buildNestData,
  serializeNestData,
  injectNestData,
  resolveBlocks,
  decideDataTrust,
  frameNestData,
  normalizeDataFrom,
  type ViewDeps,
  type Principal,
  type AuthorInfo,
  type ResolvedBlock,
} from "../src/views/core.js";
import { renderViewPage, renderPublicViewPage } from "../src/views/render.js";

const NEST = "nest-1";
const VIEWER: Principal = { userId: "u-viewer", email: "viewer@x.test", approvedOnly: false };

type Node = { id: string; type: string; body?: string; title?: string; tags?: string[] };

/** A fake vault: `nodes` exist; `hidden` exist but no principal may see them. */
function fakeDeps(opts: {
  nodes: Node[];
  hidden?: string[];
  table?: { columns: string[]; rows: Record<string, unknown>[] };
}): ViewDeps & { calls: string[] } {
  const calls: string[] = [];
  const byId = new Map(opts.nodes.map((n) => [n.id, n]));
  const hidden = new Set(opts.hidden ?? []);
  return {
    calls,
    async resolveRef(_nest, ref) {
      calls.push(`resolveRef:${ref}`);
      const id = ref.replace(/^contextnest:\/\//, "");
      const n = byId.get(id);
      return n ? { id: n.id, type: n.type } : null;
    },
    async visible(_nest, ids) {
      calls.push(`visible:${ids.join(",")}`);
      return new Set(ids.filter((id) => !hidden.has(id)));
    },
    async readMd(_nest, id) {
      calls.push(`readMd:${id}`);
      return { ok: true, text: byId.get(id)?.body ?? "", version: 1 };
    },
    async selectNodes(_nest, selector) {
      calls.push(`selectNodes:${selector}`);
      const tag = selector.replace(/^#/, "");
      return opts.nodes
        .filter((n) => n.tags?.includes(tag))
        .map((n) => ({ id: n.id, title: n.title ?? n.id, version: 1, status: "published", tags: n.tags ?? [] }));
    },
    async tableRows(_nest, id) {
      calls.push(`tableRows:${id}`);
      return opts.table ?? { columns: [], rows: [] };
    },
  };
}

const ok = (b: ResolvedBlock) => (b as any).ok === true;

describe("serializeNestData (AC-4)", () => {
  it("escapes every < and U+2028/U+2029, and JSON.parse round-trips the original", () => {
    const evil = "</script><script>alert(1)</script>\u2028line\u2029para";
    const data = { d: { ok: true, kind: "data", columns: ["c"], rows: [{ c: evil }] } } as any;
    const json = serializeNestData(data);
    expect(json).not.toContain("<");
    expect(json).not.toContain("\u2028");
    expect(json).not.toContain("\u2029");
    expect(json).toContain("\\u2028");
    expect(json).toContain("\\u2029");
    expect(json).toContain("\\u003c/script>");
    expect(JSON.parse(json)).toEqual(data);
    expect(JSON.parse(json).d.rows[0].c).toBe(evil);
  });
});

describe("injectNestData placement (AC-18)", () => {
  const TAG_RE = /<script type="application\/json" id="nest-data">/g;
  const count = (s: string) => (s.match(TAG_RE) || []).length;

  it("goes after the doctype and before the first <script", () => {
    const html = '<!doctype html><html><head><script>/*app*/</script></head><body></body></html>';
    const out = injectNestData(html, "{}");
    expect(count(out)).toBe(1);
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out.indexOf('id="nest-data"')).toBeLessThan(out.indexOf("<script>/*app*/"));
    expect(out.replace(/<script type="application\/json" id="nest-data">\{\}<\/script>/, "")).toBe(html);
  });

  it("with no doctype and no head/script, goes at byte 0", () => {
    const html = "<p>hello</p>";
    const out = injectNestData(html, "{}");
    expect(count(out)).toBe(1);
    expect(out.startsWith('<script type="application/json" id="nest-data">{}</script>')).toBe(true);
    expect(out.endsWith(html)).toBe(true);
  });

  it("with no doctype, goes before the first <script even when it is uppercase", () => {
    const html = "<html><body><p>x</p><SCRIPT>go()</SCRIPT></body></html>";
    const out = injectNestData(html, "{}");
    expect(count(out)).toBe(1);
    expect(out.indexOf('id="nest-data"')).toBeLessThan(out.indexOf("<SCRIPT>"));
    expect(out.indexOf('id="nest-data"')).toBeGreaterThan(out.indexOf("<p>x</p>"));
  });

  it("with no <head>, goes before the first script after the doctype", () => {
    const html = "<!DOCTYPE html><body><script>a()</script></body>";
    const out = injectNestData(html, "{}");
    expect(out).toBe(
      '<!DOCTYPE html><body><script type="application/json" id="nest-data">{}</script><script>a()</script></body>',
    );
  });

  it("goes before </head> when the head has no script", () => {
    const html = "<!doctype html><html><head><title>t</title></head><body><script>x()</script></body></html>";
    const out = injectNestData(html, "{}");
    expect(out.indexOf('id="nest-data"')).toBeLessThan(out.indexOf("</head>"));
    expect(out.indexOf('id="nest-data"')).toBeGreaterThan(out.indexOf("<title>"));
  });

  it("with an existing id=\"nest-data\" in the artifact, inserts exactly one more, FIRST", () => {
    const html =
      '<!doctype html><html><head><script type="application/json" id="nest-data">{"fake":1}</script></head></html>';
    const out = injectNestData(html, '{"real":1}');
    expect(count(out)).toBe(2); // ours + the artifact's own, untouched
    expect(out.indexOf('{"real":1}')).toBeLessThan(out.indexOf('{"fake":1}'));
  });

  // Review finding: a `<script` or `</head>` that is not a tag (inside a
  // comment, a raw-text element or an attribute value) must not be taken as
  // the insertion point, or the tag lands where getElementById can't see it.
  const NEST = '<script type="application/json" id="nest-data">{}</script>';
  for (const [name, html, before] of [
    ["an HTML comment", "<!doctype html><html><head><!-- <script src=x> --><script>app()</script></head></html>", "<script>app()"],
    ["a <title>", "<!doctype html><html><head><title>a </head> b</title><script>app()</script></head></html>", "<script>app()"],
    ["a <textarea>", "<!doctype html><body><textarea><script>no</script></textarea><script>app()</script></body>", "<script>app()"],
    ["an attribute value", '<!doctype html><head><meta name="x" content="<script>"></head><body></body>', "</head>"],
    ["a single-quoted attribute with >", "<!doctype html><head><meta content='a > <script>'><script>app()</script></head>", "<script>app()"],
  ] as const) {
    it(`skips a <script / </head> inside ${name}`, () => {
      const out = injectNestData(html, "{}");
      expect(count(out)).toBe(1);
      const at = out.indexOf(NEST);
      expect(out.slice(at + NEST.length).startsWith(before)).toBe(true);
      expect(out.replace(NEST, "")).toBe(html);
    });
  }

  it("stays linear on hostile markup (no catastrophic backtracking)", () => {
    for (const html of ["<a".repeat(50_000), '<a "'.repeat(50_000), "<!--" + "<a b=c ".repeat(50_000), "<a " + "b".repeat(200_000),
      // Unterminated quotes, a few hundred KB (review finding).
      '<a "' + "x".repeat(400_000), ("<a '" + "x".repeat(400)).repeat(1_000), ('<a "' + "<b ".repeat(100)).repeat(1_000)]) {
      const t0 = Date.now();
      expect(count(injectNestData(html, "{}"))).toBe(1);
      expect(Date.now() - t0).toBeLessThan(1000);
    }
  });
});

describe("buildNestData", () => {
  const listBlock = (n: number): ResolvedBlock => ({
    index: 0,
    id: "m",
    kind: "list",
    ok: true,
    items: Array.from({ length: n }, (_, i) => ({ id: `nodes/n${i}`, title: `N${i}` })),
  });

  it("contains exactly the data_from ids, in order — never an undeclared one (AC-18)", () => {
    const resolved: ResolvedBlock[] = [
      { index: 0, id: "a", kind: "callout", ok: true, text: "A", tone: "info" },
      { index: 1, id: "b", kind: "callout", ok: true, text: "B", tone: "info" },
      { index: 2, id: "secret", kind: "md", ok: true, text: "do not leak", version: 1 },
    ];
    const data = buildNestData(resolved, ["b", "a"]);
    expect(Object.keys(data)).toEqual(["b", "a"]);
    expect(JSON.stringify(data)).not.toContain("do not leak");
    expect(buildNestData(resolved, undefined)).toEqual({});
    expect(Object.keys(buildNestData(resolved, "a"))).toEqual(["a"]);
  });

  it("an error entry has no items/rows/text, and truncated appears only when true", () => {
    const resolved: ResolvedBlock[] = [
      { index: 0, id: "k", kind: "kpi", ok: false, error: "unsupported_kind" },
      listBlock(2),
    ];
    const data = buildNestData(resolved, ["k", "m"]) as any;
    expect(data.k).toEqual({ ok: false, kind: "kpi", error: "unsupported_kind" });
    expect("truncated" in data.m).toBe(false);
  });

  it("caps an entry at MAX_BLOCK_BYTES by dropping trailing rows (AC-5)", () => {
    const big = "x".repeat(1000);
    const rows = Array.from({ length: 400 }, (_, i) => ({ k: `${i}`, v: big }));
    const resolved: ResolvedBlock[] = [
      { index: 0, id: "d", kind: "data", ok: true, columns: ["k", "v"], rows },
    ];
    const data = buildNestData(resolved, ["d"]) as any;
    expect(data.d.ok).toBe(true);
    expect(data.d.truncated).toBe(true);
    expect(data.d.rows.length).toBeLessThan(400);
    expect(Buffer.byteLength(serializeNestData({ d: data.d } as any))).toBeLessThanOrEqual(
      CAPS.MAX_BLOCK_BYTES + 10,
    );
    expect(Buffer.byteLength(JSON.stringify(data.d))).toBeLessThanOrEqual(CAPS.MAX_BLOCK_BYTES);
    // Kept rows are a prefix of the source, in order.
    expect(data.d.rows[0]).toEqual(rows[0]);
  });

  it("truncates md text at a UTF-8 boundary (AC-5)", () => {
    const text = "é".repeat(CAPS.MAX_BLOCK_BYTES); // 2 bytes each
    const data = buildNestData(
      [{ index: 0, id: "t", kind: "md", ok: true, text, version: 1 }],
      ["t"],
    ) as any;
    expect(data.t.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(data.t))).toBeLessThanOrEqual(CAPS.MAX_BLOCK_BYTES);
    expect(data.t.text).toMatch(/^é+$/);
  });

  it("later entries past MAX_NEST_DATA_BYTES become too_large (AC-5)", () => {
    const chunk = "y".repeat(200_000);
    const resolved: ResolvedBlock[] = Array.from({ length: 7 }, (_, i) => ({
      index: i,
      id: `b${i}`,
      kind: "md" as const,
      ok: true as const,
      text: chunk,
      version: 1,
    }));
    const ids = resolved.map((b) => b.id);
    const data = buildNestData(resolved, ids) as any;
    expect(Object.keys(data)).toEqual(ids);
    expect(data.b0.ok).toBe(true);
    const tooLarge = ids.filter((id) => data[id].error === "too_large");
    expect(tooLarge.length).toBeGreaterThan(0);
    // Once one entry is over budget, so is everything after it.
    const first = ids.indexOf(tooLarge[0]);
    expect(ids.slice(first).every((id) => data[id].error === "too_large")).toBe(true);
    expect(Buffer.byteLength(serializeNestData(data))).toBeLessThanOrEqual(CAPS.MAX_NEST_DATA_BYTES);
  });

  it("data_from entries past MAX_DATA_FROM are too_large", () => {
    const resolved: ResolvedBlock[] = Array.from({ length: 12 }, (_, i) => ({
      index: i,
      id: `c${i}`,
      kind: "callout" as const,
      ok: true as const,
      text: "t",
      tone: "info" as const,
    }));
    const data = buildNestData(resolved, resolved.map((b) => b.id)) as any;
    expect(data.c9.ok).toBe(true);
    expect(data.c10).toEqual({ ok: false, kind: "callout", error: "too_large" });
    expect(data.c11.error).toBe("too_large");
  });

  it("normalizeDataFrom takes a string, an array or nothing", () => {
    expect(normalizeDataFrom("a")).toEqual(["a"]);
    expect(normalizeDataFrom(["a", "b", "a"])).toEqual(["a", "b"]);
    expect(normalizeDataFrom(undefined)).toEqual([]);
  });
});

describe("resolveBlocks (AC-5, AC-6)", () => {
  const view = (blocks: any[]): ViewMeta => ({ blocks }) as ViewMeta;

  it("a missing ref and a denied ref resolve to the identical not_found shape", async () => {
    const deps = fakeDeps({
      nodes: [{ id: "nodes/secret", type: "document", body: "classified" }],
      hidden: ["nodes/secret"],
    });
    const blocks = await resolveBlocks(
      view([
        { id: "gone", md: { ref: "nodes/missing" } },
        { id: "denied", md: { ref: "nodes/secret" } },
      ]),
      NEST,
      [VIEWER],
      deps,
    );
    const data = buildNestData(blocks, ["gone", "denied"]) as any;
    expect(data.gone).toEqual({ ok: false, kind: "md", error: "not_found" });
    expect(data.denied).toEqual({ ok: false, kind: "md", error: "not_found" });
    expect(deps.calls).not.toContain("readMd:nodes/secret");
  });

  it("a data binding to a non-table is unsupported_binding; a kpi is unsupported_kind", async () => {
    const deps = fakeDeps({ nodes: [{ id: "nodes/doc", type: "document" }] });
    const blocks = await resolveBlocks(
      view([
        { id: "d", data: { binding: "nodes/doc" } },
        { id: "k", kpi: { from: "d" } },
      ]),
      NEST,
      [VIEWER],
      deps,
    );
    const data = buildNestData(blocks, ["d", "k"]) as any;
    expect(data.d).toEqual({ ok: false, kind: "data", error: "unsupported_binding" });
    expect(data.k).toEqual({ ok: false, kind: "kpi", error: "unsupported_kind" });
  });

  it("caps a data block at MAX_ROWS and a list at MAX_LIST_ITEMS, reporting truncated", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ n: String(i) }));
    const nodes: Node[] = [
      { id: "nodes/t", type: "table" },
      ...Array.from({ length: 250 }, (_, i) => ({
        id: `nodes/m${i}`,
        type: "document",
        title: `M${i}`,
        tags: ["metric"],
      })),
    ];
    const deps = fakeDeps({ nodes, table: { columns: ["n"], rows } });
    const blocks = await resolveBlocks(
      view([
        { id: "d", data: { binding: "nodes/t" } },
        { id: "m", list: { select: "#metric", limit: 500 } },
      ]),
      NEST,
      [VIEWER],
      deps,
    );
    const data = buildNestData(blocks, ["d", "m"]) as any;
    expect(data.d.rows.length).toBe(CAPS.MAX_ROWS);
    expect(data.d.truncated).toBe(true);
    expect(data.m.items.length).toBe(CAPS.MAX_LIST_ITEMS);
    expect(data.m.truncated).toBe(true);
    // fields default to id + title.
    expect(Object.keys(data.m.items[0]).sort()).toEqual(["id", "title"]);
  });

  it("list members a principal cannot see are dropped", async () => {
    const deps = fakeDeps({
      nodes: [
        { id: "nodes/a", type: "document", title: "A", tags: ["metric"] },
        { id: "nodes/b", type: "document", title: "B", tags: ["metric"] },
      ],
      hidden: ["nodes/b"],
    });
    const blocks = await resolveBlocks(
      view([{ id: "m", list: { select: "#metric" } }]),
      NEST,
      [VIEWER],
      deps,
    );
    const m = blocks[0] as any;
    expect(m.items.map((i: any) => i.title)).toEqual(["A"]);
  });

  it("stops at MAX_BLOCKS", async () => {
    const deps = fakeDeps({ nodes: [] });
    const blocks = await resolveBlocks(
      view(Array.from({ length: 60 }, (_, i) => ({ callout: { text: `c${i}` } }))),
      NEST,
      [VIEWER],
      deps,
    );
    expect(blocks.length).toBe(CAPS.MAX_BLOCKS);
    // Index-derived ids for blocks without one.
    expect(blocks[3].id).toBe("_b3");
  });
});

describe("decideDataTrust (AC-9, AC-16)", () => {
  const author = (over: Partial<AuthorInfo> = {}): AuthorInfo => ({
    email: "author@x.test",
    userId: "u-author",
    isSystem: false,
    nestPermission: "write",
    ...over,
  });
  const base = {
    stewardship: false,
    viewApproved: true,
    artifactApproved: true,
    viewer: VIEWER,
    authors: [author()],
    killSwitch: false,
  };

  it("stewardship on: still the viewer plus every author — approval may be self-publication (H-1)", () => {
    const r = decideDataTrust({ ...base, stewardship: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.principals.map((p) => p.userId)).toEqual(["u-viewer", "u-author"]);
  });

  it("stewardship on: an author without access withholds, and no authors withholds (H-1)", () => {
    expect(
      decideDataTrust({ ...base, stewardship: true, authors: [author({ nestPermission: "none" })] }).ok,
    ).toBe(false);
    expect(decideDataTrust({ ...base, stewardship: true, authors: [] }).ok).toBe(false);
  });

  it("stewardship off: viewer plus every author", () => {
    const r = decideDataTrust(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.principals.map((p) => p.userId)).toEqual(["u-viewer", "u-author"]);
  });

  it.each([
    ["an unapproved view version", { viewApproved: false }],
    ["an unapproved artifact version", { artifactApproved: false }],
    ["the kill switch", { killSwitch: true }],
    ["a system author", { authors: [author({ email: "system:auto-publish:a@x.test", isSystem: true })] }],
    ["an empty author", { authors: [author({ email: "", userId: null })] }],
    ["an unknown author", { authors: [author({ userId: null })] }],
    ["an author with no nest permission", { authors: [author({ nestPermission: "none" })] }],
    ["no authors at all", { authors: [] }],
  ])("withholds for %s", (_label, over) => {
    const r = decideDataTrust({ ...base, ...(over as object) });
    expect(r.ok).toBe(false);
  });

  it("the kill switch withholds on a governed nest too", () => {
    expect(decideDataTrust({ ...base, stewardship: true, killSwitch: true }).ok).toBe(false);
  });
});

describe("frameNestData (AC-9 flow, AC-16)", () => {
  const meta = {
    blocks: [
      { id: "d", data: { binding: "nodes/t" } },
      { id: "m", list: { select: "#metric" } },
      { id: "h", html: { ref: "nodes/a", data_from: ["d", "m"] } },
    ],
  } as ViewMeta;

  it.each([
    ["system author", { email: "system:auto-publish:x", userId: "u1", isSystem: true, nestPermission: "write" }],
    ["empty author", { email: "", userId: null, isSystem: false, nestPermission: "none" }],
    ["unknown email", { email: "ghost@x.test", userId: null, isSystem: false, nestPermission: "none" }],
    ["permission none", { email: "gone@x.test", userId: "u2", isSystem: false, nestPermission: "none" }],
  ])("a %s withholds every entry without calling visible()", async (_label, bad) => {
    const deps = fakeDeps({ nodes: [{ id: "nodes/t", type: "table" }] });
    const visible = vi.spyOn(deps, "visible");
    const tableRows = vi.spyOn(deps, "tableRows");
    const out = await frameNestData({
      view: meta,
      dataFrom: ["d", "m"],
      nestId: NEST,
      deps,
      trust: {
        stewardship: false,
        viewApproved: true,
        artifactApproved: true,
        viewer: VIEWER,
        authors: [
          { email: "fine@x.test", userId: "u-fine", isSystem: false, nestPermission: "write" },
          bad as AuthorInfo,
        ],
        killSwitch: false,
      },
    });
    expect(out.data).toEqual({
      d: { ok: false, kind: "data", error: "withheld" },
      m: { ok: false, kind: "list", error: "withheld" },
    });
    expect(visible).not.toHaveBeenCalled();
    expect(tableRows).not.toHaveBeenCalled();
    expect(deps.calls).toEqual([]);
  });

  it("the kill switch withholds every entry (AC-16)", async () => {
    const deps = fakeDeps({ nodes: [{ id: "nodes/t", type: "table" }] });
    const out = await frameNestData({
      view: meta,
      dataFrom: ["d", "m"],
      nestId: NEST,
      deps,
      trust: {
        stewardship: true,
        viewApproved: true,
        artifactApproved: true,
        viewer: VIEWER,
        authors: [],
        killSwitch: true,
      },
    });
    expect(Object.values(out.data).every((e: any) => e.error === "withheld")).toBe(true);
    expect(deps.calls).toEqual([]);
  });

  it("when trusted, resolves only the data_from targets", async () => {
    const deps = fakeDeps({
      nodes: [
        { id: "nodes/t", type: "table" },
        { id: "nodes/a", type: "artifact" },
        { id: "nodes/x", type: "document", title: "X", tags: ["metric"] },
      ],
      table: { columns: ["k"], rows: [{ k: "1" }] },
    });
    const out = await frameNestData({
      view: meta,
      dataFrom: ["d"],
      nestId: NEST,
      deps,
      trust: {
        stewardship: true,
        viewApproved: true,
        artifactApproved: true,
        viewer: VIEWER,
        authors: [{ email: "author@x.test", userId: "u-author", isSystem: false, nestPermission: "write" }],
        killSwitch: false,
      },
    });
    expect(out.data).toEqual({ d: { ok: true, kind: "data", columns: ["k"], rows: [{ k: "1" }] } });
    expect(deps.calls.some((c) => c.startsWith("selectNodes"))).toBe(false);
  });
});

describe("render", () => {
  it("escapes every text, renders md without raw HTML, and frames html blocks without allow-popups", () => {
    const html = renderViewPage({
      title: "<b>T</b>",
      intro: "Intro <script>alert(1)</script>",
      blocks: [
        { index: 0, id: "c", kind: "callout", ok: true, text: "<img src=x onerror=1>", tone: "warning" },
        { index: 1, id: "h", kind: "html", ok: true, artifactId: "nodes/a", dataFrom: [] },
        { index: 2, id: "k", kind: "kpi", ok: false, error: "unsupported_kind" },
        { index: 3, id: "g", kind: "html", ok: false, error: "not_found" },
      ],
      frameUrl: (id) => `/frame/${id}?a=1&b="2"`,
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>T</b>");
    expect(html).toContain("&lt;b&gt;T&lt;/b&gt;");
    expect((html.match(/<iframe /g) || []).length).toBe(1);
    expect(html).toContain('<iframe sandbox="allow-scripts allow-modals" src="/frame/h?a=1&amp;b=&quot;2&quot;"');
    expect(html).not.toContain("allow-popups");
    expect(html).toContain("not supported yet");
  });

  it("the public page shows the intro and one placeholder per block, nothing else", () => {
    const html = renderPublicViewPage({ title: "Pub", intro: "Hello **there**", blockCount: 3 });
    expect((html.match(/Available to nest members/g) || []).length).toBe(3);
    expect(html).toContain("<strong>there</strong>");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("nest-data");
  });
});
