/**
 * Nest Overview — the pure logic behind the nest's landing page: how the
 * loaded documents group into the folder index, and what the one-line
 * summary under "Contents" says (the stat cards it replaces).
 */
import { describe, it, expect } from "vitest";
import { capFolderDocs, emptyStateActions, folderCollapsed, groupNodesByFolder, overviewFacts, queueBreakdown } from "./nest-overview";

describe("queueBreakdown (why pending reviews aren't yours to approve)", () => {
  it("names your own submission instead of 'outside your scope' (CU-wdqcq02t1r)", () => {
    expect(queueBreakdown({ pending: 1, reviewable: 0, ownBlocked: 1 })).toBe(
      "1 you submitted — someone else must approve it",
    );
    expect(queueBreakdown({ pending: 3, reviewable: 0, ownBlocked: 2 })).toBe(
      "2 you submitted — someone else must approve them · 1 assigned to other reviewers",
    );
  });
  it("says nothing when every pending review is yours to act on", () => {
    expect(queueBreakdown({ pending: 2, reviewable: 2, ownBlocked: 0 })).toBeNull();
    expect(queueBreakdown({ pending: 0, reviewable: 0, ownBlocked: 0 })).toBeNull();
  });
  it("counts the rest as other reviewers' work", () => {
    expect(queueBreakdown({ pending: 4, reviewable: 1, ownBlocked: 0 })).toBe("3 assigned to other reviewers");
  });
});

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

  it("the pending count opens the review queue too (CU-wdqcq04wnu)", () => {
    const facts = overviewFacts({ total: 5, folderCount: 0, editedThisWeek: 0, governance: { pending: 2, approved: 3, reviewable: 0 } });
    expect(facts.find((f) => f.key === "pending")).toMatchObject({ text: "2 pending review", tone: "warn", action: "review" });
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

describe("emptyStateActions (who gets which start action on an empty nest)", () => {
  it("an editor gets all three, New document first", () => {
    expect(emptyStateActions({ canWrite: true, canImport: true, canAddWithAI: true })).toEqual(["new", "import", "ai"]);
  });
  it("Add with AI follows the header's own gate — a non-editor who sees it in the header sees it here too", () => {
    expect(emptyStateActions({ canWrite: false, canImport: false, canAddWithAI: true })).toEqual(["ai"]);
  });
  it("import only where the Import menu exists", () => {
    expect(emptyStateActions({ canWrite: true, canImport: false, canAddWithAI: false })).toEqual(["new"]);
  });
  it("a read-only caller gets none (the page says 'No documents yet')", () => {
    expect(emptyStateActions({ canWrite: false, canImport: true, canAddWithAI: false })).toEqual([]);
  });
});

describe("folderCollapsed (the index tree and the reader nav)", () => {
  it("starts closed, even for a folder whose documents are already loaded", () => {
    expect(folderCollapsed("guides", new Map())).toBe(true);
  });
  it("a click wins either way", () => {
    expect(folderCollapsed("guides", new Map([["guides", false]]))).toBe(false);
    expect(folderCollapsed("guides", new Map([["guides", true]]))).toBe(true);
  });
});

describe("capFolderDocs (first few documents per folder, then 'View all')", () => {
  const docs = (n: number, folder: string) => Array.from({ length: n }, (_, i) => ({ id: `nodes/${folder}/d${i}`, title: `D${i}` }));
  const groups = [
    { folder: "Root", depth: 0, items: docs(7, "x").map((d, i) => ({ ...d, id: `nodes/r${i}` })) },
    { folder: "guides", depth: 1, items: docs(7, "guides") },
    { folder: "policies", depth: 1, items: docs(2, "policies") },
  ];
  it("caps a folder at max and appends one 'more' marker with the hidden count", () => {
    const g = capFolderDocs(groups, 5).find((x) => x.folder === "guides")!;
    expect(g.items).toHaveLength(6);
    expect(g.items.slice(0, 5).map((d: any) => d.title)).toEqual(["D0", "D1", "D2", "D3", "D4"]);
    expect(g.items[5]).toMatchObject({ more: { folder: "guides", hidden: 2, total: 7 } });
  });
  it("leaves a short folder alone", () => {
    expect(capFolderDocs(groups, 5).find((x) => x.folder === "policies")!.items).toHaveLength(2);
  });
  it("never caps the loose root documents — they are the top of the index", () => {
    expect(capFolderDocs(groups, 5).find((x) => x.folder === "Root")!.items).toHaveLength(7);
  });
  it("does not mutate the input groups", () => {
    capFolderDocs(groups, 5);
    expect(groups[1].items).toHaveLength(7);
  });
});
