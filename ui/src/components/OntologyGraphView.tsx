import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
} from "d3-force";
import { AlertTriangle, Users, Link2, Tag, Loader2, ZoomIn, ZoomOut, Maximize2, Copy, Check, FolderTree } from "lucide-react";
import { getNestGraph, type NestGraph } from "../lib/api";
import { copyTextWithToast } from "../lib/clipboard";
import { Button } from "./ui/button";
import { NestPageHeader } from "./NestPageHeader";

interface Props {
  nestId: string;
  nestName: string;
  /** Open the nest list filtered by a tag (tag chip in the detail panel). */
  onOpenTag?: (tag: string) => void;
  onBack: () => void;
}

type Kind = "doc" | "steward" | "tag" | "root" | "folder";
interface GNode extends SimulationNodeDatum {
  id: string;
  name: string;
  kind: Kind;
  color: string;
  val: number;
}
interface GLink {
  source: string | GNode;
  target: string | GNode;
  kind: "link" | "tag" | "steward" | "structure";
}

const COLORS: Record<Kind, string> = {
  doc: "#3b82f6",
  steward: "#16a34a",
  tag: "#f59e0b",
  root: "#64748b",
  folder: "#a855f7",
};

function linkStroke(kind: GLink["kind"]): string {
  return kind === "steward"
    ? "#16a34a66"
    : kind === "tag"
      ? "#f59e0b66"
      : kind === "structure"
        ? "#a855f766"
        : "#94a3b8aa";
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 5;

/**
 * Deterministic selector for a graph node, in the grammar POST /context
 * accepts: docs by exact [[Title]] (resolved server-side, hop-expanded),
 * tags by #name. Stewards and the root have no selector of their own —
 * callers fall back to the neighborhood union. A title containing "]]" or
 * "|" can't be expressed in an OR-union of wiki selectors (the server splits
 * parts on "|" before matching [[...]]), so those yield no selector rather
 * than a broken one.
 */
function selectorForNode(n: GNode): string | null {
  if (n.kind === "doc") {
    return n.name.includes("]]") || n.name.includes("|")
      ? null
      : `[[${n.name}]]`;
  }
  if (n.kind === "tag") return `#${n.name.replace(/^#/, "")}`;
  return null;
}

/** Wrap for a single-quoted shell argument: ' → '\'' so a title with an
 *  apostrophe can't break out of the copied curl -d payload. */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Pan/zoom transform: screen = world * k + (x, y). */
interface View {
  x: number;
  y: number;
  k: number;
}

/**
 * Ontology graph view — nodes + [[wikilink]] edges + tag clusters + stewardship
 * overlay, laid out with a d3-force simulation and rendered as SVG (pure JS, no
 * native deps). The coverage-gaps panel is the headline: unstewarded
 * categories, bottleneck stewards, orphan nodes.
 */
export function OntologyGraphView({ nestId, nestName, onOpenTag, onBack }: Props) {
  const [graph, setGraph] = useState<NestGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layers, setLayers] = useState({ links: true, stewardship: true, categories: true, structure: true });
  const [selected, setSelected] = useState<GNode | null>(null);
  // Traversal depth for the highlighted neighborhood AND the copyable
  // query — the same number feeds the server's `hops` param, so what you
  // see highlighted is what the query pulls.
  const [hopDepth, setHopDepth] = useState(1);

  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const [sim, setSim] = useState<{ nodes: GNode[]; links: GLink[] }>({ nodes: [], links: [] });

  // ── Pan / zoom + node drag ──
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [panning, setPanning] = useState(false);
  // One gesture at a time: either panning the canvas or dragging a node.
  const drag = useRef<
    | { mode: "pan"; px: number; py: number }
    | { mode: "node"; node: GNode; moved: boolean }
    | null
  >(null);

  // Has the user moved the viewport since this graph loaded? Toggling a layer
  // rebuilds the node set, which re-runs the layout below — and re-fitting
  // there threw away whatever region they had zoomed into. Reset when a new
  // graph arrives (nothing to preserve) and when the canvas resizes (the
  // layout recentres on the new size, so an old viewport can leave it
  // off-screen entirely).
  const userMoved = useRef(false);
  const fittedSize = useRef({ w: 0, h: 0 });

  // client px → world coords (undo pan + zoom), for node dragging.
  const toWorld = (clientX: number, clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left - view.x) / view.k, y: (clientY - r.top - view.y) / view.k };
  };

  // Fit the laid-out graph into the viewport (centred, padded). Used on first
  // layout and via the Fit button so a large graph never spills off-screen.
  const fitView = (nodes: GNode[], w: number, h: number) => {
    const pts = nodes.filter((n) => n.x != null && n.y != null);
    if (!pts.length) return setView({ x: w / 2, y: h / 2, k: 1 });
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of pts) {
      minX = Math.min(minX, n.x!);
      minY = Math.min(minY, n.y!);
      maxX = Math.max(maxX, n.x!);
      maxY = Math.max(maxY, n.y!);
    }
    const pad = 48;
    const gw = maxX - minX || 1;
    const gh = maxY - minY || 1;
    const k = clamp(Math.min((w - 2 * pad) / gw, (h - 2 * pad) / gh), MIN_ZOOM, 1.5);
    setView({
      x: w / 2 - ((minX + maxX) / 2) * k,
      y: h / 2 - ((minY + maxY) / 2) * k,
      k,
    });
  };

  // Zoom by a factor about a screen anchor (default: viewport centre), keeping
  // the world point under the anchor fixed.
  const zoomBy = (factor: number, ax = size.w / 2, ay = size.h / 2) => {
    userMoved.current = true;
    setView((v) => {
      const k = clamp(v.k * factor, MIN_ZOOM, MAX_ZOOM);
      const wx = (ax - v.x) / v.k;
      const wy = (ay - v.y) / v.k;
      return { k, x: ax - wx * k, y: ay - wy * k };
    });
  };

  // Wheel zoom toward the cursor. Attached natively (non-passive) so
  // preventDefault stops the page from scrolling under the graph.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
    // Re-bind once the svg actually mounts (it renders only after loading
    // clears) and on resize — otherwise the listener never attaches and the
    // browser's default ctrl+wheel zooms the whole page instead of the graph.
  }, [size.w, size.h, loading, error]);

  // Pointer down on empty canvas → pan. Capture on the svg so moves keep
  // routing here even when the cursor leaves a node during a drag.
  const onPanStart = (e: ReactPointerEvent) => {
    svgRef.current?.setPointerCapture?.(e.pointerId);
    drag.current = { mode: "pan", px: e.clientX, py: e.clientY };
    setPanning(true);
  };
  // Pointer down on a node → drag that node (stops the pan from also starting).
  const onNodeDown = (e: ReactPointerEvent, n: GNode) => {
    e.stopPropagation();
    svgRef.current?.setPointerCapture?.(e.pointerId);
    drag.current = { mode: "node", node: n, moved: false };
  };
  const onPanMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.mode === "pan") {
      const dx = e.clientX - d.px;
      const dy = e.clientY - d.py;
      d.px = e.clientX;
      d.py = e.clientY;
      userMoved.current = true;
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    } else {
      d.moved = true;
      const p = toWorld(e.clientX, e.clientY);
      d.node.x = p.x;
      d.node.y = p.y;
      // Lines reference the same node objects, so a new array ref re-renders both.
      setSim((s) => ({ ...s, nodes: s.nodes.slice() }));
    }
  };
  const onPanEnd = (e: ReactPointerEvent) => {
    const d = drag.current;
    svgRef.current?.releasePointerCapture?.(e.pointerId);
    // A node press that never moved is a click → toggle selection.
    if (d?.mode === "node" && !d.moved) {
      setSelected((cur) => (cur?.id === d.node.id ? null : d.node));
    }
    drag.current = null;
    setPanning(false);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getNestGraph(nestId)
      .then((g) => {
        if (cancelled) return;
        // A different graph: no viewport worth keeping, so let it fit.
        userMoved.current = false;
        setGraph(g);
      })
      .catch((e) => !cancelled && setError(e?.message || "Failed to load graph"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [nestId]);

  useEffect(() => {
    if (!wrapRef.current) return;
    const el = wrapRef.current;
    const apply = () =>
      setSize({ w: el.clientWidth, h: Math.max(420, el.clientHeight) });
    // Set the real size synchronously at mount — the observer fires async, so
    // without this the first simulation runs at the 800px default and clips
    // the layout on narrower viewports until a resize nudges it.
    apply();
    // Debounce resizes: each size change restarts the 300-tick layout, so an
    // unthrottled observer would thrash the main thread during a drag-resize.
    let t: ReturnType<typeof setTimeout>;
    const ro = new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(apply, 150);
    });
    ro.observe(el);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, []);

  // Governance signals are now computed server-side over the FULL set (so they
  // stay accurate even when the drawn graph is truncated for the hairball cap).
  const signals = graph?.signals ?? null;

  // ── Build renderable graph from active layers ──
  const data = useMemo<{ nodes: GNode[]; links: GLink[] }>(() => {
    if (!graph) return { nodes: [], links: [] };
    const nodes: GNode[] = [];
    const links: GLink[] = [];
    const orphanIds = new Set((signals?.orphans || []).map((n) => n.id));

    for (const n of graph.nodes) {
      nodes.push({
        id: n.id,
        name: n.title,
        kind: "doc",
        color: orphanIds.has(n.id) ? "#ef4444" : COLORS.doc,
        val: 2,
      });
    }
    if (layers.links) for (const l of graph.links) links.push({ ...l, kind: "link" });

    // The nest root — shared by the Structure layer (below) and nest-scope
    // stewardship. Added at most once regardless of which layer needs it.
    const ensureRoot = () => {
      if (!nodes.some((n) => n.id === "root:nest"))
        nodes.push({ id: "root:nest", name: nestName, kind: "root", color: COLORS.root, val: 4 });
    };

    // ── Structure layer: nest → (folder →)* doc, so the whole nest reads as
    // one connected tree even when docs share no wikilinks, and subfolder
    // paths (engine ids `nodes/<a>/<b>/<slug>`) nest visibly under the root. ──
    if (layers.structure) {
      ensureRoot();
      const seenStruct = new Set<string>();
      const addStruct = (source: string, target: string) => {
        const key = `${source}~>${target}`;
        if (seenStruct.has(key)) return;
        seenStruct.add(key);
        links.push({ source, target, kind: "structure" });
      };
      const seenFolder = new Set<string>();
      for (const n of graph.nodes) {
        const parts = n.id.split("/").filter(Boolean);
        // Drop the leading `nodes/` container and the filename slug; the middle
        // segments are the folder chain.
        const dirs = parts[0] === "nodes" ? parts.slice(1, -1) : parts.slice(0, -1);
        let prev = "root:nest";
        let acc = "";
        for (const seg of dirs) {
          acc = acc ? `${acc}/${seg}` : seg;
          const fid = `folder:${acc}`;
          if (!seenFolder.has(fid)) {
            seenFolder.add(fid);
            nodes.push({ id: fid, name: seg, kind: "folder", color: COLORS.folder, val: 2 });
          }
          addStruct(prev, fid);
          prev = fid;
        }
        addStruct(prev, n.id);
      }
    }

    if (layers.categories) {
      for (const t of graph.tags)
        nodes.push({ id: `tag:${t.name}`, name: `#${t.name}`, kind: "tag", color: COLORS.tag, val: 1 + Math.min(t.count, 4) });
      for (const n of graph.nodes)
        for (const t of n.tags) links.push({ source: n.id, target: `tag:${t}`, kind: "tag" });
    }

    if (layers.stewardship) {
      const labelById = new Map(graph.stewards.map((s) => [s.id, s.label]));
      for (const s of graph.stewards)
        nodes.push({ id: `steward:${s.id}`, name: s.label, kind: "steward", color: COLORS.steward, val: 3 });
      let needRoot = false;
      for (const e of graph.stewardEdges) {
        const from = `steward:${e.steward}`;
        if (!labelById.has(e.steward)) continue;
        if (e.scope === "tag") {
          // Tag-scope steward edge: hop through the tag node when the Categories
          // layer is on, otherwise pin straight to the doc(s) the tag covers so
          // the steward never floats orphaned with Categories off.
          if (layers.categories) {
            links.push({ source: from, target: e.target, kind: "steward" });
          } else {
            const tag = e.target.replace(/^tag:/, "");
            for (const n of graph.nodes)
              if (n.tags.includes(tag)) links.push({ source: from, target: n.id, kind: "steward" });
          }
        } else if (e.scope === "document") {
          links.push({ source: from, target: e.target, kind: "steward" });
        } else {
          needRoot = true;
          links.push({ source: from, target: "root:nest", kind: "steward" });
        }
      }
      if (needRoot) ensureRoot();
    }

    const present = new Set(nodes.map((n) => n.id));
    return {
      nodes,
      links: links.filter(
        (l) => present.has(l.source as string) && present.has(l.target as string),
      ),
    };
  }, [graph, layers, signals, nestName]);

  // ── Run the force simulation to completion, then render static SVG ──
  useEffect(() => {
    if (!data.nodes.length) {
      setSim({ nodes: [], links: [] });
      return;
    }
    const nodes: GNode[] = data.nodes.map((n) => ({ ...n }));
    const links: GLink[] = data.links.map((l) => ({ ...l }));
    const simulation = forceSimulation(nodes)
      .force("link", forceLink<GNode, GLink>(links).id((d) => d.id).distance(55).strength(0.35))
      .force("charge", forceManyBody().strength(-170))
      .force("center", forceCenter(size.w / 2, size.h / 2))
      .force("collide", forceCollide(14))
      .stop();
    for (let i = 0; i < 300; i++) simulation.tick();
    setSim({ nodes, links });
    // Fit the fresh layout so a large graph never spills off — but not over a
    // viewport the user chose. A layer toggle lands here with the same canvas,
    // so it keeps their pan and zoom; a resize refits, since the layout is
    // recentred on the new size and the old viewport may not contain it.
    const resized =
      fittedSize.current.w !== size.w || fittedSize.current.h !== size.h;
    if (!userMoved.current || resized) {
      fitView(nodes, size.w, size.h);
      fittedSize.current = { w: size.w, h: size.h };
    }
  }, [data, size.w, size.h]);

  const radius = (n: GNode) => 3 + n.val;

  // BFS the selected node's N-hop neighborhood over the visible links.
  // Sim links carry resolved GNode refs after the force pass, so read ids
  // off the endpoints. Null when nothing is selected → no dimming.
  const neighborhood = useMemo<Set<string> | null>(() => {
    if (!selected) return null;
    const adj = new Map<string, string[]>();
    for (const l of sim.links) {
      const s = typeof l.source === "string" ? l.source : l.source.id;
      const t = typeof l.target === "string" ? l.target : l.target.id;
      (adj.get(s) ?? adj.set(s, []).get(s)!).push(t);
      (adj.get(t) ?? adj.set(t, []).get(t)!).push(s);
    }
    const seen = new Set<string>([selected.id]);
    let frontier = [selected.id];
    for (let d = 0; d < hopDepth && frontier.length; d++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const nb of adj.get(id) ?? []) {
          if (!seen.has(nb)) {
            seen.add(nb);
            next.push(nb);
          }
        }
      }
      frontier = next;
    }
    return seen;
  }, [selected, hopDepth, sim.links]);

  const nodesById = useMemo(
    () => new Map(sim.nodes.map((n) => [n.id, n])),
    [sim.nodes],
  );

  return (
    <div className="space-y-4">
      <NestPageHeader nestName={nestName} onBack={onBack}>
        <div className="flex items-center gap-3 text-sm">
          {(
            [
              ["structure", "Structure", FolderTree],
              ["links", "Links", Link2],
              ["stewardship", "Stewardship", Users],
              ["categories", "Categories", Tag],
            ] as const
          ).map(([key, label, Icon]) => (
            <label key={key} className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={layers[key]}
                onChange={(e) => setLayers((l) => ({ ...l, [key]: e.target.checked }))}
              />
              <Icon className="h-3.5 w-3.5" />
              {label}
            </label>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // Back to untouched: the next layout fits again, as on load.
              userMoved.current = false;
              setView({ x: 0, y: 0, k: 1 });
            }}
            title="Reset pan & zoom"
          >
            Reset view
          </Button>
        </div>
      </NestPageHeader>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
        <div
          ref={wrapRef}
          className="border border-border rounded-lg bg-card overflow-hidden h-[560px] relative"
        >
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading ontology…
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center text-red-500 text-sm">
              {error}
            </div>
          )}
          {!loading && !error && graph?.truncated && (
            <div className="absolute top-2 left-2 z-10 rounded bg-amber-100 text-amber-800 text-xs px-2 py-1 border border-amber-300">
              Showing {graph.nodes.length} of {graph.totalNodes} nodes (highest-connected). Gaps below cover all {graph.totalNodes}.
            </div>
          )}
          {!loading && !error && (
            <>
              {/* Pan handlers live on the svg itself: dragging empty canvas
                  pans, node presses stopPropagation and drag their node. */}
              <svg
                ref={svgRef}
                width={size.w}
                height={size.h}
                className="block touch-none"
                style={{ cursor: panning ? "grabbing" : "grab" }}
                onPointerDown={onPanStart}
                onPointerMove={onPanMove}
                onPointerUp={onPanEnd}
                onPointerLeave={onPanEnd}
              >
                <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                  <g>
                    {sim.links.map((l, i) => {
                      const s = l.source as GNode;
                      const t = l.target as GNode;
                      if (s?.x == null || t?.x == null) return null;
                      const inHood =
                        !neighborhood ||
                        (neighborhood.has(s.id) && neighborhood.has(t.id));
                      return (
                        <line
                          key={i}
                          x1={s.x}
                          y1={s.y}
                          x2={t.x}
                          y2={t.y}
                          stroke={linkStroke(l.kind)}
                          strokeWidth={(inHood && neighborhood ? 1.6 : 1) / view.k}
                          opacity={inHood ? 1 : 0.15}
                        />
                      );
                    })}
                  </g>
                  <g>
                    {sim.nodes.map((n) => {
                      const inHood = !neighborhood || neighborhood.has(n.id);
                      return (
                        <g
                          key={n.id}
                          transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
                          onPointerDown={(e) => onNodeDown(e, n)}
                          style={{ cursor: "grab" }}
                          opacity={inHood ? 1 : 0.25}
                        >
                          <circle
                            r={radius(n)}
                            fill={n.color}
                            stroke={
                              selected?.id === n.id
                                ? "#111827"
                                : inHood && neighborhood
                                  ? "#111827aa"
                                  : "#ffffff"
                            }
                            strokeWidth={selected?.id === n.id ? 2 : 1}
                          />
                          <text x={radius(n) + 3} y={3} fontSize={9} fill="#475569">
                            {n.name.length > 24 ? n.name.slice(0, 24) + "…" : n.name}
                          </text>
                        </g>
                      );
                    })}
                  </g>
                </g>
              </svg>
              {/* Zoom controls */}
              <div className="absolute bottom-2 right-2 z-10 flex flex-col gap-1">
                <ZoomCtl label="Zoom in" onClick={() => zoomBy(1.25)}>
                  <ZoomIn className="h-4 w-4" />
                </ZoomCtl>
                <ZoomCtl label="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
                  <ZoomOut className="h-4 w-4" />
                </ZoomCtl>
                <ZoomCtl label="Fit to view" onClick={() => fitView(sim.nodes, size.w, size.h)}>
                  <Maximize2 className="h-4 w-4" />
                </ZoomCtl>
              </div>
            </>
          )}
        </div>

        <div className="space-y-4">
          <div className="border border-border rounded-lg bg-card p-3">
            <div className="flex items-center gap-1.5 font-medium text-sm mb-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" /> Coverage gaps
            </div>
            {!signals ? (
              <p className="text-xs text-muted-foreground">—</p>
            ) : (
              <div className="space-y-3 text-sm">
                <GapRow
                  label="Categories with no steward"
                  items={signals.unstewardedTags.map((t) => `#${t.name} (${t.count})`)}
                  empty="Every category has a steward."
                  onSelect={
                    onOpenTag &&
                    ((i) => onOpenTag(signals.unstewardedTags[i].name))
                  }
                  selectTitle={(i) =>
                    `Show #${signals.unstewardedTags[i].name} documents`
                  }
                />
                <GapRow
                  label="Bottleneck stewards (≥50% of nodes)"
                  items={signals.bottlenecks.map((b) => `${b.label} — ${b.share}%`)}
                  empty="No single-owner concentration."
                />
                <GapRow
                  label="Orphan nodes (no links)"
                  items={signals.orphans.map((n) => n.title)}
                  empty="No orphans — everything connects."
                />
              </div>
            )}
          </div>

          {selected && (
            <NodeDetail
              node={selected}
              graph={graph}
              nestId={nestId}
              hopDepth={hopDepth}
              onHopDepth={setHopDepth}
              neighborhood={neighborhood}
              nodesById={nodesById}
              onOpenTag={onOpenTag}
            />
          )}

          <div className="text-xs text-muted-foreground space-y-1">
            <Legend color={COLORS.root} label="Nest" />
            <Legend color={COLORS.folder} label="Folder" />
            <Legend color={COLORS.doc} label="Document" />
            <Legend color="#ef4444" label="Orphan document" />
            <Legend color={COLORS.tag} label="Category / tag" />
            <Legend color={COLORS.steward} label="Steward" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ZoomCtl({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded border border-border bg-card text-foreground shadow-sm hover:bg-accent"
    >
      {children}
    </button>
  );
}

