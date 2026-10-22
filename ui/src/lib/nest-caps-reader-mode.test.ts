/**
 * Public Docs Reader Mode derivation in nest-caps.
 *
 * isReaderView is true ONLY when the nest has reader mode on AND the caller is
 * read-only — owners, editors, reviewers and admins keep the full authoring UI.
 * The shell also hides the board / ontology-graph / definitions tabs in reader
 * mode (isReaderHiddenView), which the nest-view switcher filters on.
 */
import { describe, it, expect } from "vitest";
import {
  conventionKey,
  deriveNestCaps,
  isReaderHiddenView,
  isViewBlockedInReaderMode,
  pickHomeNode,
  READER_HIDDEN_VIEWS,
} from "./nest-caps";

const readOnly = {
  roles: [] as string[],
  permission: "read",
  myStewards: [],
  isOwner: false,
  isAdmin: false,
};

describe("deriveNestCaps — reader mode", () => {
  it("isReaderView is false when reader mode is off, even for a read-only caller", () => {
    const caps = deriveNestCaps({ ...readOnly, readerMode: false });
    expect(caps.isReadOnly).toBe(true);
    expect(caps.isReaderView).toBe(false);
  });

  it("isReaderView is true when reader mode is on AND the caller is read-only", () => {
    const caps = deriveNestCaps({ ...readOnly, readerMode: true });
    expect(caps.isReadOnly).toBe(true);
    expect(caps.isReaderView).toBe(true);
  });

  it("isReaderView is false for an owner even when reader mode is on", () => {
    const caps = deriveNestCaps({
      roles: ["owner"],
      permission: "owner",
      myStewards: [],
      isOwner: true,
      isAdmin: false,
      readerMode: true,
    });
    expect(caps.isReadOnly).toBe(false);
    expect(caps.isReaderView).toBe(false);
  });

  // "Preview as reader" (CU-wdqcq027fw): an owner opts into the visitor
  // presentation without giving up any right — and only while reader mode is
  // actually on, or the preview would show a view no visitor gets.
  it("previewReader shows an owner the reader view while keeping their rights", () => {
    const owner = { roles: ["owner"], permission: "owner", myStewards: [], isOwner: true, isAdmin: false };
    const caps = deriveNestCaps({ ...owner, readerMode: true, previewReader: true });
    expect(caps.isReaderView).toBe(true);
    expect(caps.canManage).toBe(true);
    expect(caps.isReadOnly).toBe(false);
    expect(deriveNestCaps({ ...owner, readerMode: false, previewReader: true }).isReaderView).toBe(false);
  });

  it("isReaderView is false for a write collaborator even when reader mode is on", () => {
    const caps = deriveNestCaps({
      roles: [],
      permission: "write",
      myStewards: [],
      isOwner: false,
      isAdmin: false,
      readerMode: true,
    });
    expect(caps.isReaderView).toBe(false);
  });

  it("isReaderView is false for an admin even when reader mode is on", () => {
    const caps = deriveNestCaps({
      roles: [],
      permission: "read",
      myStewards: [],
      isOwner: false,
      isAdmin: true,
      readerMode: true,
    });
    expect(caps.isReaderView).toBe(false);
  });
});

describe("reader mode hides the board/graph/definitions/structure shell tabs", () => {
  it("READER_HIDDEN_VIEWS names exactly board, ontology-graph, definitions, structure", () => {
    expect([...READER_HIDDEN_VIEWS].sort()).toEqual(
      ["board", "definitions", "ontology-graph", "structure"].sort(),
    );
  });

  it("isReaderHiddenView excludes board/ontology-graph/definitions", () => {
    expect(isReaderHiddenView("board")).toBe(true);
    expect(isReaderHiddenView("ontology-graph")).toBe(true);
    expect(isReaderHiddenView("definitions")).toBe(true);
    expect(isReaderHiddenView("structure")).toBe(true);
  });

  it("isReaderHiddenView keeps the nest + workflows tabs visible", () => {
    expect(isReaderHiddenView("nest")).toBe(false);
    expect(isReaderHiddenView("workflows")).toBe(false);
  });

  it("filtering the nest-view pages in reader mode drops the three authoring tabs", () => {
    const NEST_VIEWS = [
      "nest",
      "board",
      "ontology-graph",
      "definitions",
      "workflows",
      "structure",
    ];
    const readerVisible = NEST_VIEWS.filter((p) => !isReaderHiddenView(p));
    expect(readerVisible).toEqual(["nest", "workflows"]);
  });
});

