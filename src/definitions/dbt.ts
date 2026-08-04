/**
 * dbt semantic-layer adapter — derives a governed graph from a parsed dbt
 * semantic YAML doc: one node per entry, edges between them, and steward
 * assignments from ownership.
 *
 * Pure and framework-free (unit-tested in test/dbt-semantic.test.ts): YAML.load
 * happens at the import-route layer and feeds these mappers the already-parsed
 * object. Nodes become `definition`-type nodes; edges become workflow-plane
 * typed edges; stewards feed assignSteward — all reusing existing primitives,
 * no new governance/graph code.
 */

export type SemanticKind = "semantic_model" | "metric";

export interface SemanticNode {
  /** The entry's `name` — becomes the node title. */
  title: string;
  kind: SemanticKind;
  description?: string;
  /** The raw parsed entry; the caller serializes it into the node body. */
  entry: unknown;
}

export interface SemanticEdge {
  /** Source node title. */
  from: string;
  /** Target node title. */
  to: string;
  /** `measures` = metric→model (via the measure it references); `joins` =
   *  model↔model (they share an entity / join key). */
  type: "measures" | "joins";
}

export interface SemanticSteward {
  /** Node title the steward governs (document-scoped). */
  scope: string;
  email: string;
  role: "reviewer";
}

const GROUPS: ReadonlyArray<readonly [key: string, kind: SemanticKind]> = [
  ["semantic_models", "semantic_model"],
  ["metrics", "metric"],
];

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

/**
 * One node per named entry under `semantic_models:` / `metrics:`. Unnamed or
 * malformed entries are skipped; junk input yields an empty list.
 */
export function dbtSemanticToNodes(doc: unknown): SemanticNode[] {
  if (!doc || typeof doc !== "object") return [];
  const d = doc as Record<string, unknown>;
  const out: SemanticNode[] = [];
  for (const [key, kind] of GROUPS) {
    for (const entry of asArray(d[key])) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const title = typeof e.name === "string" ? e.name.trim() : "";
      if (!title) continue;
      out.push({
        title,
        kind,
        description:
          typeof e.description === "string" ? e.description : undefined,
        entry,
      });
    }
  }
  return out;
}

/** dbt metric → the measure name it references (type_params.measure, string or {name}). */
function measureName(metric: any): string | null {
  const m = metric?.type_params?.measure ?? metric?.measure;
  if (typeof m === "string") return m;
  if (m && typeof m === "object" && typeof m.name === "string") return m.name;
  return null;
}

/**
 * Edges derived from the dbt structure:
 *  - `measures`: metric → the model that owns its referenced measure.
 *  - `joins`: model ↔ model when they share an entity (one edge per unordered
 *    pair, deduped).
 */
export function dbtSemanticToEdges(doc: unknown): SemanticEdge[] {
  if (!doc || typeof doc !== "object") return [];
  const d = doc as Record<string, unknown>;

  const measureToModel = new Map<string, string>();
  const entityToModels = new Map<string, Set<string>>();
  for (const m of asArray(d.semantic_models)) {
    if (!m || typeof m.name !== "string") continue;
    const model = m.name;
    for (const meas of asArray(m.measures)) {
      if (meas && typeof meas.name === "string") measureToModel.set(meas.name, model);
    }
    for (const ent of asArray(m.entities)) {
      if (ent && typeof ent.name === "string") {
        (entityToModels.get(ent.name) ??
          entityToModels.set(ent.name, new Set()).get(ent.name)!).add(model);
      }
    }
  }

  const edges: SemanticEdge[] = [];

  for (const met of asArray(d.metrics)) {
    if (!met || typeof met.name !== "string") continue;
    const measure = measureName(met);
    const model = measure ? measureToModel.get(measure) : undefined;
    if (model) edges.push({ from: met.name, to: model, type: "measures" });
  }

  const seen = new Set<string>();
  for (const modelSet of entityToModels.values()) {
    const list = [...modelSet].sort();
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const key = `${list[i]}|${list[j]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: list[i], to: list[j], type: "joins" });
      }
    }
  }

  return edges;
}

/** First string owner from meta.owner / owner / config.meta.owner. */
function ownerOf(entry: any): string | null {
  for (const c of [entry?.meta?.owner, entry?.owner, entry?.config?.meta?.owner]) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

/**
 * Steward assignments from ownership. Only owners that look like an email (a
 * nest member can be resolved) become stewards — team names/handles need a
 * separate mapping (stewards.yaml) and are skipped here rather than guessed.
 */
export function dbtSemanticToStewards(doc: unknown): SemanticSteward[] {
  if (!doc || typeof doc !== "object") return [];
  const d = doc as Record<string, unknown>;
  const out: SemanticSteward[] = [];
  for (const [key] of GROUPS) {
    for (const e of asArray(d[key])) {
      if (!e || typeof e.name !== "string" || !e.name.trim()) continue;
      const owner = ownerOf(e);
      if (owner && owner.includes("@")) {
        out.push({ scope: e.name.trim(), email: owner, role: "reviewer" });
      }
    }
  }
  return out;
}
