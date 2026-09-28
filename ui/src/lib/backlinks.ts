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

/**
 * Linking docs that reference the target by TITLE form only — `[[Some
 * Title]]` rather than `[[nodes/slug]]`. These links BREAK when the doc is
 * retitled (the id/slug stays stable; the title does not). Used to warn
 * before a rename.
 */
export function titleFormBacklinks(
  nodes: BacklinkNode[],
  target: { id: string; title: string },
): Array<{ id: string; title: string }> {
  const targetId = target.id.toLowerCase();
  const targetTitle = (target.title ?? "").toLowerCase();
  const targetSlug = bareSlug(target.id).toLowerCase();
  if (!targetTitle) return [];

  const out: Array<{ id: string; title: string }> = [];
  for (const node of nodes) {
    if (node.id.toLowerCase() === targetId) continue;
    const titleOnly = extractWikiLinkTargets(node.content ?? "").some((t) => {
      const lower = t.toLowerCase();
      const stableForm =
        lower === targetId || bareSlug(t).toLowerCase() === targetSlug;
      return !stableForm && lower === targetTitle;
    });
    if (titleOnly) out.push({ id: node.id, title: node.title });
  }
  return out;
}

/**
 * Nodes whose links to the target reference its OLD TITLE — either as the
 * link target (`[[Old Title]]`, which BREAKS on rename) or as the display
 * alias (`[[nodes/slug|Old Title]]`, whose label goes STALE — still resolves
 * but keeps showing the old name). Used to warn before a rename; covers the
 * common picker-inserted slug+alias form that titleFormBacklinks misses.
 */
export function renameImpactBacklinks(
  nodes: BacklinkNode[],
  target: { id: string; title: string },
): Array<{ id: string; title: string }> {
  const targetId = target.id.toLowerCase();
  const targetTitle = (target.title ?? "").toLowerCase();
  const targetSlug = bareSlug(target.id).toLowerCase();
  if (!targetTitle) return [];

  const re = new RegExp(wikiLinkRegex.source, "g");
  const out: Array<{ id: string; title: string }> = [];
  for (const node of nodes) {
    if (node.id.toLowerCase() === targetId) continue;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    let affected = false;
    while ((m = re.exec(node.content ?? "")) !== null) {
      const linkTarget = (m[1] ?? "").trim().toLowerCase();
      const alias = (m[2] ?? "").trim().toLowerCase();
      const pointsHere =
        linkTarget === targetId ||
        bareSlug(linkTarget).toLowerCase() === targetSlug ||
        linkTarget === targetTitle;
      if (!pointsHere) continue;
      // Title-form target breaks; slug/id target with old-title alias goes stale.
      if (linkTarget === targetTitle || alias === targetTitle) {
        affected = true;
        break;
      }
    }
    if (affected) out.push({ id: node.id, title: node.title });
  }
  return out;
}

/**
 * Outgoing links in THIS doc whose visible alias no longer matches the target
 * document's current title — `[[nodes/slug|Old Name]]` after the target was
 * renamed. The link still resolves (slug is stable); only the label is stale.
 * Used to warn, from the linking doc's side, that some link labels are
 * out of date. Unresolved targets are skipped (those are broken links, a
 * separate concern surfaced by link-health).
 */
export function staleAliasLinks(
  content: string,
  nodes: BacklinkNode[],
): Array<{ id: string; currentTitle: string; shownAs: string }> {
  const byId = new Map<string, BacklinkNode>();
  const bySlug = new Map<string, BacklinkNode>();
  const byTitle = new Map<string, BacklinkNode>();
  for (const n of nodes) {
    byId.set(n.id.toLowerCase(), n);
    bySlug.set(bareSlug(n.id).toLowerCase(), n);
    byTitle.set((n.title ?? "").toLowerCase(), n);
  }

  const re = new RegExp(wikiLinkRegex.source, "g");
  const out: Array<{ id: string; currentTitle: string; shownAs: string }> = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content ?? "")) !== null) {
    const targetRaw = (m[1] ?? "").trim();
    const alias = (m[2] ?? "").trim();
    if (!alias) continue; // no alias → nothing to go stale
    const lower = targetRaw.toLowerCase();
    const node =
      byId.get(lower) ||
      bySlug.get(bareSlug(targetRaw).toLowerCase()) ||
      byTitle.get(lower);
    if (!node) continue; // unresolved → broken link, not a stale label
    if (alias.toLowerCase() !== (node.title ?? "").toLowerCase()) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      out.push({ id: node.id, currentTitle: node.title, shownAs: alias });
    }
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

/** Delete-confirm warning for docs that link here; "" when none. */
export function inboundLinkWarning(count: number): string {
  if (count === 0) return "";
  return count === 1
    ? "1 document links to this — deleting it will break that link."
    : `${count} documents link to this — deleting it will break those links.`;
}
