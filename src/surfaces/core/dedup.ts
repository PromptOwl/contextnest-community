/**
 * Dedup (PRD §4.9): title fingerprints and the duplicate rule. Pure; the
 * service gathers the candidates (pending/queued/held items, live holds,
 * published titles in the target folder) and hashes the token key.
 */
export const JACCARD_DUP = 0.6;

const STOPWORDS = new Set(
  "a an and are as at be by for from has have in into is it its of on or our that the their this to was we were will with via per new about after before over".split(" "),
);

export interface DedupCandidate {
  source: "pending" | "hold" | "published";
  kind: string | null;
  op?: string | null;
  target_node_id?: string | null;
  title_tokens: string[];
  held_on?: string | null;
}

/** Lower-cased title, punctuation stripped, stopwords removed, de-duplicated. */
export function titleTokens(title: string): string[] {
  const toks = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t));
  return [...new Set(toks)];
}

/** The string title_hash is computed over (sorted tokens, joined). */
export function tokenKey(tokens: string[]): string {
  return [...tokens].sort().join(" ");
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size && !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Duplicate = (a) an edit of the same node as a pending/held item or a live
 * hold, or (b) the same kind with Jaccard ≥ 0.6 against pending items or
 * holds, or any published title in the target folder (kind null = any).
 */
export function findDuplicate(
  item: { kind: string; op: string; title: string; target_node_id: string | null },
  candidates: DedupCandidate[],
  /** Sealed nests store holds as keyed hashes ("h:…"); compare hashed tokens to them. */
  hashToken?: (t: string) => string,
): DedupCandidate | null {
  const plain = titleTokens(item.title);
  const hashed = hashToken ? plain.map(hashToken) : null;
  const tokensFor = (c: DedupCandidate) => (hashed && c.title_tokens.some((t) => t.startsWith("h:")) ? hashed : plain);
  for (const c of candidates) {
    if (item.op === "edit" && item.target_node_id && c.op === "edit" && c.target_node_id === item.target_node_id && c.source !== "published") return c;
  }
  for (const c of candidates) {
    if (c.kind !== null && c.kind !== item.kind) continue;
    if (jaccard(tokensFor(c), c.title_tokens) >= JACCARD_DUP) return c;
  }
  return null;
}