function NodeDetail({
  node,
  graph,
  nestId,
  hopDepth,
  onHopDepth,
  neighborhood,
  nodesById,
  onOpenTag,
}: {
  node: GNode;
  graph: NestGraph | null;
  nestId: string;
  hopDepth: number;
  onHopDepth: (d: number) => void;
  neighborhood: Set<string> | null;
  nodesById: Map<string, GNode>;
  onOpenTag?: (tag: string) => void;
}) {
  const doc = node.kind === "doc" ? graph?.nodes.find((n) => n.id === node.id) : null;
  const linkCount =
    doc && graph
      ? graph.links.filter((l) => l.source === doc.id || l.target === doc.id).length
      : 0;

  const selector = selectorForNode(node);
  // Union selector for everything highlighted — the deterministic "give me
  // exactly this set" query (hops:0), independent of server traversal.
  const hoodSelectors = neighborhood
    ? [...neighborhood]
        .map((id) => nodesById.get(id))
        .filter((n): n is GNode => !!n)
        .map(selectorForNode)
        .filter((s): s is string => !!s)
    : [];
  const unionSelector = hoodSelectors.join(" | ");
  const serverUrl =
    typeof window !== "undefined" ? window.location.origin : "";
  // Anchor query: this node + hopDepth server-side hops. Matches what's
  // highlighted (the server traverses the same link graph).
  const curl = selector
    ? `curl -X POST ${serverUrl}/nests/${nestId}/context \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer <api-key>" \\\n  -d ${shellSingleQuote(JSON.stringify({ selector, hops: hopDepth }))}`
    : null;

  return (
    <div className="border border-border rounded-lg bg-card p-3 text-sm space-y-2">
      <div>
        <div className="font-medium mb-1 break-all">{node.name}</div>
        <div className="text-xs text-muted-foreground capitalize">{node.kind}</div>
      </div>
      {doc && (
        <div className="space-y-1 text-xs">
          {doc.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {doc.tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => onOpenTag?.(t)}
                  disabled={!onOpenTag}
                  className="rounded bg-amber-50 text-amber-700 px-1.5 py-0.5 hover:bg-amber-100 disabled:hover:bg-amber-50 disabled:cursor-default"
                  title={onOpenTag ? `Show #${t} documents` : `#${t}`}
                >
                  #{t}
                </button>
              ))}
            </div>
          )}
          <div className="text-muted-foreground">
            {linkCount === 0
              ? "No wikilinks"
              : `${linkCount} wikilink${linkCount === 1 ? "" : "s"}`}
          </div>
        </div>
      )}

      {/* Click-to-query: the selection IS a query. Depth drives both the
          highlight and the copyable request. */}
      <div className="border-t pt-2 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">Query this selection</span>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            hops
            <select
              className="border border-border rounded bg-card px-1 py-0.5 text-xs"
              value={hopDepth}
              onChange={(e) => onHopDepth(Number(e.target.value))}
            >
              {[0, 1, 2, 3].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        </div>
        {selector && (
          <QuerySnippet label="Selector" value={selector} />
        )}
        {curl && (
          <QuerySnippet
            label={`API call (this node + ${hopDepth} hop${hopDepth === 1 ? "" : "s"})`}
            value={curl}
          />
        )}
        {hoodSelectors.length > 1 && (
          <QuerySnippet
            label={`Highlighted set (${hoodSelectors.length} nodes, exact — use hops: 0)`}
            value={unionSelector}
          />
        )}
        {!selector && hoodSelectors.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No selector for this node kind — select a document or tag.
          </p>
        )}
      </div>
    </div>
  );
}

