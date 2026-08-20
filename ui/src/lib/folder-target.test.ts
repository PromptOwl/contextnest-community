import { describe, it, expect } from "vitest";
import { folderGrantTarget } from "./folder-target";

// A folder grant is matched by node-id prefix. Getting this wrong is silent:
// the share is created, the roster shows the person, and they can reach
// nothing — which is exactly the bug this function exists to prevent.
describe("folderGrantTarget", () => {
  it("puts back the nodes/ root the folder path had stripped", () => {
    expect(folderGrantTarget("campaigns", "nodes/campaigns/q3-plan")).toBe(
      "nodes/campaigns",
    );
  });

  it("handles a nested folder", () => {
    expect(folderGrantTarget("gtm/deals", "nodes/gtm/deals/acme")).toBe(
      "nodes/gtm/deals",
    );
  });

  it("leaves an id-prefixed path alone (imported nests carry the nest id)", () => {
    const id = "b006e456-15de-458b-82db-f06fd4f37f51/nodes/campaigns/q3-plan";
    const path = "b006e456-15de-458b-82db-f06fd4f37f51/nodes/campaigns";
    expect(folderGrantTarget(path, id)).toBe(path);
  });

  it("falls back to the conventional root for an empty folder", () => {
    expect(folderGrantTarget("campaigns", null)).toBe("nodes/campaigns");
    expect(folderGrantTarget("nodes/campaigns", null)).toBe("nodes/campaigns");
  });

  it("never returns a bare folder name for a normal nest", () => {
    // The original bug: "campaigns" matches no node id, so the grant covers
    // nothing. Whatever else changes, the result must be a usable prefix.
    const target = folderGrantTarget("campaigns", "nodes/campaigns/doc");
    expect(target.startsWith("nodes/")).toBe(true);
    expect("nodes/campaigns/doc".startsWith(`${target}/`)).toBe(true);
  });
});
