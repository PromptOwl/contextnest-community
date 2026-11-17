import { describe, it, expect } from "vitest";
import { documentActions, type DocumentActionsInput } from "./document-actions";

// The header ⋮ menu on a document page. One builder feeds BOTH the markdown
// editor and the artifact viewer, so the two surfaces can't drift apart again
// (CU-wdqcq02gy8: artifacts had no Share / Publish / Copy link at all).

const owner: DocumentActionsInput = {
  isNew: false,
  canShare: true,
  isArchived: false,
  canEditContent: true,
  isLocked: false,
  canRequestDeletion: true,
  canDeleteDirectly: true,
  deletionRequested: false,
  isOwnDeletionRequest: false,
};

const keys = (input: DocumentActionsInput) => documentActions(input).map((a) => a.key);

describe("documentActions — the document-page ⋮ menu", () => {
  it("regression: a markdown document keeps its full owner menu, in order", () => {
    expect(keys(owner)).toEqual([
      "history",
      "copy-link",
      "move",
      "share-doc",
      "publish",
      "delete",
    ]);
  });

  it("parity: an HTML artifact gets the same sharing actions as markdown", () => {
    // The artifact viewer already carries its own History button.
    const artifact = keys({ ...owner, includeVersionHistory: false });
    expect(artifact).toEqual(keys(owner).filter((k) => k !== "history"));
    expect(artifact).toEqual(
      expect.arrayContaining(["copy-link", "share-doc", "publish", "move", "delete"]),
    );
  });

  it("a viewer-only reader gets Copy link and nothing that writes or shares", () => {
    const viewer = keys({
      ...owner,
      canShare: false,
      canEditContent: false,
      canRequestDeletion: false,
      canDeleteDirectly: false,
    });
    expect(viewer).toEqual(["history", "copy-link"]);
  });

  it("an editor (not owner/admin) can move and ask for deletion, not share or publish", () => {
    const editor = keys({ ...owner, canShare: false, canDeleteDirectly: false });
    expect(editor).toEqual(["history", "copy-link", "move", "request-deletion"]);
  });

  it("a document locked in review can't be moved", () => {
    expect(keys({ ...owner, isLocked: true })).not.toContain("move");
  });

  it("offers Archive to a steward only, and not while a review holds the document", () => {
    expect(keys(owner)).not.toContain("archive");
    expect(keys({ ...owner, canArchive: true })).toContain("archive");
    expect(keys({ ...owner, canArchive: true, isLocked: true })).not.toContain("archive");
    expect(keys({ ...owner, canArchive: true, isNew: true })).not.toContain("archive");
  });

  it("an unsaved document has no node to act on — empty menu", () => {
    expect(keys({ ...owner, isNew: true })).toEqual([]);
  });

  it("an archived nest withholds sharing and publishing", () => {
    const archived = keys({ ...owner, isArchived: true });
    expect(archived).not.toContain("share-doc");
    expect(archived).not.toContain("publish");
    expect(archived).toContain("copy-link");
  });

  it("the requester of a pending deletion sees Withdraw instead of a second request", () => {
    const requester = keys({
      ...owner,
      canShare: false,
      canDeleteDirectly: false,
      deletionRequested: true,
      isOwnDeletionRequest: true,
    });
    expect(requester).not.toContain("request-deletion");
    expect(requester).toContain("withdraw-deletion");
  });

  it("an admin still sees Delete while someone else's request is pending", () => {
    const admin = keys({ ...owner, deletionRequested: true });
    expect(admin).toContain("delete");
    expect(admin).not.toContain("withdraw-deletion");
  });

  it("every action carries a stable test id and label", () => {
    for (const a of documentActions(owner)) {
      expect(a.testId).toMatch(/^document-editor-/);
      expect(a.label.length).toBeGreaterThan(0);
    }
    // Withdraw and Delete open the destructive group: whichever comes first
    // carries the separator so the group is never glued to the sharing items.
    const withdrawOnly = documentActions({
      ...owner,
      canShare: false,
      canDeleteDirectly: false,
      deletionRequested: true,
      isOwnDeletionRequest: true,
    });
    expect(withdrawOnly.find((a) => a.key === "withdraw-deletion")?.separatorBefore).toBe(true);
    expect(documentActions(owner).find((a) => a.key === "delete")?.separatorBefore).toBe(true);
  });
});


describe("documentActions — admin Activity log (CU-wdqcq03aw2)", () => {
  it("offers Activity to owners and nest admins, right after Version history", () => {
    const k = keys({ ...owner, canSeeActivity: true });
    expect(k.slice(0, 2)).toEqual(["history", "activity"]);
    expect(documentActions({ ...owner, canSeeActivity: true }).find((a) => a.key === "activity")).toEqual(
      expect.objectContaining({ label: "Activity", testId: "document-editor-activity" }),
    );
  });

  it("never offers it to anyone else, or on an unsaved document", () => {
    expect(keys({ ...owner, canSeeActivity: false })).not.toContain("activity");
    expect(keys(owner)).not.toContain("activity");
    expect(keys({ ...owner, isNew: true, canSeeActivity: true })).not.toContain("activity");
  });
});
