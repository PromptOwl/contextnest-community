/**
 * Per-node write serialization.
 *
 * Serialize writes per node. Without this, concurrent saves (rapid autosave,
 * two tabs, MCP + REST) each read the same base version and append "base+1",
 * producing duplicate/swapped version numbers that break the engine diff
 * chain and split the DB count from history.yaml. Chaining a node's writes
 * through one promise makes read→write→version-append atomic. In-process is
 * enough: single-process server over local SQLite + filesystem.
 *
 * Shared (not private to nodes/service) so governance writes that resolve a
 * review — approve/reject/cancel — serialize against a concurrent author edit
 * of the same node. They MUST use the same key (`${nestId}::${nodeId}`) and the
 * same map instance to actually exclude each other.
 */
const nodeWriteChains = new Map<string, Promise<unknown>>();

/** Canonical lock key for a node. */
export function nodeWriteKey(nestId: string, nodeId: string): string {
  return `${nestId}::${nodeId}`;
}

export function withNodeWriteLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = (nodeWriteChains.get(key) ?? Promise.resolve()).catch(() => {});
  const run = prev.then(fn);
  nodeWriteChains.set(key, run);
  void run
    .catch(() => {})
    .finally(() => {
      if (nodeWriteChains.get(key) === run) nodeWriteChains.delete(key);
    });
  return run;
}

/**
 * Hold several node locks at once (a bulk review). Taken in sorted key order,
 * so two multi-lock holders can never wait on each other in a cycle.
 */
export function withNodeWriteLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  return [...new Set(keys)]
    .sort()
    .reduceRight<() => Promise<T>>((inner, key) => () => withNodeWriteLock(key, inner), fn)();
}
