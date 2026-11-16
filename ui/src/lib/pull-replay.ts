/**
 * Context pull replay (po-1252) — the pure part of the Graph view's replay:
 * which documents are lit at each step, which edge each step walked, and the
 * labels the pull log shows. The component owns timing and drawing.
 */

export interface PullStepLike {
  seq: number;
  nodeId: string;
  title: string | null;
  version: number | null;
  hop: number | null;
  via: string | null;
  bytes: number | null;
}

export interface PullLike {
  steps: PullStepLike[];
}

export interface ReplayEdge {
  from: string;
  to: string;
}

export interface ReplayFrame {
  /** Documents lit so far, in the order they lit. */
  lit: Set<string>;
  /** The document this step lit; null before the first step. */
  current: string | null;
  /** Edges walked so far. */
  edges: ReplayEdge[];
  /** 1-based position of each lit document. */
  order: Map<string, number>;
}

/**
 * The edge each step walked. Where the server ran the traversal the step
 * names the document it came from (`via`). A direct match (hop 0) walked
 * nothing. Where the traversal isn't recorded (the engine's selector walk),
 * the step is joined to the most recent earlier step it links to in the
 * graph, if any — the closest honest picture of the path.
 */
export function replayEdges(pull: PullLike, links: Array<[string, string]>): Array<ReplayEdge | null> {
  const adj = new Map<string, Set<string>>();
  for (const [a, b] of links) {
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  }
  return pull.steps.map((s, i) => {
    if (s.via) return { from: s.via, to: s.nodeId };
    if (s.hop != null) return null;
    for (let j = i - 1; j >= 0; j--) {
      const prev = pull.steps[j].nodeId;
      if (adj.get(s.nodeId)?.has(prev)) return { from: prev, to: s.nodeId };
    }
    return null;
  });
}

export function replayFrame(pull: PullLike, links: Array<[string, string]>, step: number): ReplayFrame {
  const last = Math.min(step, pull.steps.length - 1);
  const edgesPerStep = replayEdges(pull, links);
  const lit = new Set<string>();
  const order = new Map<string, number>();
  const edges: ReplayEdge[] = [];
  for (let i = 0; i <= last; i++) {
    const id = pull.steps[i].nodeId;
    lit.add(id);
    if (!order.has(id)) order.set(id, i + 1);
    const e = edgesPerStep[i];
    if (e) edges.push(e);
  }
  return { lit, current: last >= 0 ? pull.steps[last].nodeId : null, edges, order };
}

const TOOL_LABELS: Record<string, string> = {
  context_get: "Read",
  version: "Version read",
  context_search: "Search",
  search: "Search",
  context_query: "Query",
  query: "Query",
  context: "Context",
  context_resolve: "Resolve",
  context_table_query: "Table query",
  "table-query": "Table query",
};

export function toolLabel(tool: string | null, action: "read" | "retrieve"): string {
  if (tool && TOOL_LABELS[tool]) return TOOL_LABELS[tool];
  if (tool) return tool;
  return action === "read" ? "Opened" : "Retrieved";
}

/** What a pull's size measures, per tool — the surfaces hand over different
 *  things (API.md, pull log "Steps"), so the panel says which. */
export function sizeBasis(tool: string | null): string {
  if (tool === "context") return "Size of the compiled context blocks handed over (header, link and body).";
  if (tool === "context_resolve") return "Size of the title and body entries handed over.";
  return "Size of the document bodies handed over.";
}

export function pullTitle(p: {
  agent: string | null;
  actor: string | null;
  tool: string | null;
  action: "read" | "retrieve";
}): string {
  if (p.agent) return p.agent;
  if (p.actor) return p.actor;
  return `${toolLabel(p.tool, p.action)} pull`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** "Matched", "Hop 1 via <title>", or null when the walk isn't recorded. */
export function stepHowLabel(s: PullStepLike, titleOf: (id: string) => string): string | null {
  if (s.hop == null) return null;
  if (s.hop === 0) return "Matched";
  return s.via ? `Hop ${s.hop} via ${titleOf(s.via)}` : `Hop ${s.hop}`;
}

/** "just now", "4m ago", "3h ago", "2d ago", else the date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
