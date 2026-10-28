/**
 * The MCP `view` argument comes from the engine's own operation descriptors
 * (PR #440 review): context_create and context_update must advertise it, and
 * an engine that lacks the operation or the property must fail loudly at load
 * instead of silently dropping the argument from the tool schema.
 */
import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS, engineViewProperty } from "../src/mcp/tools.js";

describe("MCP view property conformance", () => {
  it.each(["context_create", "context_update"])("%s advertises a view object property", (name) => {
    const tool = TOOL_DEFINITIONS.find((t: any) => t.name === name) as any;
    expect(tool, name).toBeTruthy();
    const view = tool.inputSchema.properties.view;
    expect(view, `${name}.view`).toBeTruthy();
    expect(view.type).toBe("object");
    expect(JSON.stringify(view)).toContain("blocks");
  });

  it("throws when the engine has no such operation", () => {
    const api = { getOperation: () => undefined } as any;
    expect(() => engineViewProperty("context_create", api)).toThrow(/context_create/);
  });

  it("throws when the engine operation has no view property", () => {
    const real = { getOperation: (n: string) => ({ name: n, input: undefined }) } as any;
    expect(() => engineViewProperty("context_update", real)).toThrow(/view/);
  });
});
