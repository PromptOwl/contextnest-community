import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactCards, mayHaveCards } from "./ArtifactCards";

// Agent team stream S3 (PO-1181): a card shows what the server resolved for the
// viewer, as text; an unresolved link shows only the link the message carries.
describe("artifact cards (AC-ST-01, UI)", () => {
  it("renders a resolved card with title, type, stage and version, linking in-app", () => {
    const html = renderToStaticMarkup(
      <ArtifactCards
        cards={[
          {
            link: "[[nodes/plan]]",
            resolved: true,
            kind: "node",
            nest_id: "n1",
            node_id: "nodes/plan",
            title: "Launch <b>Plan</b>",
            type: "task",
            stage: "in-review",
            status: "published",
            version: 3,
            url: "/nest/n1?doc=nodes%2Fplan",
          },
        ]}
      />,
    );
    expect(html).toContain('href="/nest/n1?doc=nodes%2Fplan"');
    expect(html).toContain("Launch &lt;b&gt;Plan&lt;/b&gt;");
    expect(html).toContain("task · in-review · v3");
  });

  it("an unresolved link shows the link text only, no title and no href", () => {
    const html = renderToStaticMarkup(<ArtifactCards cards={[{ link: "[[nodes/secret]]", resolved: false }]} />);
    expect(html).toContain("[[nodes/secret]]");
    expect(html).toContain("not available");
    expect(html).not.toContain("href");
  });

  it("never links a URL the server didn't build as an in-app path", () => {
    const html = renderToStaticMarkup(
      <ArtifactCards
        cards={[
          {
            link: "x",
            resolved: true,
            kind: "node",
            nest_id: "n1",
            node_id: "nodes/x",
            title: "X",
            type: "document",
            stage: null,
            status: "draft",
            version: null,
            url: "javascript:alert(1)",
          },
        ]}
      />,
    );
    expect(html).not.toContain("javascript:");
  });

  it("pre-checks bodies that may hold card links", () => {
    expect(mayHaveCards("see [[nodes/x]]")).toBe(true);
    expect(mayHaveCards("https://h.example/nest/abc?doc=nodes%2Fx")).toBe(true);
    expect(mayHaveCards("plain text")).toBe(false);
  });
});
