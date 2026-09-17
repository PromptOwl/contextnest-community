/**
 * `contextnest://` URIs in a body render as wiki links to the document they
 * name; non-document URIs stay text.
 */
import { describe, it, expect } from "vitest";
import { CONTEXT_URI_RE, contextUriDocPath, contextUriLabel } from "./context-uri";

describe("contextUriDocPath", () => {
  it("returns the node path of a document URI", () => {
    expect(contextUriDocPath("contextnest://nodes/competitive/messaging-analysis")).toBe("nodes/competitive/messaging-analysis");
    expect(contextUriDocPath("contextnest://nodes/sales-playbook")).toBe("nodes/sales-playbook");
  });
  it("drops a checkpoint pin, an anchor, and trailing prose punctuation", () => {
    expect(contextUriDocPath("contextnest://nodes/a/b@3")).toBe("nodes/a/b");
    expect(contextUriDocPath("contextnest://nodes/a/b#summary")).toBe("nodes/a/b");
    expect(contextUriDocPath("contextnest://nodes/a/b.")).toBe("nodes/a/b");
  });
  it("is null for tag, search, folder and malformed URIs", () => {
    expect(contextUriDocPath("contextnest://tag/gtm")).toBeNull();
    expect(contextUriDocPath("contextnest://search/pricing")).toBeNull();
    expect(contextUriDocPath("contextnest://nodes/gtm/")).toBeNull();
    expect(contextUriDocPath("contextnest://")).toBeNull();
    expect(contextUriDocPath("contextnest://nodes//x")).toBeNull();
    expect(contextUriDocPath("https://example.com")).toBeNull();
  });
});

describe("CONTEXT_URI_RE", () => {
  it("finds every bare URI in a line and stops at whitespace or brackets", () => {
    const line = "see contextnest://nodes/a and (contextnest://nodes/b/c) or contextnest://nodes/d.";
    expect(line.match(CONTEXT_URI_RE)).toEqual([
      "contextnest://nodes/a",
      "contextnest://nodes/b/c",
      "contextnest://nodes/d.",
    ]);
  });
});

describe("contextUriLabel", () => {
  it("shows the slug", () => {
    expect(contextUriLabel("nodes/strategy/messaging-architecture")).toBe("messaging-architecture");
  });
});
