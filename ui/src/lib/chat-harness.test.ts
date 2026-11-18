/** AC-C3-13…C3-18 (PO-1200): the C2 screens' rules — who sees chat, what a
 *  conversation offers, direct messages, the members panel, the channel
 *  menu, notification levels, the first-run explainer. */
import { describe, expect, it } from "vitest";
import type { ChatMember, ConversationView } from "./api";
import {
  INTRO_KEY,
  channelMenu,
  chatOn,
  dmPeer,
  introSeen,
  markIntroSeen,
  memberRows,
  memberSpec,
  messageFeatures,
  orderConversations,
} from "./chat-harness";

const conv = (over: Partial<ConversationView> = {}): ConversationView => ({
  id: "nodes/conversations/abc",
  type: "conversation",
  kind: "dm",
  title: "Walt Writer",
  members: [
    { kind: "person", email: "me@x", name: "Me", added_at: "" },
    { kind: "person", email: "walt@x", name: "Walt Writer", added_at: "" },
  ],
  created_by: "me@x",
  created_at: "",
  post_count: 0,
  last_post_at: null,
  last_activity_at: null,
  unread: 0,
  can_post: true,
  post_refusal: null,
  ...over,
});

describe("AC-C3-13 who sees chat: the nest's own answer", () => {
  it("is the nest's `chat` flag when the server sends one", () => {
    expect(chatOn({ chat: true, member: true }, true)).toBe(true);
    // The nest's owner turned chat off: members see nothing.
    expect(chatOn({ chat: false, member: true }, true)).toBe(false);
  });
  it("falls back to switch and membership for an older server", () => {
    expect(chatOn({ member: true }, true)).toBe(true);
    expect(chatOn({ member: true }, false)).toBe(false);
    expect(chatOn({ member: false }, true)).toBe(false);
    expect(chatOn(undefined, true)).toBe(false);
  });
});

describe("AC-C3-14 a conversation offers what its API serves", () => {
  it("channels carry the C1 message actions; conversations do not (the server answers 404 there)", () => {
    expect(messageFeatures({ conversation: undefined })).toEqual({ messageActions: true, pins: true, broadcast: true });
    expect(messageFeatures({ conversation: conv() })).toEqual({ messageActions: false, pins: false, broadcast: false });
    expect(messageFeatures(null)).toEqual({ messageActions: false, pins: false, broadcast: false });
  });
});

describe("AC-C3-15 direct messages", () => {
  it("a dm's peer is the other member; a group has none", () => {
    expect(dmPeer(conv(), "ME@x")).toEqual({ kind: "person", email: "walt@x", name: "Walt Writer", added_at: "" });
    expect(dmPeer(conv({ members: [{ kind: "person", email: "me@x", name: "Me", added_at: "" }, { kind: "agent", handle: "scout", added_at: "" }] }), "me@x")).toEqual({ kind: "agent", handle: "scout", added_at: "" });
    expect(dmPeer(conv({ kind: "group" }), "me@x")).toBeNull();
  });
  it("orders by latest activity, unread first among ties, then title", () => {
    const a = conv({ id: "nodes/conversations/a", title: "Ann", last_activity_at: "2026-11-01 10:00:00" });
    const b = conv({ id: "nodes/conversations/b", title: "Bo", last_activity_at: "2026-11-02 10:00:00" });
    const c = conv({ id: "nodes/conversations/c", title: "Cy", last_activity_at: null });
    expect(orderConversations([a, c, b]).map((x) => x.title)).toEqual(["Bo", "Ann", "Cy"]);
  });
  it("names a person by email and an agent by @handle when inviting or starting one", () => {
    expect(memberSpec({ kind: "person", email: "walt@x" })).toBe("walt@x");
    expect(memberSpec({ kind: "agent", handle: "scout" })).toBe("@scout");
  });
});

describe("AC-C3-16 members panel", () => {
  const members: ChatMember[] = [
    { kind: "agent", handle: "scout", added_at: "" },
    { kind: "person", email: "zed@x", name: "Zed", added_at: "" },
    { kind: "person", email: "ME@x", name: "Me", added_at: "" },
    { kind: "person", email: "amy@x", name: "Amy", added_at: "" },
  ];
  it("lists who is around first, then people by name, then agents; marks me", () => {
    const rows = memberRows(members, new Set(["zed@x"]), "me@x");
    expect(rows.map((r) => r.label)).toEqual(["Zed", "Amy", "Me", "@scout"]);
    expect(rows.map((r) => r.online)).toEqual([true, false, false, false]);
    expect(rows.find((r) => r.label === "Me")?.you).toBe(true);
    expect(rows.find((r) => r.label === "@scout")?.kind).toBe("agent");
  });
});

describe("AC-C3-17 the channel menu", () => {
  const ch = { private: false, member: true, archived: false, conversation: undefined };
  it("a member may leave; the owner or an admin may make it private or public; writers archive", () => {
    expect(channelMenu(ch, { canManage: true, isAdmin: true })).toEqual(["notifications", "members", "make-private", "leave", "archive"]);
    expect(channelMenu({ ...ch, private: true }, { canManage: true, isAdmin: true })).toEqual(["notifications", "members", "make-public", "leave", "archive"]);
    expect(channelMenu(ch, { canManage: false, isAdmin: false })).toEqual(["notifications", "members", "leave"]);
  });
  it("a public channel I have not joined offers join, not leave", () => {
    expect(channelMenu({ ...ch, member: false }, { canManage: false, isAdmin: false })).toEqual(["notifications", "members", "join"]);
  });
  it("an archived channel offers members and restore only", () => {
    expect(channelMenu({ ...ch, archived: true }, { canManage: true, isAdmin: true })).toEqual(["members", "restore"]);
  });
  it("a group conversation can be left; a dm cannot", () => {
    expect(channelMenu({ ...ch, conversation: conv({ kind: "group" }) }, { canManage: true, isAdmin: true })).toEqual(["notifications", "members", "leave"]);
    expect(channelMenu({ ...ch, conversation: conv() }, { canManage: true, isAdmin: true })).toEqual(["notifications", "members"]);
  });
});

describe("AC-C3-18 first-run explainer", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it("shows once per person, until dismissed", () => {
    const s = store();
    expect(introSeen(s, "me@x")).toBe(false);
    markIntroSeen(s, "ME@x");
    expect(introSeen(s, "me@x")).toBe(true);
    expect(introSeen(s, "other@x")).toBe(false);
    expect(INTRO_KEY("Me@X")).toBe("chat-intro-seen:me@x");
  });
  it("never throws when storage does; shows nothing rather than nagging", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(introSeen(broken, "me@x")).toBe(true);
    expect(() => markIntroSeen(broken, "me@x")).not.toThrow();
    expect(introSeen(null, "me@x")).toBe(true);
  });
});
