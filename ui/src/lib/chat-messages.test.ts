/** AC-C3-12 (PO-1200): the C1 message rules — reactions, edit and delete rights, tombstones, excerpts, @channel. */
import { describe, expect, it } from "vitest";
import { broadcastNotice, canDelete, canEdit, excerptPieces, messageIdOf, patchMessage, reactionTitle, reactionToggle, tombstoneLine } from "./chat-messages";

describe("AC-C3-12 reactions", () => {
  it("my reaction comes off, anyone else's goes on", () => {
    expect(reactionToggle([{ emoji: "👍", count: 2, me: true, by: ["A", "B"] }], "👍")).toBe("remove");
    expect(reactionToggle([{ emoji: "👍", count: 2, me: false, by: ["A", "B"] }], "👍")).toBe("add");
    expect(reactionToggle(undefined, "👍")).toBe("add");
  });
  it("names the first ten and counts the rest", () => {
    expect(reactionTitle({ emoji: "👍", count: 2, by: ["Rita", "Walt"] })).toBe("Rita, Walt reacted with 👍");
    expect(reactionTitle({ emoji: "👍", count: 12, by: ["Rita"] })).toBe("Rita and 11 more reacted with 👍");
  });
});

describe("AC-C3-12 edit and delete rights", () => {
  const mine = { author: "Me@x", deleted: false };
  const theirs = { author: "a@x", deleted: false };
  it("edit is the author's only, never a tombstone", () => {
    expect(canEdit(mine, "me@x")).toBe(true);
    expect(canEdit(theirs, "me@x")).toBe(false);
    expect(canEdit({ ...mine, deleted: true }, "me@x")).toBe(false);
    expect(canEdit(mine, null)).toBe(false);
  });
  it("delete is the author's, or an owner's or admin's for anyone", () => {
    expect(canDelete(theirs, "me@x", "write")).toBe(false);
    expect(canDelete(theirs, "me@x", "owner")).toBe(true);
    expect(canDelete(theirs, "me@x", "admin")).toBe(true);
    expect(canDelete(mine, "me@x", "read")).toBe(true);
    expect(canDelete({ ...theirs, deleted: true }, "me@x", "owner")).toBe(false);
  });
  it("tombstones say who removed the message", () => {
    expect(tombstoneLine({ deleted_by: "author" })).toBe("This message was deleted.");
    expect(tombstoneLine({ deleted_by: "moderator" })).toBe("This message was removed by a moderator.");
  });
  it("patches one message in place and addresses a post by its opening message", () => {
    expect(patchMessage([{ id: "a", body: "x" }, { id: "b", body: "y" }], "b", { body: "z" })).toEqual([{ id: "a", body: "x" }, { id: "b", body: "z" }]);
    expect(messageIdOf({ id: "t1", message_id: "m1" } as never)).toBe("m1");
    expect(messageIdOf({ id: "r1" } as never)).toBe("r1");
  });
});

describe("AC-C3-12 search excerpts", () => {
  it("merges overlapping highlights and keeps the text whole", () => {
    const pieces = excerptPieces("quokka plan ships", [{ start: 7, end: 11 }, { start: 0, end: 6 }, { start: 9, end: 12 }]);
    expect(pieces).toEqual([
      { text: "quokka", hit: true },
      { text: " ", hit: false },
      { text: "plan ", hit: true },
      { text: "ships", hit: false },
    ]);
    expect(pieces.map((p) => p.text).join("")).toBe("quokka plan ships");
    expect(excerptPieces("plain", [])).toEqual([{ text: "plain", hit: false }]);
  });
});

describe("AC-C3-12 @channel", () => {
  it("says how many people a broadcast reached", () => {
    expect(broadcastNotice([{ name: "channel", kind: "everyone", reached: 4 }])).toBe("Reached 4 people");
    expect(broadcastNotice([{ name: "here", kind: "everyone", reached: 1 }])).toBe("Reached 1 person");
    expect(broadcastNotice([{ name: "rita", kind: "nobody" }])).toBeNull();
    expect(broadcastNotice(undefined)).toBeNull();
  });
});
