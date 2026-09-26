import { describe, it, expect } from "vitest";
import { findBacklinks, inboundLinkWarning } from "./backlinks";

describe("inboundLinkWarning (delete confirm)", () => {
  it("says nothing when no document links here", () => {
    expect(inboundLinkWarning(0)).toBe("");
  });
  it("names one link, and several", () => {
    expect(inboundLinkWarning(1)).toBe(
      " 1 document links to this — deleting it will break that link.",
    );
    expect(inboundLinkWarning(3)).toBe(
      " 3 documents link to this — deleting it will break those links.",
    );
  });
  it("counts a [[slug|Title]] link from another doc as inbound", () => {
    const nodes = [
      { id: "nodes/doc-a", title: "Doc A", content: "" },
      { id: "nodes/doc-b", title: "Doc B", content: "See [[doc-a|A]]." },
    ];
    const n = findBacklinks(nodes, { id: "nodes/doc-a", title: "Doc A" }).length;
    expect(inboundLinkWarning(n)).toMatch(/^ 1 document links to this/);
  });
});
