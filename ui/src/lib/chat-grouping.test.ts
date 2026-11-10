/**
 * AC-C3-03 (PO-1200): the conversation's rows — chronological order, author
 * groups within five minutes, date lines, the "New" line, thread summaries.
 */
import { describe, expect, it } from "vitest";
import type { ChannelMessage } from "./api";
import {
  GROUP_WINDOW_MS,
  buildConversation,
  continuesGroup,
  dateLabel,
  newLineAnchor,
  sortChronological,
  threadSummary,
} from "./chat-grouping";

const at = (iso: string) => iso.replace("T", " ").replace("Z", "");
const msg = (id: string, author: string, created: string, agent: string | null = null): ChannelMessage => ({
  id,
  author,
  author_name: author.split("@")[0],
  actor: { human: author.split("@")[0], agent, label: author },
  body: `body ${id}`,
  created_at: at(created),
  cards: [],
  mentions: [],
});

describe("AC-C3-03 order", () => {
  it("sorts oldest first whatever order the server paged them in, keeping ties stable", () => {
    const list = [msg("c", "a@x", "2026-11-09T10:05:00.000Z"), msg("a", "a@x", "2026-11-09T10:00:00.000Z"), msg("b", "a@x", "2026-11-09T10:00:00.000Z")];
    expect(sortChronological(list).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});

describe("AC-C3-03 grouping", () => {
  const base = "2026-11-09T10:00:00.000Z";
  it("the same author within five minutes continues the group", () => {
    expect(continuesGroup(msg("1", "a@x", base), msg("2", "a@x", "2026-11-09T10:04:59.000Z"))).toBe(true);
    expect(continuesGroup(msg("1", "a@x", base), msg("2", "a@x", "2026-11-09T10:05:01.000Z"))).toBe(false);
    expect(GROUP_WINDOW_MS).toBe(300_000);
  });
  it("a different author, or an agent acting for the same person, starts a new group", () => {
    expect(continuesGroup(msg("1", "a@x", base), msg("2", "b@x", base))).toBe(false);
    expect(continuesGroup(msg("1", "a@x", base), msg("2", "a@x", base, "grok"))).toBe(false);
    expect(continuesGroup(msg("1", "a@x", base, "grok"), msg("2", "a@x", base, "grok"))).toBe(true);
  });
  it("a group never crosses midnight", () => {
    expect(continuesGroup(msg("1", "a@x", "2026-11-09T23:58:00.000Z"), msg("2", "a@x", "2026-11-10T00:01:00.000Z"))).toBe(false);
  });
  it("marks the first and last message of each group", () => {
    const rows = buildConversation(
      [msg("1", "a@x", base), msg("2", "a@x", "2026-11-09T10:01:00.000Z"), msg("3", "b@x", "2026-11-09T10:02:00.000Z")],
      { now: new Date("2026-11-09T12:00:00.000Z") },
    );
    const messages = rows.filter((r) => r.kind === "message") as Array<{ message: ChannelMessage; first: boolean; last: boolean }>;
    expect(messages.map((r) => [r.message.id, r.first, r.last])).toEqual([
      ["1", true, false],
      ["2", false, true],
      ["3", true, true],
    ]);
  });
});

describe("AC-C3-03 date lines", () => {
  const now = new Date(2026, 10, 9, 12, 0, 0);
  it("Today and Yesterday by the local day, then the weekday and date", () => {
    expect(dateLabel(new Date(2026, 10, 9, 1, 0), now)).toBe("Today");
    expect(dateLabel(new Date(2026, 10, 8, 23, 59), now)).toBe("Yesterday");
    const older = dateLabel(new Date(2026, 10, 2, 9, 0), now);
    expect(older).not.toBe("Today");
    expect(older).toMatch(/2/);
    expect(dateLabel(new Date(2025, 10, 2, 9, 0), now)).toMatch(/2025/);
  });
  it("one date line per day, before that day's first message", () => {
    const rows = buildConversation(
      [msg("1", "a@x", "2026-11-08T10:00:00.000Z"), msg("2", "a@x", "2026-11-08T10:01:00.000Z"), msg("3", "a@x", "2026-11-09T09:00:00.000Z")],
      { now: new Date("2026-11-09T12:00:00.000Z") },
    );
    expect(rows.map((r) => r.kind)).toEqual(["date", "message", "message", "date", "message"]);
    // The day change also breaks the group, so message 3 heads one.
    expect((rows[4] as { first: boolean }).first).toBe(true);
  });
});

describe("AC-C3-03 the New line", () => {
  const list = [msg("1", "me@x", "2026-11-09T10:00:00.000Z"), msg("2", "a@x", "2026-11-09T10:01:00.000Z"), msg("3", "me@x", "2026-11-09T10:02:00.000Z"), msg("4", "b@x", "2026-11-09T10:03:00.000Z")];
  it("goes before the earliest of the last `unread` messages by other people", () => {
    expect(newLineAnchor(list, 1, "me@x")).toBe("4");
    expect(newLineAnchor(list, 2, "ME@x")).toBe("2");
    // More unread than messages by others on screen: the earliest of theirs.
    expect(newLineAnchor(list, 9, "me@x")).toBe("2");
  });
  it("is absent with nothing unread or nothing by others", () => {
    expect(newLineAnchor(list, 0, "me@x")).toBeNull();
    expect(newLineAnchor([list[0], list[2]], 3, "me@x")).toBeNull();
  });
  it("is a row of its own that starts a new group", () => {
    const rows = buildConversation(list, { now: new Date("2026-11-09T12:00:00.000Z"), newBefore: "4" });
    expect(rows.map((r) => r.kind)).toEqual(["date", "message", "message", "message", "new", "message"]);
    expect((rows[3] as { last: boolean }).last).toBe(true);
    expect((rows[5] as { first: boolean }).first).toBe(true);
  });
});

describe("AC-C3-03 thread summary", () => {
  it("counts replies and says when the last one was", () => {
    expect(threadSummary({ reply_count: 0 }, "2m ago")).toBeNull();
    expect(threadSummary({ reply_count: 1 }, "2m ago")).toBe("1 reply · 2m ago");
    expect(threadSummary({ reply_count: 3 }, null)).toBe("3 replies");
  });
});
