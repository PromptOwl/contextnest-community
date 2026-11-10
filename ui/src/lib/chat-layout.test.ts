/**
 * AC-C3-05, AC-C3-07, AC-C3-10 (PO-1200): where the panes go at a width, the
 * launcher's placement and gate, one side panel at a time, the jump pill.
 */
import { describe, expect, it } from "vitest";
import { RAIL_COLUMN_MIN, THREAD_BESIDE_MIN, jumpPill, launcherPlacement, launcherShown, paneLayout } from "./chat-layout";
import { nextSidePanel } from "./side-panel";

describe("AC-C3-05 / AC-C3-10 pane layout", () => {
  it("a phone: everything is a sheet", () => {
    expect(paneLayout(390)).toEqual({ sidebar: "sheet", thread: "sheet", rail: "folded" });
  });
  it("a laptop: the list inline, the thread a sheet until 1100", () => {
    expect(paneLayout(1024)).toEqual({ sidebar: "inline", thread: "sheet", rail: "folded" });
    expect(paneLayout(THREAD_BESIDE_MIN)).toEqual({ sidebar: "inline", thread: "beside", rail: "folded" });
    expect(paneLayout(1440).thread).toBe("beside");
    expect(paneLayout(1440).rail).toBe("folded");
  });
  it("a wide screen: the rail is its own column", () => {
    expect(paneLayout(RAIL_COLUMN_MIN).rail).toBe("column");
    expect(paneLayout(1920)).toEqual({ sidebar: "inline", thread: "beside", rail: "column" });
  });
});

describe("AC-C3-07 launcher", () => {
  it("stacks under Hootie's tab when that one shows, takes its place otherwise", () => {
    expect(launcherPlacement(true)).toBe("below-hootie");
    expect(launcherPlacement(false)).toBe("centre");
  });
  it("shows only for a member with the switch on, and never on the chat page", () => {
    expect(launcherShown({ streamOn: true, member: true, onChatPage: false })).toBe(true);
    expect(launcherShown({ streamOn: false, member: true, onChatPage: false })).toBe(false);
    expect(launcherShown({ streamOn: true, member: false, onChatPage: false })).toBe(false);
    expect(launcherShown({ streamOn: true, member: null, onChatPage: false })).toBe(false);
    expect(launcherShown({ streamOn: true, member: true, onChatPage: true })).toBe(false);
  });
  it("one side panel at a time: opening one closes the other", () => {
    expect(nextSidePanel(null, "chat", "open")).toBe("chat");
    expect(nextSidePanel("hootie", "chat", "open")).toBe("chat");
    expect(nextSidePanel("chat", "hootie", "open")).toBe("hootie");
    expect(nextSidePanel("chat", "chat", "close")).toBeNull();
    // Closing a panel that is not open changes nothing.
    expect(nextSidePanel("hootie", "chat", "close")).toBe("hootie");
    expect(nextSidePanel("chat", "chat", "toggle")).toBeNull();
    expect(nextSidePanel("hootie", "chat", "toggle")).toBe("chat");
  });
});

describe("AC-C3-03 jump to latest", () => {
  it("shows while scrolled up, with a count once messages arrive", () => {
    expect(jumpPill(0, 3)).toEqual({ shown: false, label: "" });
    expect(jumpPill(400, 0)).toEqual({ shown: true, label: "Jump to latest" });
    expect(jumpPill(400, 1)).toEqual({ shown: true, label: "1 new message" });
    expect(jumpPill(400, 4)).toEqual({ shown: true, label: "4 new messages" });
  });
});
