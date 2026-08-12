/**
 * serializeNodeSafe: every write of a node that came back from readDocument
 * goes through it. gray-matter's YAML dumper throws
 * "unacceptable kind of an object to dump [object Undefined]" on undefined
 * values — which is what made move fail for drafts and pending-review docs
 * while published ones (already cleaned by safePublishDocument) moved fine.
 *
 * The engine now strips undefined frontmatter itself, top-level and nested, so
 * this is belt-and-braces rather than the only thing standing between a draft
 * and a failed move. It stays because the invariant is ours to hold: every
 * write is clean regardless of which engine version is installed. Asserting
 * that the raw engine still throws would just pin us to the old one.
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
