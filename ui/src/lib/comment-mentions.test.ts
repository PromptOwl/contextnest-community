import { describe, it, expect } from "vitest";
import { applyMentionPick, mentionSegments } from "./comment-mentions";

describe("applyMentionPick", () => {
  const pick = (value: string, caret: number, email: string) =>
    applyMentionPick(value, caret, email);

  it("replaces the typed trigger with the picked address", () => {
    expect(pick("cc @ed", 6, "editor@acme.com")).toEqual({
      value: "cc @editor@acme.com ",
      caret: 20,
    });
  });

  it("keeps the text after the caret, and doesn't double the space", () => {
    // Caret sits right after "@ed"; " there" must survive untouched.
    expect(pick("hi @ed there", 6, "editor@acme.com")).toEqual({
      value: "hi @editor@acme.com there",
      caret: 20,
    });
  });

  it("completes a bare @ with no query typed yet", () => {
    expect(pick("@", 1, "ada@acme.com")).toEqual({
      value: "@ada@acme.com ",
      caret: 14,
    });
  });

  it("leaves text with no mention trigger at the caret alone", () => {
    expect(pick("no trigger here", 15, "ada@acme.com")).toBeNull();
  });
});

describe("mentionSegments", () => {
  const members = [
    { email: "ada@acme.com", name: "Ada Lovelace" },
    { email: "grace@acme.com", name: null },
  ];

  it("splits a body into text and mention runs, losing nothing", () => {
    const segs = mentionSegments("cc @ada@acme.com on this", members);
    expect(segs.map((s) => s.text).join("")).toBe("cc @ada@acme.com on this");
    expect(segs.filter((s) => s.kind === "mention")).toEqual([
      { kind: "mention", text: "@ada@acme.com", name: "ada@acme.com", resolved: true },
    ]);
  });

  it("marks a name that resolves to nobody as unresolved", () => {
    const segs = mentionSegments("cc @nobody", members);
    expect(segs.filter((s) => s.kind === "mention")).toEqual([
      { kind: "mention", text: "@nobody", name: "nobody", resolved: false },
    ]);
  });

  it("resolves a local part and a display name, like the server does", () => {
    expect(
      mentionSegments("@grace and @(Ada Lovelace)", members)
        .filter((s) => s.kind === "mention")
        .map((s) => s.resolved),
    ).toEqual([true, true]);
  });

  it("leaves an @ inside code alone — there it is source, not a mention", () => {
    const segs = mentionSegments("run `npm i @acme/pkg` first", members);
    expect(segs.every((s) => s.kind === "text")).toBe(true);
    expect(segs.map((s) => s.text).join("")).toBe("run `npm i @acme/pkg` first");
  });

  it("leaves an @ inside a fenced block alone, like the server does", () => {
    // extractMentions blanks fenced blocks before parsing, so the server never
    // notifies for one — decorating it as an unresolved mention would tell the
    // reader a delivery failed that was never attempted.
    const body = "see\n```\nnpm i @acme/pkg\n```\nthanks @ada@acme.com";
    const segs = mentionSegments(body, members);
    expect(segs.map((s) => s.text).join("")).toBe(body);
    expect(segs.filter((s) => s.kind === "mention")).toEqual([
      {
        kind: "mention",
        text: "@ada@acme.com",
        name: "ada@acme.com",
        resolved: true,
      },
    ]);
  });

  it("reads mentions as resolved when there is no roster to check", () => {
    // A public reader gets no roster, and the roster arrives a tick late for
    // everyone else — striking every mention through would be a lie about a
    // thread of perfectly good mentions.
    expect(
      mentionSegments("cc @ada@acme.com and @nobody", [])
        .filter((s) => s.kind === "mention")
        .map((s) => s.kind === "mention" && s.resolved),
    ).toEqual([true, true]);
  });

  it("returns one text segment for a body with no mentions", () => {
    expect(mentionSegments("plain words", members)).toEqual([
      { kind: "text", text: "plain words" },
    ]);
  });
});

describe("a full stop ending a sentence is not part of the name (PO-1189, as the server reads it)", () => {
  const members = [{ email: "rita@acme.com", name: "Rita Reader" }];

  it("resolves @rita. as rita and leaves the dot as text", () => {
    const body = "thanks @rita. See you";
    const segs = mentionSegments(body, members);
    expect(segs.map((s) => s.text).join("")).toBe(body);
    expect(segs).toEqual([
      { kind: "text", text: "thanks " },
      { kind: "mention", text: "@rita", name: "rita", resolved: true },
      { kind: "text", text: ". See you" },
    ]);
  });

  it("keeps the dots inside an address and trims only the trailing ones", () => {
    const segs = mentionSegments("ping @rita@acme.com... now", members);
    expect(segs[1]).toEqual({ kind: "mention", text: "@rita@acme.com", name: "rita@acme.com", resolved: true });
    expect(segs[2]).toEqual({ kind: "text", text: "... now" });
  });

  it("leaves a parenthesized name alone", () => {
    const segs = mentionSegments("@(Rita Reader). ok", members);
    expect(segs[0]).toEqual({ kind: "mention", text: "@(Rita Reader)", name: "Rita Reader", resolved: true });
  });
});

describe("AC-UX-08 mentions styled from the message's own list", () => {
  it("uses the server's verdict for each name instead of the roster", () => {
    const body = "@rita@acme.com and @grok and @nosuch.";
    const segs = mentionSegments(body, [], [
      { name: "rita@acme.com", kind: "person", display_name: "Rita Reader" },
      { name: "grok", kind: "agent", wakeable: false },
      { name: "nosuch", kind: "nobody" },
    ]);
    expect(segs.map((s) => s.text).join("")).toBe(body);
    const mentions = segs.filter((s) => s.kind === "mention");
    expect(mentions).toEqual([
      { kind: "mention", text: "@rita@acme.com", name: "rita@acme.com", resolved: true, ref: { name: "rita@acme.com", kind: "person", display_name: "Rita Reader" } },
      { kind: "mention", text: "@grok", name: "grok", resolved: true, ref: { name: "grok", kind: "agent", wakeable: false } },
      { kind: "mention", text: "@nosuch", name: "nosuch", resolved: false, ref: { name: "nosuch", kind: "nobody" } },
    ]);
  });

  it("matches names whatever their case, and reads a name the list lacks as resolved", () => {
    const segs = mentionSegments("@Grok hi @other", [], [{ name: "grok", kind: "nobody" }]);
    const mentions = segs.filter((s) => s.kind === "mention");
    expect(mentions.map((m) => m.kind === "mention" && m.resolved)).toEqual([false, true]);
  });
});
