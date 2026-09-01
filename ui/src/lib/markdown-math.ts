/**
 * remark-math is greedy with single dollars: "costs $5 and $10" parses the
 * span between them as math. GitHub's rule is that inline math may not start
 * or end with whitespace — apply it here and put the offenders back as the
 * literal source text they came from.
 */
import type { Plugin } from "unified";
import type { Root } from "mdast";
import { visit } from "unist-util-visit";

export const remarkMathNoCurrency: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file);
  visit(tree, "inlineMath", (node: any) => {
    if (!/^\s|\s$/.test(node.value ?? "")) return;
    const { start, end } = node.position ?? {};
    node.type = "text";
    node.value =
      start && end ? source.slice(start.offset, end.offset) : `$${node.value}$`;
  });
};
