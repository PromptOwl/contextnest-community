import { describe, it, expect } from "vitest";
import { pendingInviteNestIds } from "./pending-invites";

describe("pendingInviteNestIds", () => {
  it("keeps only nests with an unread nest_invite", () => {
    const ids = pendingInviteNestIds([
      { kind: "nest_invite", nest_id: "a" },
      { kind: "nest_invite", nest_id: "a" },
      { kind: "comment_mention", nest_id: "b" },
      { kind: "nest_invite", nest_id: "c" },
    ]);
    expect([...ids].sort()).toEqual(["a", "c"]);
  });

  it("is empty before notifications load", () => {
    expect(pendingInviteNestIds(undefined).size).toBe(0);
  });
});
