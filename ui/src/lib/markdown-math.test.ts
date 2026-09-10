import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";
import rehypeKatex from "rehype-katex";
import remarkStringify from "remark-stringify";
import { visit } from "unist-util-visit";
import { remarkMathNoCurrency, unescapeMathSpans } from "./markdown-math";

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

describe("KaTeX rendering", () => {
  // A typo between dollars must not take the page down with it: the whole app
  // sits under one error boundary, so a throw here would unmount everything.
  async function classes(md: string) {
    const processor = unified()
      .use(remarkParse)
      .use(remarkMath)
      .use(remarkMathNoCurrency)
      .use(remarkRehype)
      .use(rehypeKatex);
    const tree: any = await processor.run(processor.parse(md), md as any);
    const found: string[] = [];
    visit(tree, (node: any) => {
      const cls = node.properties?.className;
      if (cls) found.push(...[].concat(cls));
    });
    return found;
  }

  it("renders valid math", async () => {
    expect(await classes("Inline $E=mc^2$")).toContain("katex");
  });

  it("marks malformed TeX instead of throwing", async () => {
    expect(await classes("Broken $\\frac{1}$ here")).toContain("katex-error");
  });
});

describe("unescapeMathSpans", () => {
  it("restores backslash commands the editor escaped", () => {
    expect(unescapeMathSpans("Inline $\\\\frac{1}{2}$.")).toBe(
      "Inline $\\frac{1}{2}$.",
    );
    expect(unescapeMathSpans("$$\\\\int\\_0^1 x^2 dx$$")).toBe(
      "$$\\int_0^1 x^2 dx$$",
    );
  });

  it("keeps an author's own LaTeX line break", () => {
    // `\\` in LaTeX is a line break; the serializer doubles it to `\\\\`.
    expect(unescapeMathSpans("$$a \\\\\\\\ b$$")).toBe("$$a \\\\ b$$");
  });

  it("leaves prose escapes and currency alone", () => {
    expect(unescapeMathSpans("A \\_literal\\_ underscore.")).toBe(
      "A \\_literal\\_ underscore.",
    );
    expect(unescapeMathSpans("costs $5 and $10")).toBe("costs $5 and $10");
  });

  it("leaves math that needs no unescaping untouched", () => {
    expect(unescapeMathSpans("$E=mc^2$")).toBe("$E=mc^2$");
  });
});
