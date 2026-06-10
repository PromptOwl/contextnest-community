/**
 * Backlinks ("what links here") — pure, framework-free so it's unit-testable
 * in the node test env. Computed client-side from the node list, which
 * already returns each node's content; no server changes.
 *
 * A node links to a target doc when any of its `[[target]]` /
 * `[[target|alias]]` wiki links resolves to that doc by id, title, or bare
 * slug (case-insensitive) — the same resolution the WikiLink extension's
 * checkExists uses.
 */

const wikiLinkRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export interface BacklinkNode {
  id: string;
  title: string;
  content?: string;
}

function bareSlug(idOrTarget: string): string {
  const idx = idOrTarget.lastIndexOf("/");
  return idx >= 0 ? idOrTarget.slice(idx + 1) : idOrTarget;
}

/** All wiki-link targets in a markdown body (the part before any `|`). */
export function extractWikiLinkTargets(content: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(wikiLinkRegex.source, "g");
  while ((m = re.exec(content ?? "")) !== null) {
    const t = m[1].trim();
    if (t) out.push(t);
  }
  return out;
}

/** Nodes (other than the target itself) whose content links to the target. */
export function findBacklinks(
  nodes: BacklinkNode[],
  target: { id: string; title: string },
): Array<{ id: string; title: string }> {
  const targetId = target.id.toLowerCase();
  const targetTitle = (target.title ?? "").toLowerCase();
  const targetSlug = bareSlug(target.id).toLowerCase();

  const matches = (t: string): boolean => {
    const lower = t.toLowerCase();
    return (
      lower === targetId ||
      (targetTitle !== "" && lower === targetTitle) ||
      bareSlug(t).toLowerCase() === targetSlug
    );
  };

  const out: Array<{ id: string; title: string }> = [];
  for (const node of nodes) {
    if (node.id.toLowerCase() === targetId) continue;
    const targets = extractWikiLinkTargets(node.content ?? "");
    if (targets.some(matches)) out.push({ id: node.id, title: node.title });
  }
  return out;
}
