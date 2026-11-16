import { describe, it, expect, vi, afterEach } from "vitest";
import { chatWithHootie } from "./api";
import { pendingLabel, withDelta, withStatus } from "./hootie-panel";

// Ticket B: while Hootie searches the nest again, the panel says so.

function sse(...events: Array<[string, unknown]>): Response {
  const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("chatWithHootie — status events", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hands a status event to on.status, in order with the deltas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse(
          ["meta", { nodes: [], anchor: null }],
          ["delta", { text: "Let me look." }],
          ["status", { tool: "search_nest", text: "Searching the nest for “pilot gate”" }],
          ["delta", { text: "Nov 6." }],
          ["done", { answer: "Nov 6.", cited: [], mention: null }],
        ),
      ),
    );
    const seen: string[] = [];
    await chatWithHootie("n1", { message: "when?" }, {
      delta: (t) => seen.push(`delta:${t}`),
      status: (s) => seen.push(`status:${s.tool}:${s.text}`),
      done: (d) => seen.push(`done:${d.answer}`),
    });
    expect(seen).toEqual([
      "delta:Let me look.",
      "status:search_nest:Searching the nest for “pilot gate”",
      "delta:Nov 6.",
      "done:Nov 6.",
    ]);
  });
});

describe("the answer bubble while Hootie searches", () => {
  const pending = { content: "", pending: true };

  it("a status replaces the text so far and becomes the bubble's label", () => {
    const m = withStatus({ ...pending, content: "Let me look." }, "Searching the nest for “pilot gate”");
    expect(m.content).toBe("");
    expect(pendingLabel(m)).toBe("Searching the nest for “pilot gate”");
  });

  it("the next text clears the status; with no status the label is the default", () => {
    const m = withDelta(withStatus(pending, "Searching…"), "Nov ");
    expect(m).toEqual({ content: "Nov ", pending: true, status: undefined });
    expect(withDelta(m, "6.").content).toBe("Nov 6.");
    expect(pendingLabel(pending)).toBe("Reading the nest…");
  });
});
