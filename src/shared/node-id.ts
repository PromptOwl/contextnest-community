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
