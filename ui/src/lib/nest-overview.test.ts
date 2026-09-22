/**
 * Nest Overview — the pure logic behind the nest's landing page: how the
 * loaded documents group into the folder index, and what the one-line
 * summary under "Contents" says (the stat cards it replaces).
 */
import { describe, it, expect } from "vitest";
import { groupNodesByFolder, overviewFacts } from "./nest-overview";

describe("groupNodesByFolder (the Overview / reader index)", () => {
  const nodes = [
    { id: "nodes/welcome", title: "Welcome" },
    { id: "nodes/policies/security", title: "Security Policy" },
    { id: "nodes/policies/expenses", title: "Expense Policy" },
    { id: "nodes/guides/engineering/deploy", title: "Deploying" },
    { id: "nodes/guides/start", title: "Getting Started" },
    { id: "nodes/guides-archive/old", title: "Old" },
    { id: "nodes/untitled" },
  ];

  it("groups by the FULL folder path, with docs directly under nodes/ in Root", () => {
    const groups = groupNodesByFolder(nodes);
    expect(groups.map((g) => g.folder)).toEqual([
      "Root",
      "guides",
      "guides/engineering",
      "guides-archive",
      "policies",
    ]);
  });

  it("puts Root first and sorts the rest segment by segment, so children sit under their parent", () => {
    const folders = groupNodesByFolder(nodes).map((g) => g.folder);
    // "guides/engineering" before "guides-archive": a plain string sort would
    // put "-" (0x2d) before "/" (0x2f) and split guides from its child.
    expect(folders.indexOf("guides/engineering")).toBe(folders.indexOf("guides") + 1);
  });

  it("depth is 0 for Root and the segment count otherwise", () => {
    const byFolder = Object.fromEntries(groupNodesByFolder(nodes).map((g) => [g.folder, g.depth]));
    expect(byFolder).toMatchObject({ Root: 0, guides: 1, "guides/engineering": 2, policies: 1 });
  });

  it("orders documents within a folder by title, falling back to the id", () => {
    const root = groupNodesByFolder(nodes).find((g) => g.folder === "Root")!;
    expect(root.items.map((n) => n.id)).toEqual(["nodes/untitled", "nodes/welcome"]);
    const policies = groupNodesByFolder(nodes).find((g) => g.folder === "policies")!;
    expect(policies.items.map((n) => n.title)).toEqual(["Expense Policy", "Security Policy"]);
  });

  it("does not mutate the caller's list and handles an empty nest", () => {
    const copy = [...nodes];
    groupNodesByFolder(nodes);
    expect(nodes).toEqual(copy);
    expect(groupNodesByFolder([])).toEqual([]);
  });

  it("ids without the nodes/ root still group by their folder", () => {
    expect(groupNodesByFolder([{ id: "a/b/c" }]).map((g) => g.folder)).toEqual(["a/b"]);
  });
});

describe("overviewFacts (the summary line that replaces the stat cards)", () => {
  it("an ungoverned nest: documents, folders, edits this week — pluralised", () => {
    expect(overviewFacts({ total: 9, folderCount: 5, editedThisWeek: 3 }).map((f) => f.text)).toEqual([
      "9 documents",
      "5 folders",
      "3 edited this week",
    ]);
    expect(overviewFacts({ total: 1, folderCount: 1, editedThisWeek: 1 }).map((f) => f.text)).toEqual([
      "1 document",
      "1 folder",
      "1 edited this week",
    ]);
  });

  it("drops zero folders / zero edits rather than printing a row of zeros, but always states the document count", () => {
    expect(overviewFacts({ total: 0, folderCount: 0, editedThisWeek: 0 }).map((f) => f.text)).toEqual(["0 documents"]);
  });

  it("a governed nest adds AI-ready and pending counts with the reader's status tones", () => {
    const facts = overviewFacts({
      total: 5,
      folderCount: 2,
      editedThisWeek: 0,
      governance: { pending: 2, approved: 3, reviewable: 0 },
    });
    expect(facts.map((f) => [f.text, f.tone ?? null])).toEqual([
      ["5 documents", null],
      ["2 folders", null],
      ["3 AI ready", "ok"],
      ["2 pending review", "warn"],
    ]);
  });

  it("the caller's own review queue is an action, shown only when there is something to review", () => {
    const none = overviewFacts({ total: 5, folderCount: 0, editedThisWeek: 0, governance: { pending: 0, approved: 5, reviewable: 0 } });
    expect(none.find((f) => f.action === "review")).toBeUndefined();
    // Zero pending is not news on a governed nest either.
    expect(none.map((f) => f.text)).toEqual(["5 documents", "5 AI ready"]);
    const some = overviewFacts({ total: 5, folderCount: 0, editedThisWeek: 0, governance: { pending: 2, approved: 3, reviewable: 1 } });
    expect(some[some.length - 1]).toMatchObject({ text: "1 waiting on your review", action: "review" });
  });

  it("no green dot on zero: a governed nest with nothing approved yet must not look healthy", () => {
    const facts = overviewFacts({ total: 5, folderCount: 0, editedThisWeek: 0, governance: { pending: 0, approved: 0, reviewable: 0 } });
    expect(facts.find((f) => f.key === "ai-ready")).toMatchObject({ text: "0 AI ready" });
    expect(facts.find((f) => f.key === "ai-ready")?.tone).toBeUndefined();
  });

  it("every fact has a stable, unique key", () => {
    const facts = overviewFacts({ total: 5, folderCount: 2, editedThisWeek: 1, governance: { pending: 2, approved: 3, reviewable: 1 } });
    expect(new Set(facts.map((f) => f.key)).size).toBe(facts.length);
  });
});
