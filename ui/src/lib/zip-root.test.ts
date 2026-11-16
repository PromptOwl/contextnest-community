import { describe, it, expect } from "vitest";
import { stripSharedRoot } from "./zip-root";

const paths = (ps: string[]) => stripSharedRoot(ps.map((path) => ({ path }))).map((f) => f.path);

describe("stripSharedRoot", () => {
  it("drops the folder a compressed-folder zip wraps everything in", () => {
    expect(paths(["my-nest/CONTEXT.md", "my-nest/notes/a.md"])).toEqual(["CONTEXT.md", "notes/a.md"]);
  });

  it("leaves an exported bundle's layout alone", () => {
    expect(paths(["CONTEXT.md", "nodes/a.md"])).toEqual(["CONTEXT.md", "nodes/a.md"]);
    expect(paths(["nodes/a.md", "nodes/b/c.md"])).toEqual(["nodes/a.md", "nodes/b/c.md"]);
  });

  it("leaves a zip with several top-level folders alone", () => {
    expect(paths(["a/x.md", "b/y.md"])).toEqual(["a/x.md", "b/y.md"]);
  });
});
