/**
 * Node-id containment guard.
 *
 * Node ids are slash-joined slug segments (e.g. `nodes/gtm/deals/foo`) and are
 * turned into filesystem paths by the engine's `readDocument`, which does
 * `join(nestRoot, id + ".md")` with NO containment check of its own. A
 * caller-supplied id containing `..` therefore escapes the nest's vault
 * directory — e.g. `../otherNest/nodes/secret` reads another tenant's file,
 * because the surrounding nest-permission checks validate the nest id in the
 * URL path, not the traversed target. This is the single chokepoint every
 * route that turns an untrusted id into a storage read must call first.
 */
import { ValidationError } from "./errors.js";

export function assertSafeNodeId(rawId: string): string {
  // Params arrive URL-decoded from the router; decode once more to defeat
  // double-encoding (%252e%252e → %2e%2e → ..). If that throws (a literal %),
  // keep the router-decoded form — the segment checks below still apply.
  let id = rawId;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    /* not further-encoded — validate as given */
  }
  if (!id || id.length > 512) {
    throw new ValidationError("invalid node id");
  }
  // NUL and backslash never appear in a legitimate id and are traversal /
  // injection primitives on some filesystems.
  if (id.includes("\0") || id.includes("\\")) {
    throw new ValidationError("invalid node id");
  }
  if (id.startsWith("/")) {
    throw new ValidationError("invalid node id (absolute path)");
  }
  for (const seg of id.split("/")) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new ValidationError("invalid node id (path traversal)");
    }
  }
  return id;
}

/**
 * Strip the `nodes/` storage root from a folder path — the folder twin of
 * folderOfId. `nodes` itself is the nest root, which is "" to a caller.
 */
export function folderPathOf(path: string): string {
  if (path === "nodes") return "";
  return path.startsWith("nodes/") ? path.slice(6) : path;
}

/**
 * The folder a node id sits in ("" for the nest root). The storage root
 * `nodes/` is not a user folder, so it is stripped — the UI's folderOfNode
 * does the same, and the two must agree on what a folder path is.
 *
 * Lives here rather than in nodes/service so the node index can derive a
 * row's folder without importing the service that reads from it.
 */
export function folderOfId(id: string): string {
  const rel = folderPathOf(id);
  const slash = rel.lastIndexOf("/");
  return slash > 0 ? rel.slice(0, slash) : "";
}

/**
 * Suffix marking an artifact's derived annotations node — the projection of its
 * comment threads (see annotations/service.ts). Lives here so the mention
 * fan-out can recognise a derived node without importing the annotation
 * service, which imports the node service, which imports the fan-out.
 */
export const DERIVED_ANNOTATIONS_SUFFIX = "--annotations";

/** True for the derived annotations projection of some other node. */
export function isDerivedAnnotationsId(nodeId: string): boolean {
  return nodeId.endsWith(DERIVED_ANNOTATIONS_SUFFIX);
}
