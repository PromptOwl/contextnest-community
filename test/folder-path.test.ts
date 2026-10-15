/**
 * Folder-path checks shared by the New folder and Move dialogs: the path that
 * will actually be created, and what gets blocked before the round-trip.
 * Mirrors folderToSegments in src/nodes/service.ts.
 */
import { describe, it, expect } from "vitest";
import { checkFolderPath } from "../ui/src/lib/folder-path";
import { MAX_FOLDER_DEPTH } from "../ui/src/lib/constants";

describe("checkFolderPath", () => {
  it("normalizes stray and repeated slashes and segment whitespace", () => {
    expect(checkFolderPath("/ gtm // deals /")).toMatchObject({
      path: "gtm/deals",
      label: "Gtm / Deals",
      error: null,
    });
  });

  it("previews the name the tree will show, not the lowercase storage path", () => {
    // CU-wdqcq027ft: "A" is stored as "a" but shown as "A" everywhere else.
    expect(checkFolderPath("A")).toEqual({ path: "a", label: "A", error: null, rewritten: false });
    expect(checkFolderPath("UPPER Spaces")).toMatchObject({
      path: "upper-spaces",
      label: "Upper Spaces",
      rewritten: false,
    });
  });

  it("previews when slugifying changes more than case", () => {
    expect(checkFolderPath("Q3 Plans!")).toMatchObject({
      path: "q3-plans",
      label: "Q3 Plans",
      rewritten: true,
    });
    expect(checkFolderPath("my_folder")).toMatchObject({ label: "My Folder", rewritten: true });
  });

  it("leaves an already-canonical path alone", () => {
    expect(checkFolderPath("gtm/deals")).toEqual({
      path: "gtm/deals",
      label: "Gtm / Deals",
      error: null,
      rewritten: false,
    });
  });

  it("treats an empty path as the nest root, not an error", () => {
    expect(checkFolderPath("   ")).toEqual({ path: "", label: "", error: null, rewritten: false });
  });

  it("refuses reserved dot segments", () => {
    expect(checkFolderPath("../etc/passwd").error).toContain('".."');
    expect(checkFolderPath(".").error).toContain('"."');
  });

  it("rejects a path deeper than the ceiling", () => {
    const deep = Array.from({ length: MAX_FOLDER_DEPTH + 1 }, (_, i) => `l${i}`).join("/");
    expect(checkFolderPath(deep).error).toContain(`${MAX_FOLDER_DEPTH} levels deep`);
  });

  it("rejects a segment that slugifies away, and one that is too long", () => {
    expect(checkFolderPath("!!!").error).toContain("a-z and 0-9");
    expect(checkFolderPath("a".repeat(101)).error).toContain("100 characters");
  });
});
