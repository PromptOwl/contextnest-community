import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import remarkStringify from "remark-stringify";
import { visit } from "unist-util-visit";
import { remarkMathNoCurrency } from "./markdown-math";

function mathNodes(md: string) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkMath)
    .use(remarkMathNoCurrency)
    .use(remarkStringify);
  const tree = processor.runSync(processor.parse(md), md as any);
  const found: string[] = [];
  visit(tree, (node: any) => {
    if (node.type === "inlineMath" || node.type === "math") found.push(node.value);
  });
  return found;
}

describe("remarkMathNoCurrency", () => {
  it("keeps real inline math", () => {
    expect(mathNodes("Inline $E=mc^2$ here.")).toEqual(["E=mc^2"]);
  });

  it("leaves currency amounts alone", () => {
    expect(mathNodes("Costs $5 and $10 today.")).toEqual([]);
  });

  it("keeps block math", () => {
    expect(mathNodes("$$\n\\int_0^1 x^2 dx\n$$")).toEqual(["\\int_0^1 x^2 dx"]);
  });
});
