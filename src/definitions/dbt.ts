/**
 * dbt semantic-layer adapter — maps a parsed dbt semantic YAML doc to one
 * governed node per entry (`semantic_models[]` and `metrics[]`).
 *
 * Pure and framework-free (unit-tested in test/dbt-semantic.test.ts): the
 * YAML.load happens at the import-route layer and feeds this mapper the already
 * parsed object. Each returned SemanticNode becomes a `definition`-type node,
 * so it inherits the whole node-scoped governance stack (versions, stewardship,
 * approvals, diffs, comments) with no new governance code.
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

const GROUPS: ReadonlyArray<readonly [key: string, kind: SemanticKind]> = [
  ["semantic_models", "semantic_model"],
  ["metrics", "metric"],
];

/**
 * One node per named entry under `semantic_models:` / `metrics:`. Unnamed or
 * malformed entries are skipped; junk input yields an empty list.
 */
export function dbtSemanticToNodes(doc: unknown): SemanticNode[] {
  if (!doc || typeof doc !== "object") return [];
  const d = doc as Record<string, unknown>;
  const out: SemanticNode[] = [];
  for (const [key, kind] of GROUPS) {
    const arr = Array.isArray(d[key]) ? (d[key] as unknown[]) : [];
    for (const entry of arr) {
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
