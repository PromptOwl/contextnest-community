/**
 * `[[wikilinks]]` in a channel message (PO-1189). The server resolves each
 * link per viewer into a card (ArtifactCards shows them under the message);
 * here the link in the text itself becomes a link with the card's title.
 *
 * The rule that matters: a title is shown only when a card for that exact
 * link gave it. With no card the label is the id's last segment, and a link
 * the viewer may not open ("not available") stays text with no address.
 */
import type { ArtifactCard } from "./api";

export interface MessageWikilink {
  /** The link as written, brackets included. */
  raw: string;
  label: string;
  /** An in-app address from the card, when it gave one. */
  href: string | null;
  nestId: string | null;
  /** The node to open in the current nest when there is no address. */
  nodeId: string | null;
  /** False when the server said the viewer cannot open it. */
  available: boolean;
}

// A code span (fenced or inline, left as it is) or a wikilink. The target has
// no brackets or pipe; an alias may hold a single `]`.
const PART = /((?:```[\s\S]*?```)|(?:`[^`\n]*`))|\[\[([^[\]\n|]+)(?:\|((?:[^\]\n]|\](?!\]))*))?\]\]/g;

const lastSegment = (target: string) => target.replace(/\/+$/, "").split("/").pop() || target;
/** Looks like a node id ("nodes/launch-plan"), as opposed to a title. */
const isNodeId = (target: string) => /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(target);
/** Only an in-app document address the server built becomes a link. */
const safeDocPath = (url: string) => (/^\/nest\/[^/?#]+\?doc=/.test(url) ? url : null);

export function resolveWikilink(raw: string, cards: ArtifactCard[]): MessageWikilink {
  const inner = raw.slice(2, -2);
  const bar = inner.indexOf("|");
  const target = (bar === -1 ? inner : inner.slice(0, bar)).trim();
  const alias = bar === -1 ? "" : inner.slice(bar + 1).trim();
  const card = cards.find((c) => c.link === raw);
  if (card?.resolved) {
    return { raw, label: card.title, href: safeDocPath(card.url), nestId: card.nest_id, nodeId: card.node_id, available: true };
  }
  const label = alias || lastSegment(target);
  if (card) return { raw, label, href: null, nestId: null, nodeId: null, available: false };
  return { raw, label, href: null, nestId: null, nodeId: isNodeId(target) ? target : null, available: true };
}

/**
 * `text` with each wikilink as a `#wikilink-<i>` markdown link, numbered from
 * `from`, so the renderer can draw link i. Code spans are left untouched.
 */
export function linkWikilinks(text: string, cards: ArtifactCard[], from: number): { markdown: string; links: MessageWikilink[] } {
  const links: MessageWikilink[] = [];
  const markdown = text.replace(PART, (full, code) => {
    if (code) return full;
    const link = resolveWikilink(full, cards);
    links.push(link);
    return `[${link.label.replace(/[[\]\\]/g, "\\$&")}](#wikilink-${from + links.length - 1})`;
  });
  return { markdown, links };
}