/**
 * Regression: hiding the tab BUTTONS is not enough — board / ontology-graph /
 * definitions are top-level view.page states rendered independently, so a
 * read-only caller deep-linking `?nest=<id>&view=board|graph|definitions` on a
 * reader-mode nest must NOT enter those pages. `isViewBlockedInReaderMode` is
 * the single source of truth used by the deep-link probe, the redirect effect,
 * and the render conditionals. This models the probe's page resolution.
 */
describe("reader mode blocks deep links into the hidden pages", () => {
  // Mirror of App.tsx's deep-link probe decision: a blocked sub-page falls back
  // to the "nest" page, exactly as the probe (and the redirect effect) do.
  const resolveDeepLinkPage = (subPage: string, readerMode: boolean) =>
    isViewBlockedInReaderMode(subPage, readerMode) ? "nest" : subPage;

  it("isViewBlockedInReaderMode is true for the hidden pages only when reader mode is on", () => {
    for (const page of ["board", "ontology-graph", "definitions"]) {
      expect(isViewBlockedInReaderMode(page, true)).toBe(true);
      expect(isViewBlockedInReaderMode(page, false)).toBe(false);
      expect(isViewBlockedInReaderMode(page, undefined)).toBe(false);
    }
  });

  it("does NOT block non-hidden nest-scoped pages", () => {
    expect(isViewBlockedInReaderMode("workflows", true)).toBe(false);
    expect(isViewBlockedInReaderMode("nest-trace", true)).toBe(false);
    expect(isViewBlockedInReaderMode("nest", true)).toBe(false);
  });

  it("a reader deep-linking into board/graph/definitions redirects to the nest page", () => {
    expect(resolveDeepLinkPage("board", true)).toBe("nest");
    expect(resolveDeepLinkPage("ontology-graph", true)).toBe("nest");
    expect(resolveDeepLinkPage("definitions", true)).toBe("nest");
  });

  it("a non-reader (owner/editor/admin) still reaches those pages by deep link", () => {
    expect(resolveDeepLinkPage("board", false)).toBe("board");
    expect(resolveDeepLinkPage("ontology-graph", false)).toBe("ontology-graph");
    expect(resolveDeepLinkPage("definitions", false)).toBe("definitions");
  });

  it("a reader deep link into a still-allowed page (workflows) is not redirected", () => {
    expect(resolveDeepLinkPage("workflows", true)).toBe("workflows");
  });

  it("the render guard blocks the hidden page for a reader and allows it otherwise", () => {
    // Render conditionals use !isViewBlockedInReaderMode(view.page, readerMode).
    const renders = (page: string, readerMode: boolean) =>
      !isViewBlockedInReaderMode(page, readerMode);
    expect(renders("board", true)).toBe(false);
    expect(renders("ontology-graph", true)).toBe(false);
    expect(renders("definitions", true)).toBe(false);
    expect(renders("board", false)).toBe(true);
  });
});

describe("reader-mode home node matching", () => {
  const node = { id: "nodes/welcome", title: "Welcome" };

  it("matches the full node id", () => {
    expect(pickHomeNode([node], "nodes/welcome")).toBe(node);
  });

  it("matches the bare slug people actually type, case-insensitively", () => {
    // The config field is hand-typed; "welcome" must find nodes/welcome, or the
    // designation silently loses to the naming convention.
    expect(pickHomeNode([node], "welcome")).toBe(node);
    expect(pickHomeNode([node], "Welcome")).toBe(node);
    expect(pickHomeNode([{ id: "nodes/guides/intro" }], "intro")?.id).toBe("nodes/guides/intro");
  });

  it("rejects a node that is not the home node", () => {
    expect(pickHomeNode([node], "index")).toBeUndefined();
    expect(pickHomeNode([{ id: "nodes/welcome-guide" }], "welcome")).toBeUndefined();
  });

  it("keys a node by id leaf and title for the convention fallback", () => {
    expect(conventionKey(node)).toEqual(["welcome", "welcome"]);
    expect(conventionKey({ id: "nodes/a/README", title: "Read Me" })).toEqual([
      "readme",
      "read me",
    ]);
  });
});
