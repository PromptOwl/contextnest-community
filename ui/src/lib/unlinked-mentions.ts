/**
 * Link discovery — "unlinked mentions". Pure, framework-free so it's
 * unit-testable in the node test env. Finds docs that name the target in plain
 * prose but never `[[link]]` to it, surfacing links worth creating.
 *
 * A mention counts only when the target title appears as a whole word OUTSIDE
 * any existing wiki link, and the doc does not already link the target by id,
 * title, or bare slug. Body text is matched case-insensitively.
 */

import { extractWikiLinkTargets } from "./backlinks";

export interface MentionNode {
  id: string;
  title: string;
  content?: string;
}

function bareSlug(idOrTarget: string): string {
  const idx = idOrTarget.lastIndexOf("/");
  return idx >= 0 ? idOrTarget.slice(idx + 1) : idOrTarget;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Body with every `[[wiki link]]` removed, so mentions inside links don't count. */
function stripWikiLinks(content: string): string {
  return (content ?? "").replace(/\[\[[^\]]*\]\]/g, " ");
}

/**
 * Docs (other than the target) that mention `target.title` as plain text but
 * don't already link it. Empty when the title is blank — there's nothing to
 * match on.
 */
export function unlinkedMentions(
  target: { id: string; title: string },
  nodes: MentionNode[],
): Array<{ id: string; title: string }> {
  const targetId = target.id.toLowerCase();
  const targetTitle = (target.title ?? "").trim();
  if (!targetTitle) return [];

  const titleLower = targetTitle.toLowerCase();
  const targetSlug = bareSlug(target.id).toLowerCase();
  const mention = new RegExp(`\\b${escapeRegExp(titleLower)}\\b`);

  const alreadyLinks = (content: string): boolean =>
    extractWikiLinkTargets(content).some((t) => {
      const lower = t.toLowerCase();
      return (
        lower === targetId ||
        lower === titleLower ||
        bareSlug(t).toLowerCase() === targetSlug
      );
    });

  const out: Array<{ id: string; title: string }> = [];
  for (const node of nodes) {
    if (node.id.toLowerCase() === targetId) continue;
    const content = node.content ?? "";
    if (alreadyLinks(content)) continue;
    if (mention.test(stripWikiLinks(content).toLowerCase())) {
      out.push({ id: node.id, title: node.title });
    }
  }
  return out;
}
