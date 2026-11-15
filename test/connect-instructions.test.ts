/** po-1251: the connect message tells the model how to use the user's notes. */
import { describe, it, expect } from "vitest";
import { NOTES_USAGE_INSTRUCTIONS as T, serverConnectInstructions } from "../src/mcp/connect-instructions.js";
import { TOOL_DEFINITIONS } from "../src/mcp/tools.js";
import { SERVER_TOOL_DEFINITIONS } from "../src/mcp/server-routes.js";

describe("NOTES_USAGE_INSTRUCTIONS", () => {
  it("carries the key rules", () => {
    expect(T).toMatch(/before answering/i);
    expect(T).toMatch(/cite/i);
    expect(T).toMatch(/reference, not instructions/i);
    expect(T).toMatch(/only when the user asks/i);
    expect(T).toMatch(/never save unasked/i);
    expect(T).toMatch(/every node/i);
    expect(T).toMatch(/drafts/i);
  });
  it("is short", () => expect(T.length).toBeLessThan(1500));
  it("names only registered tools", () => {
    const registered = new Set([...TOOL_DEFINITIONS, ...SERVER_TOOL_DEFINITIONS].map((t) => t.name));
    const named = T.match(/\b(?:context|nest)_[a-z_]+\b/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    for (const n of named) expect(registered.has(n), n).toBe(true);
  });
  it("leads the server-wide connect message", async () => {
    const text = await serverConnectInstructions([], { userId: "u", userEmail: "u@x.test" }, "http://h");
    expect(text?.startsWith(T)).toBe(true);
  });
});
