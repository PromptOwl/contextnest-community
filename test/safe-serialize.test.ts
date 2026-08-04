/**
 * serializeNodeSafe: every write of a node that came back from readDocument
 * goes through it. gray-matter's YAML dumper throws
 * "unacceptable kind of an object to dump [object Undefined]" on undefined
 * values — nested ones on any engine, top-level ones on engines before 1.2.1.
 * That is what made move fail for drafts and pending-review docs while
 * published ones (already cleaned by safePublishDocument) moved fine.
 */
import { describe, it, expect } from "vitest";
import { serializeDocument } from "@promptowl/contextnest-engine";
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
    // Guard rail: raw engine serialization is what blows up on the nested one.
    expect(() => serializeDocument(node(fm))).toThrow(/unacceptable kind/);

    const out = serializeNodeSafe(node(fm));
    expect(out).toContain("title: X");
    expect(out).toContain("owners:");
    expect(out).not.toContain("tags:");
    expect(out).not.toContain("schedule:");
  });
});
