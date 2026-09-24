/**
 * Wiki-link click resolution — pure, framework-free (see wiki-preview.ts).
 *
 * CU-wdqcq02g17: clicking a `[[Title]]` that points nowhere used to dead-end
 * on a "document not found" page instead of offering to create it. The
 * click handlers (DocumentEditor, NestView review modal) used to special-case
 * a cached `id` from the WikiLink decoration and navigate straight to it,
 * skipping resolution entirely — if that id had gone stale (the target
 * renamed or deleted since the decoration last checked), navigation 404'd
 * with no create offer. `decideWikiLinkAction` is the fix: it never takes an
 * id, only ever consults the live node list, so a broken link always falls
 * through to "create" (permissions allowing) instead of a dead end.
 */
import { describe, it, expect } from "vitest";
import { decideWikiLinkAction, resolveWikiTarget, wikiLinkIsBroken } from "./wiki-preview";

const nodes = [
  { id: "nodes/roadmap", title: "Roadmap" },
  { id: "nodes/meeting-notes", title: "Meeting Notes" },
];

describe("decideWikiLinkAction", () => {
  it("navigates when the target resolves to an existing node", () => {
    const action = decideWikiLinkAction(nodes, "Roadmap", true);
    expect(action).toEqual({ kind: "navigate", node: nodes[0] });
  });

  it("offers to create a broken link for an author", () => {
    const action = decideWikiLinkAction(nodes, "Launch Plan", true);
    expect(action).toEqual({ kind: "create", title: "Launch Plan" });
  });

  it("blocks create for a non-authoring role instead of offering it", () => {
    const action = decideWikiLinkAction(nodes, "Launch Plan", false);
    expect(action).toEqual({ kind: "blocked", title: "Launch Plan" });
  });

  it("never dead-ends: a target missing from the live list is always create/blocked, never a bare miss", () => {
    // Simulates the stale-cache scenario: a decoration once cached this
    // target as existing (with some id), but the target is gone from the
    // current node list (deleted/renamed since). Because this function takes
    // no id, it has nothing stale to trust — it always re-resolves fresh.
    const action = decideWikiLinkAction([], "Meeting Notes", true);
    expect(action.kind).toBe("create");
  });
});

describe("resolveWikiTarget (existing behavior, unchanged)", () => {
  it("matches by exact title, case-insensitive", () => {
    expect(resolveWikiTarget(nodes, "meeting notes")?.id).toBe("nodes/meeting-notes");
  });
  it("returns null for no match", () => {
    expect(resolveWikiTarget(nodes, "nope")).toBeNull();
  });
});

describe("wikiLinkIsBroken", () => {
  const previewFor = (target: string) => {
    const node = resolveWikiTarget(nodes, target);
    return node ? { title: node.title, snippet: "" } : null;
  };

  it("is not broken when the target resolves", () => {
    expect(wikiLinkIsBroken("Roadmap", previewFor)).toBe(false);
  });

  it("is broken when the target doesn't resolve", () => {
    expect(wikiLinkIsBroken("Deleted Doc", previewFor)).toBe(true);
  });

  it("stays optimistic (not broken) when there's no previewFor to resolve against", () => {
    expect(wikiLinkIsBroken("Anything", undefined)).toBe(false);
  });
});
