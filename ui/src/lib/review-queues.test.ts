import { describe, expect, it } from "vitest";
import { crumbFolders, splitDrafts, upToDateReviews } from "./review-queues";
import { reviewActivity } from "./review-activity";

const draft = (id: string, status: "draft" | "rejected") => ({ node_id: id, status }) as any;
const item = (id: string, over = {}) => ({ type: "review", node_id: id, ...over }) as any;

describe("review queues", () => {
  it("puts sent-back drafts in their own queue", () => {
    const s = splitDrafts([draft("a", "draft"), draft("b", "rejected")]);
    expect(s.drafts.map((d) => d.node_id)).toEqual(["a"]);
    expect(s.sentBack.map((d) => d.node_id)).toEqual(["b"]);
  });
  it("leaves stale reviews and requests out of select-all", () => {
    const rows = [item("a", { up_to_date: true }), item("b", { up_to_date: false }), item("c"), item("d", { type: "deletion" })];
    expect(upToDateReviews(rows).map((w) => w.node_id)).toEqual(["a", "c"]);
  });
  it("shows the folders of a document", () => {
    expect(crumbFolders("nodes/ontology/core/service-line")).toEqual(["ontology", "core"]);
    expect(crumbFolders("nodes/x")).toEqual([]);
  });
});

describe("review activity", () => {
  it("is newest first and names each decision", () => {
    const ev = reviewActivity(
      [
        { version: 1, editedBy: "a@x", resolvedBy: "r@x", resolutionStatus: "approved" },
        { version: 2, editedBy: "a@x", resolvedBy: "r@x", resolutionStatus: "rejected", resolutionKind: "changes", resolutionNote: "why" },
        { version: 3, editedBy: "a@x" },
      ],
      { by: "a@x", at: "2026-01-01", note: "n" },
    );
    expect(ev.map((e) => e.text)).toEqual([
      "submitted for review", "saved v3", "requested changes on v2", "saved v2", "approved v1", "started this document",
    ]);
  });
});
