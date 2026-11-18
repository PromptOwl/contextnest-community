import { describe, it, expect } from "vitest";
import { ribbonItems, ribbonTarget } from "./header-ribbon";

const counts = { work: 18, drafts: 40 };
const keys = (items: ReturnType<typeof ribbonItems>) => items.map((i) => i.key);

describe("ribbonItems", () => {
  it("shows My Work and My Drafts everywhere, with the rail's counts", () => {
    const items = ribbonItems({ view: { page: "dashboard", tab: "nests" }, counts });
    expect(keys(items)).toEqual(["my-work", "my-drafts"]);
    expect(items.map((i) => i.count)).toEqual([18, 40]);
  });

  // The point of the ribbon: someone inside a nest still sees the other nests'
  // queues, without leaving the nest they are working in.
  it("keeps My Work and My Drafts when a nest is open", () => {
    const items = ribbonItems({ view: { page: "nest", nestId: "n1", tab: "review" }, counts });
    expect(keys(items)).toEqual(["my-work", "my-drafts"]);
  });

  it("shows the same items on every screen, and never Browse", () => {
    const want = ["my-work", "my-drafts"];
    for (const view of [{ page: "dashboard" }, { page: "docs" }, { page: "document", nestId: "n1" }]) {
      expect(keys(ribbonItems({ view, counts }))).toEqual(want);
    }
    expect(keys(ribbonItems({ view: { page: "dashboard" }, counts }))).not.toContain("browse");
  });

  it("marks only the screen you are on", () => {
    const active = (view: Parameters<typeof ribbonItems>[0]["view"]) =>
      ribbonItems({ view, counts }).filter((i) => i.active).map((i) => i.key);
    expect(active({ page: "dashboard", tab: "my-work" })).toEqual(["my-work"]);
    expect(active({ page: "dashboard", tab: "my-drafts" })).toEqual(["my-drafts"]);
    expect(active({ page: "nest", nestId: "n1", tab: "documents" })).toEqual([]);
    expect(active({ page: "nest", nestId: "n1", tab: "instructions" })).toEqual([]);
  });

  it("shows nothing in public reader mode", () => {
    expect(ribbonItems({ view: { page: "nest", nestId: "n1", readerMode: true }, counts })).toEqual([]);
  });
});

describe("ribbonTarget", () => {
  it("sends each item to its own screen", () => {
    expect(ribbonTarget("my-work")).toEqual({ page: "dashboard", tab: "my-work" });
    expect(ribbonTarget("my-drafts")).toEqual({ page: "dashboard", tab: "my-drafts" });
  });

  it("carries the urgent count on My Work only", () => {
    const items = ribbonItems({
      view: { page: "dashboard", tab: "my-drafts" },
      counts: { work: 18, drafts: 40, urgent: 3 },
    });
    expect(items.find((i) => i.key === "my-work")?.urgent).toBe(3);
    expect(items.find((i) => i.key === "my-drafts")?.urgent ?? 0).toBe(0);
  });
});
