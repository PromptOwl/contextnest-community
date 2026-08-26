import { describe, it, expect } from "vitest";
import {
  nestSummary,
  serverMcpUrl,
  allNestsChatPrompt,
  nestChatPrompt,
  nestSetupPrompt,
} from "./connect";

// Regression tests written before the implementation (dev-loop: fail-before-build).
// These pin the pure logic behind the "All my nests" landing + Connect-all UX,
// which is the only part testable in this repo's node-only vitest setup.

describe("nestSummary", () => {
  it("counts nests and sums document_count across mixed value types", () => {
    expect(
      nestSummary([
        { document_count: 5 },
        { document_count: "3" }, // server sometimes serializes counts as strings
        { document_count: null },
        {}, // missing entirely
      ]),
    ).toEqual({ nestCount: 4, documentCount: 8 });
  });

  it("is all-zero for an empty brain", () => {
    expect(nestSummary([])).toEqual({ nestCount: 0, documentCount: 0 });
  });

  it("never returns NaN when a count is garbage", () => {
    expect(nestSummary([{ document_count: "oops" as unknown as number }])).toEqual({
      nestCount: 1,
      documentCount: 0,
    });
  });
});

describe("serverMcpUrl", () => {
  it("appends /mcp to the server base", () => {
    expect(serverMcpUrl("https://community.promptowl.ai")).toBe(
      "https://community.promptowl.ai/mcp",
    );
  });

  it("tolerates one or more trailing slashes", () => {
    expect(serverMcpUrl("https://x.ai/")).toBe("https://x.ai/mcp");
    expect(serverMcpUrl("https://x.ai///")).toBe("https://x.ai/mcp");
  });
});

describe("allNestsChatPrompt", () => {
  it("points the agent at the server-level /mcp endpoint", () => {
    expect(allNestsChatPrompt("https://x.ai/")).toContain("https://x.ai/mcp");
  });

  it("tells the agent to call nest_index first", () => {
    expect(allNestsChatPrompt("https://x.ai")).toContain("nest_index");
  });

  it("never embeds an API key or secret in the prompt", () => {
    // The whole point of the redesign: keys are the user's to hand over, never baked in.
    expect(allNestsChatPrompt("https://x.ai")).not.toMatch(/cnst_|api[_-]?key\s*[:=]/i);
  });
});

describe("nestChatPrompt", () => {
  it("names the nest and forbids inventing answers", () => {
    const p = nestChatPrompt("GTM Strategy", "Go-to-market strategy");
    expect(p).toContain('"GTM Strategy"');
    expect(p).toMatch(/don't invent/i);
  });

  it("works with no description and doesn't throw", () => {
    expect(() => nestChatPrompt("Solo")).not.toThrow();
    expect(nestChatPrompt("Solo")).toContain('"Solo"');
  });

  it("embeds no secret", () => {
    expect(nestChatPrompt("X", "y")).not.toMatch(/cnst_/);
  });
});

describe("nestSetupPrompt", () => {
  it("includes the nest's MCP url and orients before answering", () => {
    const p = nestSetupPrompt("GTM", "https://x.ai/nests/gtm/mcp");
    expect(p).toContain("https://x.ai/nests/gtm/mcp");
    expect(p).toContain("context_overview");
  });

  it("never bakes in a key", () => {
    expect(nestSetupPrompt("GTM", "https://x.ai/nests/gtm/mcp")).not.toMatch(
      /cnst_/,
    );
  });
});
