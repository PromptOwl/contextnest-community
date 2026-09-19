/**
 * Archived-nest read-only enforcement in nest-caps.
 *
 * isArchived is a hard early return in deriveNestCaps — true regardless of
 * role, so an owner/admin caretaker reopening an archived nest to consider
 * restoring it still can't write. isNestArchived is the single place that
 * reads the fact off a fetched nest (`archived_at`), so board/definitions/
 * document-editor/nest-view all agree on it without re-threading a boolean
 * through every navigation call site.
 */
import { describe, it, expect } from "vitest";
import { deriveNestCaps, isNestArchived } from "./nest-caps";

describe("isNestArchived", () => {
  it("is true when archived_at is set", () => {
    expect(isNestArchived({ archived_at: "2026-01-01T00:00:00Z" })).toBe(true);
  });

  it("is false when archived_at is null, undefined, or the nest itself is missing", () => {
    expect(isNestArchived({ archived_at: null })).toBe(false);
    expect(isNestArchived({})).toBe(false);
    expect(isNestArchived(null)).toBe(false);
    expect(isNestArchived(undefined)).toBe(false);
  });
});

describe("deriveNestCaps — archived nest", () => {
  it("stays read-only for an owner", () => {
    const caps = deriveNestCaps({
      roles: ["owner"],
      permission: "owner",
      myStewards: [],
      isOwner: true,
      isAdmin: false,
      isArchived: true,
    });
    expect(caps.isReadOnly).toBe(true);
    expect(caps.canEditDocs).toBe(false);
    expect(caps.canManage).toBe(false);
  });

  it("stays read-only for a server admin", () => {
    const caps = deriveNestCaps({
      roles: [],
      permission: "admin",
      myStewards: [],
      isOwner: false,
      isAdmin: true,
      isArchived: true,
    });
    expect(caps.isReadOnly).toBe(true);
    expect(caps.canEditDocs).toBe(false);
    expect(caps.canManage).toBe(false);
  });

  it("stays read-only for a nest-scope editor steward", () => {
    const caps = deriveNestCaps({
      roles: [],
      permission: "write",
      myStewards: [{ role: "editor", scope: "nest" }],
      isOwner: false,
      isAdmin: false,
      isArchived: true,
    });
    expect(caps.isReadOnly).toBe(true);
    expect(caps.canEditDocs).toBe(false);
  });

  it("does not force read-only when isArchived is false/undefined", () => {
    const caps = deriveNestCaps({
      roles: ["owner"],
      permission: "owner",
      myStewards: [],
      isOwner: true,
      isAdmin: false,
      isArchived: false,
    });
    expect(caps.isReadOnly).toBe(false);
    expect(caps.canEditDocs).toBe(true);
  });
});
