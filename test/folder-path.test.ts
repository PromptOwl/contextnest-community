/**
 * Folder-path checks shared by the New folder and Move dialogs: what gets
 * sent (normalized) and what gets blocked before the round-trip.
 */
import { describe, it, expect } from "vitest";
import { checkFolderPath } from "../ui/src/lib/folder-path";
import { MAX_FOLDER_DEPTH } from "../ui/src/lib/constants";

describe("checkFolderPath", () => {
  it("normalizes stray and repeated slashes and segment whitespace", () => {
    expect(checkFolderPath("/ gtm // deals /").path).toBe("gtm/deals");
    expect(checkFolderPath("/ gtm // deals /").error).toBeNull();
  });

  it("treats an empty path as the nest root, not an error", () => {
    expect(checkFolderPath("   ").path).toBe("");
    expect(checkFolderPath("   ").error).toBeNull();
  });

  it("rejects a path deeper than the ceiling", () => {
    const deep = Array.from({ length: MAX_FOLDER_DEPTH + 1 }, (_, i) => `l${i}`).join("/");
    expect(checkFolderPath(deep).error).toContain(`${MAX_FOLDER_DEPTH} levels deep`);
  });

  it("rejects a segment that would slugify away", () => {
    expect(checkFolderPath("gtm/!!!").error).toContain("a-z and 0-9");
    expect(checkFolderPath("gtm/deals-2").error).toBeNull();
  });
});
