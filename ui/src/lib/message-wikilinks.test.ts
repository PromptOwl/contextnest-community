import { describe, expect, it } from "vitest";
import type { ArtifactCard } from "./api";
import { linkWikilinks, resolveWikilink } from "./message-wikilinks";

const card = (over: Partial<Extract<ArtifactCard, { resolved: true }>> = {}): ArtifactCard => ({
  link: "[[nodes/launch-plan]]",
  resolved: true,
  kind: "node",
  nest_id: "n1",
  node_id: "nodes/launch-plan",
  title: "Launch Plan",
  type: "document",
  stage: null,
  status: "published",
  version: 1,
  url: "/nest/n1?doc=nodes%2Flaunch-plan",
  ...over,
});

describe("wikilinks in a channel message (PO-1189)", () => {
  it("takes the title and address from the message's card for that link", () => {
    expect(resolveWikilink("[[nodes/launch-plan]]", [card()])).toEqual({
      raw: "[[nodes/launch-plan]]",
      label: "Launch Plan",
      href: "/nest/n1?doc=nodes%2Flaunch-plan",
      nestId: "n1",
      nodeId: "nodes/launch-plan",
      available: true,
    });
  });

  it("with no card, shows the id's last segment and links by id, never a title it was not given", () => {
    expect(resolveWikilink("[[nodes/plans/q4-roadmap]]", [])).toEqual({
      raw: "[[nodes/plans/q4-roadmap]]",
      label: "q4-roadmap",
      href: null,
      nestId: null,
      nodeId: "nodes/plans/q4-roadmap",
      available: true,
    });
    // A card for another link is not borrowed.
    expect(resolveWikilink("[[nodes/other]]", [card()]).label).toBe("other");
  });

  it("a link the reader cannot open shows as text, with no title and no address", () => {
    const r = resolveWikilink("[[nodes/secret-plan]]", [{ link: "[[nodes/secret-plan]]", resolved: false }]);
    expect(r).toMatchObject({ label: "secret-plan", href: null, nodeId: null, available: false });
  });

  it("a title-style link with no card stays text: there is no id to open", () => {
    expect(resolveWikilink("[[Launch Plan]]", [])).toMatchObject({ label: "Launch Plan", nodeId: null, href: null, available: true });
    // With its card it resolves like any other.
    expect(resolveWikilink("[[Launch Plan]]", [card({ link: "[[Launch Plan]]" })])).toMatchObject({ label: "Launch Plan", nodeId: "nodes/launch-plan" });
  });

  it("uses the alias the author wrote when there is no card title", () => {
    expect(resolveWikilink("[[nodes/launch-plan|the plan]]", []).label).toBe("the plan");
    expect(resolveWikilink("[[nodes/launch-plan|the plan]]", [card({ link: "[[nodes/launch-plan|the plan]]" })]).label).toBe("Launch Plan");
  });

  it("only follows an in-app document address from a card", () => {
    expect(resolveWikilink("[[nodes/launch-plan]]", [card({ url: "https://evil.example/x" })])).toMatchObject({ href: null, label: "Launch Plan", nodeId: "nodes/launch-plan" });
  });

  it("turns each wikilink in text into an indexed link, in order", () => {
    const out = linkWikilinks("see [[nodes/launch-plan]] and [[nodes/b]].", [card()], 0);
    expect(out.markdown).toBe("see [Launch Plan](#wikilink-0) and [b](#wikilink-1).");
    expect(out.links.map((l) => l.label)).toEqual(["Launch Plan", "b"]);
  });

  it("continues the numbering from the links before it and escapes brackets in a label", () => {
    const out = linkWikilinks("[[A [draft]]]", [], 3);
    expect(out.markdown).toBe("[[A [draft]]]");
    const ok = linkWikilinks("[[nodes/x|a [b] c]]", [], 3);
    expect(ok.markdown).toBe("[a \\[b\\] c](#wikilink-3)");
  });

  it("leaves a wikilink inside code alone", () => {
    const text = "use `[[nodes/launch-plan]]` or\n```\n[[nodes/launch-plan]]\n```\nthen [[nodes/launch-plan]]";
    const out = linkWikilinks(text, [card()], 0);
    expect(out.links).toHaveLength(1);
    expect(out.markdown).toBe("use `[[nodes/launch-plan]]` or\n```\n[[nodes/launch-plan]]\n```\nthen [Launch Plan](#wikilink-0)");
  });
});
