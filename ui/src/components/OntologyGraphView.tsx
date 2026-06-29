import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
} from "d3-force";
import { ArrowLeft, AlertTriangle, Users, Link2, Tag, Loader2 } from "lucide-react";
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
  const [size, setSize] = useState({ w: 800, h: 560 });
  const [sim, setSim] = useState<{ nodes: GNode[]; links: GLink[] }>({ nodes: [], links: [] });

  // ── Interaction: drag nodes, pan the canvas, wheel-zoom ──────────────────
  const svgRef = useRef<SVGSVGElement>(null);
  const [tf, setTf] = useState({ x: 0, y: 0, k: 1 });
  const [panning, setPanning] = useState(false);
  const drag = useRef<
    | { mode: "node"; node: GNode }
    | { mode: "pan"; px: number; py: number; ox: number; oy: number }
    | null
  >(null);

  // client px → graph coords (undo pan + zoom)
  const toGraph = (clientX: number, clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left - tf.x) / tf.k, y: (clientY - r.top - tf.y) / tf.k };
  };

  const onNodeDown = (e: ReactPointerEvent, n: GNode) => {
    e.stopPropagation(); // don't also start a pan
    svgRef.current?.setPointerCapture(e.pointerId);
    drag.current = { mode: "node", node: n };
    setSelected(n);
  };

  const onBgDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    svgRef.current?.setPointerCapture(e.pointerId);
    drag.current = { mode: "pan", px: e.clientX, py: e.clientY, ox: tf.x, oy: tf.y };
    setPanning(true);
  };

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.mode === "node") {
      const p = toGraph(e.clientX, e.clientY);
      d.node.x = p.x;
      d.node.y = p.y;
      // Lines reference the same node objects, so a new array ref re-renders both.
      setSim((s) => ({ ...s, nodes: s.nodes.slice() }));
    } else {
      setTf((t) => ({ ...t, x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) }));
    }
  };

  const onUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drag.current) return;
    svgRef.current?.releasePointerCapture?.(e.pointerId);
    drag.current = null;
    setPanning(false);
  };

  // React's onWheel is passive, so preventDefault is ignored there — attach a
  // native non-passive listener to zoom toward the cursor without scrolling.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      setTf((t) => {
        const k = Math.min(4, Math.max(0.3, t.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
        const gx = (sx - t.x) / t.k;
        const gy = (sy - t.y) / t.k;
        return { k, x: sx - gx * k, y: sy - gy * k };
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

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

  // ── Governance signals (the value, not the pretty web) ──
  const signals = useMemo(() => {
    if (!graph) return null;
    const docIds = new Set(graph.nodes.map((n) => n.id));
    const linked = new Set<string>();
    for (const l of graph.links) {
      linked.add(l.source);
      linked.add(l.target);
    }
    const orphans = graph.nodes.filter((n) => !linked.has(n.id));

    const hasNestSteward = graph.stewards.some((s) => s.scope === "nest");
    const stewardedTags = new Set(
      graph.stewards.filter((s) => s.scope === "tag").map((s) => s.target),
    );
    const unstewardedTags = hasNestSteward
      ? []
      : graph.tags.filter((t) => !stewardedTags.has(t.name));

    const tagDocCount = new Map(graph.tags.map((t) => [t.name, t.count]));
    const bySteward = new Map<string, number>();
    for (const s of graph.stewards) {
      const covered =
        s.scope === "nest" ? docIds.size : s.scope === "tag" ? tagDocCount.get(s.target) || 0 : 1;
      bySteward.set(s.email, (bySteward.get(s.email) || 0) + covered);
    }
    const bottlenecks = [...bySteward.entries()]
      .filter(([, c]) => docIds.size > 0 && c / docIds.size >= 0.5)
      .map(([email, c]) => ({ email, share: Math.round((c / docIds.size) * 100) }))
      .sort((a, b) => b.share - a.share);

    return { orphans, unstewardedTags, bottlenecks };
  }, [graph]);

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
      for (const email of new Set(graph.stewards.map((s) => s.email)))
        nodes.push({ id: `steward:${email}`, name: email, kind: "steward", color: COLORS.steward, val: 3 });
      let needRoot = false;
      for (const s of graph.stewards) {
        const from = `steward:${s.email}`;
        if (s.scope === "tag") {
          if (layers.categories) links.push({ source: from, target: `tag:${s.target}`, kind: "steward" });
        } else if (s.scope === "document") {
          links.push({ source: from, target: s.target, kind: "steward" });
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTf({ x: 0, y: 0, k: 1 })}
            title="Reset pan & zoom"
          >
            Reset view
          </Button>
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
          {!loading && !error && (
            <svg
              ref={svgRef}
              width={size.w}
              height={size.h}
              className="block"
              style={{ cursor: panning ? "grabbing" : "grab", touchAction: "none" }}
              onPointerDown={onBgDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerLeave={onUp}
            >
              <g transform={`translate(${tf.x},${tf.y}) scale(${tf.k})`}>
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
                      strokeWidth={1}
                    />
                  );
                })}
              </g>
              <g>
                {sim.nodes.map((n) => (
                  <g
                    key={n.id}
                    transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
                    onPointerDown={(e) => onNodeDown(e, n)}
                    style={{ cursor: "grab" }}
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
                  items={signals.bottlenecks.map((b) => `${b.email} — ${b.share}%`)}
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
            <div className="border border-border rounded-lg bg-card p-3 text-sm">
              <div className="font-medium mb-1 break-all">{selected.name}</div>
              <div className="text-xs text-muted-foreground capitalize">{selected.kind}</div>
            </div>
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
