/**
 * `@user@example.com` — the picker's insert format (server-side
 * src/shared/mentions.ts resolves the same three forms: full email, local
 * part, or a parenthesized display name). remark-gfm's email autolink
 * literal turns the domain half into a `mailto:` link during parsing,
 * leaving the mention's leading "@" as a separate text node right before
 * it, so without this plugin a saved mention renders as a bare "@" next to
 * a clickable link showing the full address. This merges that pair back
 * into one "@localpart" mention chip. `@(Name With Spaces)` never gets
 * autolinked, so it's rewritten straight from its text node.
 */
import type { Plugin } from "unified";
import type { Root, Text } from "mdast";
import { visit } from "unist-util-visit";

const MENTION_NAME_RE = /(?:^|\s)@\(([^)]+)\)/g;

const mentionNode = (label: string, email?: string) => ({
  type: "mention",
  data: {
    hName: "mention",
    hProperties: email ? { "data-mention-email": email } : {},
    hChildren: [{ type: "text", value: `@${label}` }],
  },
});

export const remarkMentions: Plugin<[], Root> = () => (tree) => {
  visit(tree, "link", (node: any, index, parent) => {
    if (!parent || index === null || index === undefined) return;
    if (typeof node.url !== "string" || !node.url.startsWith("mailto:")) {
      return;
    }
    const prev = parent.children[index - 1];
    if (!prev || prev.type !== "text" || !prev.value.endsWith("@")) return;

    const email = decodeURIComponent(node.url.slice("mailto:".length));
    const before = prev.value.slice(0, -1);
    const replacement = [
      ...(before ? [{ type: "text", value: before }] : []),
      mentionNode(email.split("@")[0], email),
    ];
    parent.children.splice(index - 1, 2, ...replacement);
    return index - 1 + replacement.length;
  });

  visit(tree, "text", (node: Text, index, parent) => {
    if (!parent || index === null || index === undefined) return;
    const text = node.value;
    MENTION_NAME_RE.lastIndex = 0;
    if (!MENTION_NAME_RE.test(text)) return;

    MENTION_NAME_RE.lastIndex = 0;
    const newChildren: any[] = [];
    let lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MENTION_NAME_RE.exec(text)) !== null) {
      const lead = /^\s/.test(m[0]) ? m[0][0] : "";
      const chunk = text.slice(lastIndex, m.index) + lead;
      if (chunk) newChildren.push({ type: "text", value: chunk });
      newChildren.push(mentionNode(m[1]));
      lastIndex = MENTION_NAME_RE.lastIndex;
    }
    if (lastIndex < text.length) {
      newChildren.push({ type: "text", value: text.slice(lastIndex) });
    }
    parent.children.splice(index, 1, ...newChildren);
    return index + newChildren.length;
  });
};
