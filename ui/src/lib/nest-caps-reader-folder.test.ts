/**
 * Reader Mode's default-folder pick.
 *
 * Reader Mode has no tab strip to trigger a folder fetch, so NestView eagerly
 * fetches the first top-level folder alongside root — otherwise a nest whose
 * docs all live one level down (the common docs-site shape) renders empty
 * until a folder row is clicked (ReaderView.onExpandFolder).
 */
import { describe, it, expect } from "vitest";
import { firstTopLevelFolder } from "./nest-caps";

describe("firstTopLevelFolder", () => {
  it("returns undefined when there are no known folders", () => {
    expect(firstTopLevelFolder([])).toBeUndefined();
  });

  it("picks the first folder with no '/' in its path", () => {
    const known = [
      { path: "eng/api", total: 3 },
      { path: "gtm", total: 2 },
    ];
    expect(firstTopLevelFolder(known)).toEqual({ path: "gtm", total: 2 });
  });

  it("skips nested folders entirely when every folder is nested", () => {
    // A root-level doc census with no top-level folder — Reader Mode has
    // nothing extra to eagerly fetch, root alone must suffice.
    const known = [{ path: "docs/guides/intro", total: 1 }];
    expect(firstTopLevelFolder(known)).toBeUndefined();
  });

  it("keeps the caller's ordering — first match wins, not alphabetical", () => {
    const known = [
      { path: "zeta", total: 1 },
      { path: "alpha", total: 1 },
    ];
    expect(firstTopLevelFolder(known)?.path).toBe("zeta");
  });
});
