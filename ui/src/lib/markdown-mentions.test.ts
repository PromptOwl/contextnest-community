import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { visit } from "unist-util-visit";
import { remarkMentions } from "./markdown-mentions";

function mentionNodes(md: string) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMentions)
    .use(remarkStringify);
  const tree = processor.runSync(processor.parse(md), md as any);
  const found: Array<{ label: string; email?: string }> = [];
  visit(tree, (node: any) => {
    if (node.type !== "mention") return;
    found.push({
      label: node.data.hChildren[0].value.replace(/^@/, ""),
      email: node.data.hProperties?.["data-mention-email"],
    });
  });
  return found;
}

describe("remarkMentions", () => {
  it("merges the picker's @ + mailto link into a single @localpart chip", () => {
    expect(mentionNodes("Hey @hiren@promptowl.ai take a look")).toEqual([
      { label: "hiren", email: "hiren@promptowl.ai" },
    ]);
  });

  it("rewrites the parenthesized display-name form without a link", () => {
    expect(mentionNodes("cc @(Hiren F)")).toEqual([
      { label: "Hiren F", email: undefined },
    ]);
  });

  it("handles a mention at the very start of the text", () => {
    expect(mentionNodes("@hiren@promptowl.ai please review")).toEqual([
      { label: "hiren", email: "hiren@promptowl.ai" },
    ]);
  });

  it("leaves a plain email autolink alone — no leading @ to merge", () => {
    expect(mentionNodes("contact me at foo@bar.com")).toEqual([]);
  });

  it("supports more than one mention in the same line", () => {
    expect(mentionNodes("@a@example.com and @(Bea) both saw this")).toEqual([
      { label: "a", email: "a@example.com" },
      { label: "Bea", email: undefined },
    ]);
  });
});