function QuerySnippet({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyTextWithToast(value))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className="text-[11px] text-muted-foreground truncate">{label}</span>
        <button
          type="button"
          aria-label={`Copy ${label}`}
          onClick={copy}
          className="flex h-5 w-5 items-center justify-center rounded hover:bg-accent shrink-0"
        >
          {copied ? (
            <Check className="h-3 w-3 text-green-600" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </button>
      </div>
      <pre className="bg-muted rounded px-2 py-1.5 text-[10px] font-mono whitespace-pre-wrap break-all max-h-28 overflow-y-auto">
        {value}
      </pre>
    </div>
  );
}

function GapRow({
  label,
  items,
  empty,
  onSelect,
  selectTitle,
}: {
  label: string;
  items: string[];
  empty: string;
  /** Makes each item a button — index is into `items`. */
  onSelect?: (index: number) => void;
  selectTitle?: (index: number) => string;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-foreground">{label}</div>
      {items.length === 0 ? (
        <div className="text-xs text-muted-foreground">{empty}</div>
      ) : (
        <ul className="mt-0.5 space-y-0.5">
          {items.slice(0, 8).map((it, i) => (
            <li key={i} className="text-xs text-amber-700 break-all">
              {onSelect ? (
                <button
                  type="button"
                  onClick={() => onSelect(i)}
                  title={selectTitle?.(i)}
                  className="text-left hover:underline"
                >
                  {it}
                </button>
              ) : (
                it
              )}
            </li>
          ))}
          {items.length > 8 && (
            <li className="text-xs text-muted-foreground">+{items.length - 8} more</li>
          )}
        </ul>
      )}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      {label}
    </div>
  );
}
