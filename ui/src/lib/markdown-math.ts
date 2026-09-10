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

/**
 * The editor's markdown serializer escapes markdown's own specials in every
 * text node, so `\frac` leaves it as `\\frac` and `x_1` as `x\_1`. Inside
 * `$…$` that is not decoration: KaTeX reads `\\` as a line break and the
 * command name vanishes, rendering `\frac{1}{2}` as "frac12".
 *
 * Undo that escaping inside math spans only — LaTeX reaches KaTeX as typed
 * while ordinary prose keeps its escapes. Currency ("costs $5 and $10") is
 * skipped by the same no-surrounding-whitespace rule the renderer applies.
 */
const MATH_SPAN = /\$\$([\s\S]+?)\$\$|\$(?![\s$])([^\n$]*[^\s$])\$/g;
const MD_ESCAPE = /\\([`*\\~[\]_])/g;

export function unescapeMathSpans(md: string): string {
  return md.replace(MATH_SPAN, (whole, block?: string, inline?: string) => {
    const body = block ?? inline;
    if (body === undefined) return whole;
    const bare = body.replace(MD_ESCAPE, "$1");
    return block === undefined ? `$${bare}$` : `$$${bare}$$`;
  });
}
