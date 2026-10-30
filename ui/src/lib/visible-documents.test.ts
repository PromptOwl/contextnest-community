/**
 * The interaction lazy loading puts at risk: a filter is a question about the
 * whole nest, but documents arrive one folder level at a time.
 */
import { describe, it, expect } from "vitest";
import {
  visibleDocuments,
  hasActiveFilters,
  documentsTabIsEmpty,
} from "./visible-documents";

const doc = (id: string, over: Record<string, any> = {}) => ({
  id,
  title: id.split("/").pop(),
  status: "published",
  type: "document",
  tags: [],
  content: "",
  ...over,
});

// The root level is loaded; `gtm/deals` has never been expanded.
const LEVEL = [doc("nodes/root-one"), doc("nodes/root-two")];
const WHOLE = [
  ...LEVEL,
  doc("nodes/gtm/playbook", { tags: ["#gtm"] }),
  doc("nodes/gtm/deals/deal-one", { tags: ["#gtm"], status: "draft" }),
  doc("nodes/gtm/deals/deal-two", { content: "rocket" }),
];

const base = {
  levelNodes: LEVEL,
  fullNodes: null as any[] | null,
  folderFilter: null as string | null,
  search: "",
  status: "all",
  type: "all",
  author: "all",
  tags: [] as string[],
  contentHits: new Set<string>(),
};

const ids = (r: any[]) => r.map((n) => n.id).sort();

describe("visibleDocuments", () => {
  it("shows only the loaded levels when nothing is filtering", () => {
    // The whole point of lazy loading: unexpanded folders cost nothing and
    // show nothing.
    expect(ids(visibleDocuments(base))).toEqual(["nodes/root-one", "nodes/root-two"]);
  });

  it("grid view shows documents in folders nobody expanded", () => {
    // A flat grid has no folders to open: the loaded levels alone left an
    // imported nest (everything one folder down) looking empty.
    expect(ids(visibleDocuments({ ...base, gridNodes: WHOLE }))).toEqual(ids(WHOLE));
    expect(ids(visibleDocuments({ ...base, gridNodes: WHOLE, folderFilter: "gtm/deals" }))).toEqual([
      "nodes/gtm/deals/deal-one",
      "nodes/gtm/deals/deal-two",
    ]);
  });

  it("grid view falls back to the loaded levels until its read lands", () => {
    expect(ids(visibleDocuments({ ...base, gridNodes: null }))).toEqual(["nodes/root-one", "nodes/root-two"]);
  });

  it("searches the whole nest, not just what happens to be expanded", () => {
    // Without this, a document in a collapsed folder is silently unfindable —
    // the regression lazy loading most easily introduces.
    const hit = visibleDocuments({ ...base, fullNodes: WHOLE, search: "deal-one" });
    expect(ids(hit)).toEqual(["nodes/gtm/deals/deal-one"]);
  });

  it("honours a server-side content hit the client text match would miss", () => {
    const hit = visibleDocuments({
      ...base,
      fullNodes: WHOLE,
      search: "rocket",
      contentHits: new Set(["nodes/gtm/deals/deal-two"]),
    });
    expect(ids(hit)).toContain("nodes/gtm/deals/deal-two");
  });

  it("filters by tag and status across unexpanded folders", () => {
    expect(ids(visibleDocuments({ ...base, fullNodes: WHOLE, tags: ["#gtm"] }))).toEqual([
      "nodes/gtm/deals/deal-one",
      "nodes/gtm/playbook",
    ]);
    expect(ids(visibleDocuments({ ...base, fullNodes: WHOLE, status: "draft" }))).toEqual([
      "nodes/gtm/deals/deal-one",
    ]);
  });

  it("falls back to the loaded levels while the full listing is in flight", () => {
    // Incomplete, but never wrong about what it does show — and it must not
    // throw on the null.
    const during = visibleDocuments({ ...base, fullNodes: null, search: "root" });
    expect(ids(during)).toEqual(["nodes/root-one", "nodes/root-two"]);
  });

  it("keeps the folder scope while filtering the whole nest", () => {
    // Drilled into `gtm`: a match outside it stays out, a match in a nested
    // subfolder stays in.
    const scoped = visibleDocuments({
      ...base,
      fullNodes: WHOLE,
      folderFilter: "gtm",
      tags: ["#gtm"],
    });
    expect(ids(scoped)).toEqual(["nodes/gtm/deals/deal-one", "nodes/gtm/playbook"]);

    const rootScoped = visibleDocuments({
      ...base,
      fullNodes: WHOLE,
      folderFilter: "",
      search: "root",
    });
    expect(ids(rootScoped)).toEqual(["nodes/root-one", "nodes/root-two"]);
  });

  it("recognises every filter as active, and none as inactive", () => {
    const off = {
      search: "",
      status: "all",
      type: "all",
      author: "all",
      tags: [] as string[],
      datePreset: "any",
    };
    expect(hasActiveFilters(off)).toBe(false);
    expect(hasActiveFilters({ ...off, search: "x" })).toBe(true);
    expect(hasActiveFilters({ ...off, status: "draft" })).toBe(true);
    expect(hasActiveFilters({ ...off, type: "agent" })).toBe(true);
    expect(hasActiveFilters({ ...off, author: "a@b.test" })).toBe(true);
    expect(hasActiveFilters({ ...off, tags: ["#gtm"] })).toBe(true);
    expect(hasActiveFilters({ ...off, datePreset: "7d" })).toBe(true);
  });
});

describe("documentsTabIsEmpty", () => {
  it("is not empty when this level has no documents but folders exist", () => {
    // The regression: an imported nest keeps everything one level down, so the
    // root level is empty while the nest plainly is not.
    expect(
      documentsTabIsEmpty({ visibleCount: 0, folderCount: 4, filtering: false }),
    ).toBe(false);
  });

  it("is empty when there is nothing at all", () => {
    expect(
      documentsTabIsEmpty({ visibleCount: 0, folderCount: 0, filtering: false }),
    ).toBe(true);
  });

  it("is empty when a filter matched nothing, folders or not", () => {
    // Showing a folder tree under "no matching documents" would be noise.
    expect(
      documentsTabIsEmpty({ visibleCount: 0, folderCount: 4, filtering: true }),
    ).toBe(true);
  });

  it("is never empty while documents are visible", () => {
    expect(
      documentsTabIsEmpty({ visibleCount: 2, folderCount: 0, filtering: true }),
    ).toBe(false);
  });
});
