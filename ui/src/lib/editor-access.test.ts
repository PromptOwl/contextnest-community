import { describe, it, expect } from "vitest";
import { resolveEditorAccess, type EditorAccessInput } from "./editor-access";

const base: EditorAccessInput = {
  isNew: false,
  isOwner: false,
  isAdmin: false,
  permission: "read",
  nestStewards: [],
  nodeRoles: [],
  grant: null,
};

const access = (over: Partial<EditorAccessInput> = {}) =>
  resolveEditorAccess({ ...base, ...over });

describe("resolveEditorAccess", () => {
  it("gives a read collaborator and a public reader the view-only surface", () => {
    const a = access();
    expect(a.isViewOnly).toBe(true);
    expect(a.canEditContent).toBe(false);
  });

  it("withholds authoring from a reviewer or viewer steward who can write the nest", () => {
    // The tag input, type picker and editor surface all hang off canEditContent:
    // a reviewer approves and comments here, they never author.
    for (const role of ["reviewer", "viewer"]) {
      const a = access({ permission: "write", nodeRoles: [role] });
      expect(a.isViewOnly).toBe(false); // still sees approve/comment affordances
      expect(a.isReviewerOnly).toBe(true);
      expect(a.canEditContent).toBe(false);
    }
  });

  it("keeps authoring open for a steward who is both editor and reviewer", () => {
    const a = access({ permission: "write", nodeRoles: ["editor", "reviewer"] });
    expect(a.isReviewerOnly).toBe(false);
    expect(a.canEditContent).toBe(true);
  });

  it("treats an admin steward row as above reviewer, not as reviewer-only", () => {
    const a = access({ nodeRoles: ["admin"] });
    expect(a.hasAdminApprove).toBe(true);
    expect(a.isReviewerOnly).toBe(false);
    expect(a.canEditContent).toBe(true);
  });

  it("lets a node-scoped editor steward edit a nest they only read", () => {
    // Stewardship resolves document → tag → nest, so this row is the whole
    // permission — nest-level access stays 'read'.
    const a = access({ nodeRoles: ["editor"] });
    expect(a.isViewOnly).toBe(false);
    expect(a.canEditContent).toBe(true);
  });

  it("separates a write share grant from a read one", () => {
    expect(access({ grant: "write" }).canEditContent).toBe(true);
    expect(access({ grant: "read" }).isViewOnly).toBe(true);
  });

  it("stays view-only until the nest permission has loaded", () => {
    // permission is null on first render; keying off permission === 'read'
    // flashed the authoring UI at people the server would 403.
    expect(access({ permission: null }).isViewOnly).toBe(true);
    expect(access({ permission: "none" }).isViewOnly).toBe(true);
    expect(access({ permission: null, isOwner: true }).isViewOnly).toBe(false);
  });

  it("gates a new document on nest-wide authoring, ignoring per-node rows", () => {
    // There is no node yet, so a node-scoped row cannot apply.
    expect(access({ isNew: true, nodeRoles: ["editor"] }).isViewOnly).toBe(true);
    expect(
      access({
        isNew: true,
        nestStewards: [{ role: "editor", scope: "nest" }],
      }).isViewOnly,
    ).toBe(false);
    expect(access({ isNew: true, permission: "write" }).canAuthorNew).toBe(true);
  });

  it("forces view-only on an archived nest regardless of role", () => {
    // Mirrors deriveNestCaps' early return in lib/nest-caps: an owner or
    // admin caretaker reopening an archived nest still can't save.
    expect(
      access({ isOwner: true, permission: "owner", isArchived: true }).isViewOnly,
    ).toBe(true);
    expect(
      access({ isAdmin: true, permission: "admin", isArchived: true }).isViewOnly,
    ).toBe(true);
    expect(
      access({
        isNew: true,
        permission: "write",
        isArchived: true,
      }).isViewOnly,
    ).toBe(true);
    expect(
      access({
        nodeRoles: ["editor", "reviewer"],
        permission: "write",
        isArchived: true,
      }).canEditContent,
    ).toBe(false);
  });
});
