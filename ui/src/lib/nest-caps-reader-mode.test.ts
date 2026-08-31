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
  deriveNestCaps,
  isReaderHiddenView,
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

describe("reader mode hides the board/graph/definitions shell tabs", () => {
  it("READER_HIDDEN_VIEWS names exactly board, ontology-graph, definitions", () => {
    expect([...READER_HIDDEN_VIEWS].sort()).toEqual(
      ["board", "definitions", "ontology-graph"].sort(),
    );
  });

  it("isReaderHiddenView excludes board/ontology-graph/definitions", () => {
    expect(isReaderHiddenView("board")).toBe(true);
    expect(isReaderHiddenView("ontology-graph")).toBe(true);
    expect(isReaderHiddenView("definitions")).toBe(true);
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
    ];
    const readerVisible = NEST_VIEWS.filter((p) => !isReaderHiddenView(p));
    expect(readerVisible).toEqual(["nest", "workflows"]);
  });
});
