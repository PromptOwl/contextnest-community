/**
 * A zip made by compressing a folder wraps every entry in that folder's name
 * ("my-nest/CONTEXT.md"). The folder picker drops that root, so the zip path
 * must too, or CONTEXT.md lands in a subfolder and the nest has no
 * instructions. `nodes/` and `sources/` are the engine's own layout (an
 * exported bundle), never a wrapper.
 */
export function stripSharedRoot<T extends { path: string }>(files: T[]): T[] {
  const roots = new Set(files.map((f) => f.path.split("/")[0]));
  const [root] = roots;
  if (roots.size !== 1 || root === "nodes" || root === "sources") return files;
  if (files.some((f) => !f.path.includes("/"))) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(root.length + 1) }));
}
