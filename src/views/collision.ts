/**
 * §1.12 view serving — keep a view's addresses free of other nodes.
 *
 * A view at `X` is served at `…/nodes/X/view/hosted` and its frames at
 * `…/nodes/X/view/blocks/<b>/hosted`. A node whose own id is `X/view` (or
 * sits under `X/view/blocks/`) would host at the very same URLs, so the two
 * would fight over them and only route order would decide who wins. This
 * module makes that state unreachable at WRITE time, in both directions:
 *
 *  (a) no node may be created/moved to `X/view` or under `X/view/blocks/`
 *      while a `type: view` node lives at `X`;
 *  (b) no view may be created at, moved to, or converted at `X` while any
 *      node lives at `X/view` or under `X/view/blocks/`.
 *
 * Ordinary ids like `nodes/foo/view` stay legal whenever `nodes/foo` is not a
 * view. One helper, called from every node-creating or id-changing path
 * (createNode — REST, MCP, held writes, bulk publish —, re-type, moveNode,
 * moveFolder, folder import). The view router's fall-through stays as
 * defense in depth for files that arrive outside the server.
 */
import type { NestStorage } from "@promptowl/contextnest-engine";
import { ConflictError } from "../shared/errors.js";

const VIEW = "view";

/** Every `X` for which `id` is `X/view` or lies under `X/view/blocks/`. */
export function viewOwnersOf(id: string): string[] {
  const segs = id.split("/");
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) {
    if (segs[i] !== "view") continue;
    const last = i === segs.length - 1;
    const underBlocks = segs[i + 1] === "blocks" && i + 2 < segs.length;
    if (last || underBlocks) out.push(segs.slice(0, i).join("/"));
  }
  return out;
}

/** True when `id` is `X/view` or under `X/view/blocks/`. */
export function isUnderViewAddress(id: string, x: string): boolean {
  return id === `${x}/view` || id.startsWith(`${x}/view/blocks/`);
}

type Doc = { id: string; type: string };

const typeOf = (d: { frontmatter?: { type?: unknown } }) => String(d.frontmatter?.type || "document");

async function readType(storage: NestStorage, id: string): Promise<string | null> {
  try {
    return typeOf(await storage.readDocument(id));
  } catch {
    return null;
  }
}

/**
 * Refuse (409) writing a node of `type` at `id` when it would share a view's
 * addresses. `ignore` names ids that are leaving (a folder move's sources).
 */
export async function assertNoViewCollision(
  storage: NestStorage,
  id: string,
  type: string,
  ignore: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const x of viewOwnersOf(id)) {
    if (ignore.has(x)) continue;
    if ((await readType(storage, x)) === VIEW) {
      throw new ConflictError(
        `"${id}" can't be used: ${x} is a view, and ${x}/view/… is where that view is served. Pick another title or folder.`,
      );
    }
  }
  if (type !== VIEW) return;
  const taken = (await storage.discoverDocuments({ includeRetired: true } as any))
    .map((d) => d.id)
    .find((other) => !ignore.has(other) && isUnderViewAddress(other, id));
  if (taken) {
    throw new ConflictError(
      `A view can't live at ${id}: ${taken} already uses the address the view would be served at (${id}/view/…). Move or rename that node first, or put the view somewhere else.`,
    );
  }
}

/**
 * The same rule over a batch arriving together (a folder import), against
 * the nodes already in the nest. Returns the ids to refuse, each with why.
 * When a view and a node under its address arrive together, the view is kept
 * and the other node refused.
 */
export function batchViewCollisions(incoming: Doc[], existing: Doc[]): Map<string, string> {
  const refused = new Map<string, string>();
  const views = new Set([...existing, ...incoming].filter((d) => d.type === VIEW).map((d) => d.id));
  for (const d of incoming) {
    const owner = viewOwnersOf(d.id).find((x) => views.has(x));
    if (owner) refused.set(d.id, `${owner} is a view, and ${owner}/view/… is where that view is served`);
  }
  const occupied = [...existing, ...incoming.filter((d) => !refused.has(d.id))].map((d) => d.id);
  for (const d of incoming) {
    if (d.type !== VIEW || refused.has(d.id)) continue;
    const taken = occupied.find((o) => isUnderViewAddress(o, d.id));
    if (taken) refused.set(d.id, `${taken} already uses the address the view would be served at`);
  }
  return refused;
}
