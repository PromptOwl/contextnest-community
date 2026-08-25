/**
 * serializeNodeSafe: every write of a node that came back from readDocument
 * goes through it. gray-matter's YAML dumper throws "unacceptable kind of an
 * object to dump [object Undefined]" on undefined values, which made move fail
 * for drafts and pending-review docs. Engine 2.0.0 strips them itself; this
 * stays as the version-independent guarantee.
 */
import { describe, it, expect } from "vitest";
import { serializeNodeSafe } from "../src/governance/safe-publish.js";

const node = (frontmatter: any) =>
  ({ id: "nodes/x", filePath: "", body: "# X", rawContent: "", frontmatter }) as any;

describe("serializeNodeSafe", () => {
  it("serializes frontmatter with undefined values instead of throwing", () => {
    const fm = {
      title: "X",
      status: "draft",
      tags: undefined,
      metadata: { owners: ["*"], schedule: undefined },
    };
    const out = serializeNodeSafe(node(fm));
    expect(out).toContain("title: X");
    expect(out).toContain("owners:");
    expect(out).not.toContain("tags:");
    expect(out).not.toContain("schedule:");
  });
});
