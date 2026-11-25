import { describe, expect, it } from "vitest";
import { chatRows } from "./one-chat";

const U = "11111111-1111-4111-8111-111111111111";
const summary = {
  total: 3, mentions: 0,
  nests: [
    { nest_id: "f", nest_name: "Fernhill", unread: 1, mentions: 0, channels: [{ id: "x", name: "general", unread: 1 }, { id: "y", name: "archive-talk", unread: 0 }], conversations: [] },
    { nest_id: "p", nest_name: "Partner", unread: 2, mentions: 0, channels: [{ id: "z", name: "general", unread: 2 }], conversations: [] },
  ],
} as any;
const convs = new Map([["p", [{ id: `nodes/conversations/${U}`, title: "Ed Marsh", unread: 0 }]]]) as any;

describe("chat across nests", () => {
  it("EX-1 the same channel name shows once under each nest", () => {
    const r = chatRows(summary, convs, "all", "");
    expect(r.nests.map((n) => [n.nestName, n.channels.map((c) => c.label)])).toEqual([["Fernhill", ["general", "archive-talk"]], ["Partner", ["general"]]]);
    expect(new Set(r.nests.flatMap((n) => n.channels.map((c) => c.key))).size).toBe(3);
  });
  it("EX-5 a direct message names its nest", () => {
    expect(chatRows(summary, convs, "all", "").direct[0]).toMatchObject({ label: "Ed Marsh", nestName: "Partner", channel: `~${U}` });
  });
  it("one nest shows only its rows, and only a number for the rest", () => {
    const r = chatRows(summary, convs, "f", "");
    expect(r.nests.map((n) => n.nestName)).toEqual(["Fernhill"]);
    expect(r.direct).toEqual([]);
    expect(r.elsewhere).toBe(2);
  });
  it("typing filters channels and people", () => {
    expect(chatRows(summary, convs, "all", "#arch").nests.flatMap((n) => n.channels.map((c) => c.label))).toEqual(["archive-talk"]);
    expect(chatRows(summary, convs, "all", "@ed").direct).toHaveLength(1);
  });
});
