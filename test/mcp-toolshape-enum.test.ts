/**
 * toolShape honours a string `enum` (po-1214, pinned by po-1375). The change
 * reached every tool that declares one, not only context_stream: the MCP SDK
 * now refuses an out-of-enum value before the tool's own handler runs, and
 * tools/list advertises the allowed values. These cases pin that on tools
 * that existed before the change.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { TOOL_DEFINITIONS, toolShape } from "../src/mcp/tools.js";

const def = (name: string) => {
  const t = (TOOL_DEFINITIONS as any[]).find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};
const shapeOf = (name: string) => z.object(toolShape(name, def(name).inputSchema));

describe("toolShape: a string enum on an existing tool (po-1375)", () => {
  it("Given context_set_visibility, When a client sends a tier outside the enum, Then the shape refuses it before the handler runs", () => {
    const shape = shapeOf("context_set_visibility");
    expect(shape.safeParse({ visibility: "public" }).success).toBe(true);
    const bad = shape.safeParse({ visibility: "everyone" });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues[0].path).toEqual(["visibility"]);
  });

  it("Given context_systems, Then every declared action passes and any other is refused", () => {
    const shape = shapeOf("context_systems");
    for (const action of def("context_systems").inputSchema.properties.action.enum) {
      expect(shape.safeParse({ action }).success, action).toBe(true);
    }
    expect(shape.safeParse({ action: "delete_everything" }).success).toBe(false);
  });

  it("Given tools/list, Then the advertised schema carries the enum values and the description", () => {
    const js = z.toJSONSchema(shapeOf("context_set_visibility"), { io: "input", unrepresentable: "any" }) as any;
    expect(js.properties.visibility.enum).toEqual(["private", "org", "public"]);
    expect(js.properties.visibility.description).toBe("The new tier.");
  });

  it("Given an enum that is not all strings, or empty, Then the field falls back to a plain string", () => {
    const shape = z.object(
      toolShape("x_test", {
        properties: { a: { type: "string", enum: [1, 2] }, b: { type: "string", enum: [] } },
      }),
    );
    expect(shape.safeParse({ a: "anything", b: "anything" }).success).toBe(true);
  });
});
