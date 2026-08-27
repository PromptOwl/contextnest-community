import { describe, it, expect } from "vitest";
import {
  nestSummary,
  serverMcpUrl,
  allNestsChatPrompt,
  nestChatPrompt,
  nestSetupPrompt,
  envFileContents,
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
  it("gives an immediate REST read and the MCP url, both per-nest", () => {
    const p = nestSetupPrompt("GTM", "https://x.ai/", "gtm");
    expect(p).toContain("https://x.ai/nests/gtm/context");
    expect(p).toContain("https://x.ai/nests/gtm/mcp");
  });

  it("has an anti-hallucination proof gate and a no-shell handoff", () => {
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm");
    expect(p).toMatch(/do NOT claim you'?re connected/i);
    expect(p).toMatch(/settings . connectors/i); // no-shell handoff path
  });

  it("uses npx (not a global install) and asks for the key", () => {
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm");
    expect(p).toContain("npx -y @promptowl/contextnest-cli");
    expect(p).toMatch(/ask me only for the api key/i);
  });

  it("never bakes in a key", () => {
    expect(nestSetupPrompt("GTM", "https://x.ai", "gtm")).not.toMatch(/cnst_/);
  });
});

describe("envFileContents", () => {
  it("includes server + key, and the nest line when a nestId is given", () => {
    const e = envFileContents({
      serverUrl: "https://x.ai/",
      apiKey: "cnst_abc",
      nestId: "n1",
    });
    expect(e).toContain("CONTEXTNEST_SERVER=https://x.ai");
    expect(e).toContain("CONTEXTNEST_API_KEY=cnst_abc");
    expect(e).toContain("CONTEXTNEST_NEST=n1");
  });

  it("omits the nest line when no nestId (all-nests key)", () => {
    const e = envFileContents({ serverUrl: "https://x.ai", apiKey: "cnst_abc" });
    expect(e).not.toContain("CONTEXTNEST_NEST");
  });

  it("warns not to commit the file", () => {
    expect(
      envFileContents({ serverUrl: "https://x.ai", apiKey: "k" }),
    ).toMatch(/do not commit/i);
  });
});

describe("open-mode prompts (AUTH_MODE=open)", () => {
  it("allNestsChatPrompt drops every credential instruction", () => {
    const p = allNestsChatPrompt("https://x.ai", true);
    expect(p).not.toMatch(/api key/i);
    expect(p).toContain("no credential");
    expect(p).toContain("https://x.ai/mcp");
  });

  it("nestSetupPrompt drops the Bearer header and the KEY section", () => {
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm", true);
    expect(p).not.toMatch(/authorization: bearer/i);
    expect(p).not.toMatch(/api key/i);
    // still fully usable: the proof gate and both connect paths survive
    expect(p).toContain("https://x.ai/nests/gtm/context");
    expect(p).toMatch(/settings . connectors/i);
  });

  it("key mode is unchanged (default arg)", () => {
    expect(nestSetupPrompt("GTM", "https://x.ai", "gtm")).toMatch(
      /Authorization: Bearer/,
    );
    expect(allNestsChatPrompt("https://x.ai")).toMatch(/api key/i);
  });
});

describe("write honesty (ticket AC: no false read-only claims)", () => {
  it("does not claim the server-level connection is read-only", () => {
    const p = allNestsChatPrompt("https://x.ai");
    expect(p).not.toMatch(/does ?n'?t write|read-only/i);
    // server-routes.ts exposes nest_create + context_create on /mcp
    expect(p).toContain("nest_create");
    expect(p).toContain("context_create");
    expect(p).toMatch(/asking me first/i);
  });
});

describe("ctx CLI contract (verified against contextnest-cli 1.2.1)", () => {
  // `ctx push` takes --server/--nest/--key and reads NO api-key env var.
  // Telling an agent to export CONTEXTNEST_API_KEY produced a silent 401.
  it("passes the key as a --key flag, never as an env var", () => {
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm");
    expect(p).toContain("push --server https://x.ai --nest gtm");
    expect(p).toContain("--key");
    expect(p).not.toContain("CONTEXTNEST_API_KEY");
  });

  it("omits the key flag entirely in open mode", () => {
    const p = nestSetupPrompt("GTM", "https://x.ai", "gtm", true);
    expect(p).toContain("push --server https://x.ai --nest gtm");
    expect(p).not.toContain("--key");
  });
});
