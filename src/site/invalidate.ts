/**
 * Public docs site (CU-wdqcq05jhm) — the "which nests have a site" cache is
 * read on every public request; the places that change the answer
 * (visibility, reader mode, name, branding, deletion) bump this generation so
 * this instance sees the change at once. Other instances catch up within the
 * cache's TTL. Dependency-free so any service can import it without a cycle.
 */
let generation = 0;

export function invalidateSiteNests(): void {
  generation++;
}

export function siteNestsGeneration(): number {
  return generation;
}
