import { describe, it, expect } from "vitest";
import {
  DEFAULT_NEST_TAB,
  NEST_TABS,
  NEST_TAB_LABELS,
  nestTabFromParam,
  nestTabOpening,
  nestViewMenuItems,
} from "./nest-tabs";

describe("NestView tab slugs", () => {
  it("gives every whitelisted tab a breadcrumb label", () => {
    for (const t of NEST_TABS) expect(NEST_TAB_LABELS[t]).toBeTruthy();
  });

  it("accepts ?tab=stream and labels it Stream (the experimental doc stream tab)", () => {
    expect(nestTabFromParam("stream")).toBe("stream");
    expect(NEST_TAB_LABELS.stream).toBe("Stream");
  });

  it("keeps ?tab=instructions (the nest Instructions tab)", () => {
    expect(nestTabFromParam("instructions")).toBe("instructions");
    expect(NEST_TAB_LABELS.instructions).toBe("Instructions");
  });

  it("sends old ?tab=fields links to Settings, and keeps ?tab=activity", () => {
    expect(nestTabFromParam("fields")).toBe("settings");
    expect(nestTabFromParam("activity")).toBe("activity");
  });

  it("drops an unknown ?tab=", () => {
    expect(nestTabFromParam("nope")).toBeUndefined();
    expect(nestTabFromParam(null)).toBeUndefined();
  });
});

// po-1213: Documents is the nest's one home.
describe("AC-NH-01: no Overview tab", () => {
  it("Given an old ?tab=overview link, then it opens Documents", () => {
    expect(nestTabFromParam("overview")).toBe("documents");
  });

  it("Given the tab whitelist, then Overview is not a tab and Documents is the default", () => {
    expect(NEST_TABS).not.toContain("overview");
    expect(DEFAULT_NEST_TAB).toBe("documents");
  });

  it("Given ?tab=fields, then it opens Settings, where Fields live (the ⋯ menu also opens them)", () => {
    expect(nestTabFromParam("fields")).toBe("settings");
  });
});

describe("AC-NH-01/06: a change to the fields tab opens the Fields dialog over Documents", () => {
  it("Given ?tab=fields, then Documents is the tab and the Fields dialog is open", () => {
    expect(nestTabOpening("fields")).toEqual({ tab: "documents", fieldsOpen: true });
  });

  it("Given any other tab, or none, then it opens as itself and Fields stays closed", () => {
    expect(nestTabOpening("review")).toEqual({ tab: "review", fieldsOpen: false });
    expect(nestTabOpening(undefined)).toEqual({ tab: "documents", fieldsOpen: false });
  });
});

describe("AC-NH-06: the view items in the nest header's ⋯ menu", () => {
  const base = {
    activeTab: "documents",
    viewMode: "list" as "list" | "cards",
    grantOnly: false,
    canManageReaderMode: true,
    nestArchived: false,
    initialLoad: false,
    readerModeEnabled: false,
  };
  const ids = (o: Partial<typeof base>) => nestViewMenuItems({ ...base, ...o }).map((i) => i.testId);

  it("Given an owner on Documents in list view, then grid switch, Fields and Reader mode, in that order", () => {
    expect(nestViewMenuItems(base).map((i) => i.label)).toEqual(["Show as grid", "Fields", "Reader mode: Off"]);
    expect(ids({})).toEqual(["nest-view-grid", "nest-open-fields", "nest-reader-mode"]);
  });

  it("Given grid view, then the switch offers the list", () => {
    expect(nestViewMenuItems({ ...base, viewMode: "cards" })[0]).toMatchObject({ key: "list", label: "Show as list", testId: "nest-view-list" });
  });

  it("Given reader mode is on, then the item says so", () => {
    expect(nestViewMenuItems({ ...base, readerModeEnabled: true }).find((i) => i.key === "reader")?.label).toBe("Reader mode: On");
  });

  it("Given another tab, then there is no grid/list switch (it only lays out Documents)", () => {
    expect(ids({ activeTab: "review" })).toEqual(["nest-open-fields", "nest-reader-mode"]);
  });

  it("Given a share-grant-only viewer, then no Fields", () => {
    expect(ids({ grantOnly: true })).not.toContain("nest-open-fields");
  });

  it("Given someone who can't manage reader mode, an archived nest, or the first load, then no Reader mode", () => {
    expect(ids({ canManageReaderMode: false })).not.toContain("nest-reader-mode");
    expect(ids({ nestArchived: true })).not.toContain("nest-reader-mode");
    expect(ids({ initialLoad: true })).not.toContain("nest-reader-mode");
  });
});
