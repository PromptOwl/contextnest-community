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
import { ArrowLeft, AlertTriangle, Users, Link2, Tag, Loader2, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import { getNestGraph, type NestGraph } from "../lib/api";
import { Button } from "./ui/button";

interface Props {
  nestId: string;
  nestName: string;
  onBack: () => void;
}

type Kind = "doc" | "steward" | "tag" | "root";
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
  kind: "link" | "tag" | "steward";
}

const COLORS: Record<Kind, string> = {
  doc: "#3b82f6",
  steward: "#16a34a",
  tag: "#f59e0b",
  root: "#64748b",
};

function linkStroke(kind: GLink["kind"]): string {
  return kind === "steward" ? "#16a34a66" : kind === "tag" ? "#f59e0b66" : "#94a3b8aa";
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 5;

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
export function OntologyGraphView({ nestId, nestName, onBack }: Props) {
  const [graph, setGraph] = useState<NestGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [layers, setLayers] = useState({ links: true, stewardship: true, categories: true });
  const [selected, setSelected] = useState<GNode | null>(null);

  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const [sim, setSim] = useState<{ nodes: GNode[]; links: GLink[] }>({ nodes: [], links: [] });

  // ── Pan / zoom ──
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ active: boolean; px: number; py: number }>({
    active: false,
    px: 0,
    py: 0,
  });

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

  const onPanStart = (e: ReactPointerEvent) => {
    drag.current = { active: true, px: e.clientX, py: e.clientY };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const onPanMove = (e: ReactPointerEvent) => {
    if (!drag.current.active) return;
    const dx = e.clientX - drag.current.px;
    const dy = e.clientY - drag.current.py;
    drag.current.px = e.clientX;
    drag.current.py = e.clientY;
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };
  const onPanEnd = () => {
    drag.current.active = false;
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getNestGraph(nestId)
      .then((g) => !cancelled && setGraph(g))
      .catch((e) => !cancelled && setError(e?.message || "Failed to load graph"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [nestId]);

  useEffect(() => {
    if (!wrapRef.current) return;
    const el = wrapRef.current;
    const ro = new ResizeObserver(() =>
      setSize({ w: el.clientWidth, h: Math.max(420, el.clientHeight) }),
    );
    ro.observe(el);
    return () => ro.disconnect();
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
      if (needRoot) nodes.push({ id: "root:nest", name: nestName, kind: "root", color: COLORS.root, val: 4 });
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
    // Fit the fresh layout into the viewport so a large graph never spills off.
    fitView(nodes, size.w, size.h);
  }, [data, size.w, size.h]);

  const radius = (n: GNode) => 3 + n.val;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
          <h1 className="text-lg font-semibold">Ontology · {nestName}</h1>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {(
            [
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
        </div>
      </div>

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
              <svg
                ref={svgRef}
                width={size.w}
                height={size.h}
                className="block touch-none"
              >
                {/* Background pan surface — dragging here pans; node clicks
                    sit above it and aren't intercepted. */}
                <rect
                  width={size.w}
                  height={size.h}
                  fill="transparent"
                  style={{ cursor: drag.current.active ? "grabbing" : "grab" }}
                  onPointerDown={onPanStart}
                  onPointerMove={onPanMove}
                  onPointerUp={onPanEnd}
                  onPointerLeave={onPanEnd}
                />
                <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
                  <g>
                    {sim.links.map((l, i) => {
                      const s = l.source as GNode;
                      const t = l.target as GNode;
                      if (s?.x == null || t?.x == null) return null;
                      return (
                        <line
                          key={i}
                          x1={s.x}
                          y1={s.y}
                          x2={t.x}
                          y2={t.y}
                          stroke={linkStroke(l.kind)}
                          strokeWidth={1 / view.k}
                        />
                      );
                    })}
                  </g>
                  <g>
                    {sim.nodes.map((n) => (
                      <g
                        key={n.id}
                        transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
                        onClick={() => setSelected(n)}
                        style={{ cursor: "pointer" }}
                      >
                        <circle
                          r={radius(n)}
                          fill={n.color}
                          stroke={selected?.id === n.id ? "#111827" : "#ffffff"}
                          strokeWidth={selected?.id === n.id ? 2 : 1}
                        />
                        <text x={radius(n) + 3} y={3} fontSize={9} fill="#475569">
                          {n.name.length > 24 ? n.name.slice(0, 24) + "…" : n.name}
                        </text>
                      </g>
                    ))}
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
            <NodeDetail node={selected} graph={graph} />
          )}

          <div className="text-xs text-muted-foreground space-y-1">
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

function NodeDetail({ node, graph }: { node: GNode; graph: NestGraph | null }) {
  const doc = node.kind === "doc" ? graph?.nodes.find((n) => n.id === node.id) : null;
  const linkCount =
    doc && graph
      ? graph.links.filter((l) => l.source === doc.id || l.target === doc.id).length
      : 0;
  return (
    <div className="border border-border rounded-lg bg-card p-3 text-sm">
      <div className="font-medium mb-1 break-all">{node.name}</div>
      <div className="text-xs text-muted-foreground capitalize">{node.kind}</div>
      {doc && (
        <div className="mt-2 space-y-1 text-xs">
          {doc.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {doc.tags.map((t) => (
                <span key={t} className="rounded bg-amber-50 text-amber-700 px-1.5 py-0.5">
                  #{t}
                </span>
              ))}
            </div>
          )}
          <div className="text-muted-foreground">
            {linkCount === 0 ? "No links (orphan)" : `${linkCount} link${linkCount === 1 ? "" : "s"}`}
          </div>
        </div>
      )}
    </div>
  );
}

function GapRow({ label, items, empty }: { label: string; items: string[]; empty: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-foreground">{label}</div>
      {items.length === 0 ? (
        <div className="text-xs text-muted-foreground">{empty}</div>
      ) : (
        <ul className="mt-0.5 space-y-0.5">
          {items.slice(0, 8).map((it, i) => (
            <li key={i} className="text-xs text-amber-700 break-all">
              {it}
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
