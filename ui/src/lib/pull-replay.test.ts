import { describe, it, expect } from "vitest";
import {
  replayFrame,
  replayEdges,
  pullTitle,
  toolLabel,
  formatBytes,
  stepHowLabel,
  sizeBasis,
  type PullLike,
} from "./pull-replay";

const step = (nodeId: string, seq: number, extra: Partial<PullLike["steps"][number]> = {}) => ({
  seq,
  nodeId,
  title: null,
  version: 1,
  hop: null,
  via: null,
  bytes: 100,
  ...extra,
});

describe("replayEdges — which edge lights each step", () => {
  it("follows the recorded via when the server walked the graph", () => {
    const pull: PullLike = {
      steps: [
        step("a", 0, { hop: 0 }),
        step("b", 1, { hop: 1, via: "a" }),
        step("c", 2, { hop: 2, via: "b" }),
      ],
    };
    expect(replayEdges(pull, [])).toEqual([null, { from: "a", to: "b" }, { from: "b", to: "c" }]);
  });

  it("lights no edge for a direct match", () => {
    const pull: PullLike = { steps: [step("a", 0, { hop: 0 }), step("b", 1, { hop: 0 })] };
    // Even when a and b are linked: both matched, nothing was walked.
    expect(replayEdges(pull, [["a", "b"]])).toEqual([null, null]);
  });

  it("with no recorded traversal, joins a step to the latest earlier step it links to", () => {
    const pull: PullLike = { steps: [step("a", 0), step("x", 1), step("b", 2), step("c", 3)] };
    const links: Array<[string, string]> = [["a", "b"], ["x", "b"], ["c", "q"]];
    expect(replayEdges(pull, links)).toEqual([null, null, { from: "x", to: "b" }, null]);
  });

  it("draws no edge for a hop whose via was redacted, and labels it by depth alone", () => {
    // The server blanks `via` when it names a document this reader can't see.
    // Guessing a path through a visible neighbour would draw a walk that never happened.
    const pull: PullLike = { steps: [step("a", 0, { hop: 0 }), step("c", 1, { hop: 2, via: null })] };
    expect(replayEdges(pull, [["a", "c"]])).toEqual([null, null]);
    expect(stepHowLabel(pull.steps[1], (id) => id)).toBe("Hop 2");
  });
});

describe("replayFrame — what is lit at a step", () => {
  const pull: PullLike = {
    steps: [step("a", 0, { hop: 0 }), step("b", 1, { hop: 1, via: "a" }), step("c", 2, { hop: 2, via: "b" })],
  };
  it("lights steps 0..i in order, with the edges walked so far", () => {
    const f = replayFrame(pull, [], 1);
    expect([...f.lit]).toEqual(["a", "b"]);
    expect(f.current).toBe("b");
    expect(f.edges).toEqual([{ from: "a", to: "b" }]);
    expect(f.order.get("b")).toBe(2);
  });
  it("lights nothing before the first step", () => {
    const f = replayFrame(pull, [], -1);
    expect(f.lit.size).toBe(0);
    expect(f.current).toBeNull();
  });
  it("clamps past the end to the full pull", () => {
    const f = replayFrame(pull, [], 99);
    expect(f.lit.size).toBe(3);
    expect(f.current).toBe("c");
  });
});

describe("labels", () => {
  it("names the tool in plain words", () => {
    expect(toolLabel("context_get", "read")).toBe("Read");
    expect(toolLabel("context_search", "retrieve")).toBe("Search");
    expect(toolLabel("search", "retrieve")).toBe("Search");
    expect(toolLabel("context", "retrieve")).toBe("Context");
    expect(toolLabel("context_query", "retrieve")).toBe("Query");
    expect(toolLabel(null, "read")).toBe("Opened");
  });
  it("titles a pull by agent, then person, then the tool when identities are hidden", () => {
    expect(pullTitle({ agent: "Support Copilot", actor: "noor@x.test", tool: "context", action: "retrieve" })).toBe("Support Copilot");
    expect(pullTitle({ agent: null, actor: "noor@x.test", tool: "context", action: "retrieve" })).toBe("noor@x.test");
    expect(pullTitle({ agent: null, actor: null, tool: "context", action: "retrieve" })).toBe("Context pull");
  });
  it("formats sizes", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4300)).toBe("4.2 KB");
    expect(formatBytes(3_500_000)).toBe("3.3 MB");
  });
  it("says how a step was reached", () => {
    const title = (id: string) => ({ a: "Returns Policy" } as Record<string, string>)[id] ?? id;
    expect(stepHowLabel(step("a", 0, { hop: 0 }), title)).toBe("Matched");
    expect(stepHowLabel(step("b", 1, { hop: 1, via: "a" }), title)).toBe("Hop 1 via Returns Policy");
    expect(stepHowLabel(step("b", 1, { hop: 2 }), title)).toBe("Hop 2");
    expect(stepHowLabel(step("b", 1), title)).toBeNull();
  });
});

describe("sizeBasis — what a pull's size measures", () => {
  it("names the basis of each surface", () => {
    expect(sizeBasis("context")).toMatch(/compiled context blocks/);
    expect(sizeBasis("context_resolve")).toMatch(/title and body/);
    expect(sizeBasis("context_get")).toMatch(/document bodies/);
    expect(sizeBasis(null)).toMatch(/document bodies/);
  });
});
