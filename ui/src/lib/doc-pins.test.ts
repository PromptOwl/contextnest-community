/**
 * Document pins (CU-wdqcq02crw) — the pure parts of the pinned strip: where a
 * dragged pin lands, and which pin state a document shows in its header.
 */
import { describe, it, expect } from "vitest";
import { movePin, pinStateFor } from "./doc-pins";
import type { DocPins } from "./api";

describe("movePin", () => {
  it("moves a pin before the drop target", () => {
    expect(movePin(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(movePin(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
  });

  it("dropping at the end (no target) appends", () => {
    expect(movePin(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
  });

  it("is a no-op for a drop on itself or an unknown id", () => {
    expect(movePin(["a", "b"], "a", "a")).toEqual(["a", "b"]);
    expect(movePin(["a", "b"], "z", "a")).toEqual(["a", "b"]);
  });

  it("never drops or duplicates an id", () => {
    const out = movePin(["a", "b", "c", "d"], "b", "d");
    expect([...out].sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("pinStateFor", () => {
  const pins: DocPins = {
    editorial: [{ node_id: "nodes/a", scope: "nest", title: "A", type: "document", status: "draft", position: 0, pinned_by: null, pinned_at: "" }],
    personal: [{ node_id: "nodes/b", scope: "user", title: "B", type: "document", status: "draft", position: 0, pinned_by: null, pinned_at: "" }],
    can_pin_editorial: true,
  };

  it("reports each scope independently", () => {
    expect(pinStateFor(pins, "nodes/a")).toEqual({ editorial: true, personal: false, any: true });
    expect(pinStateFor(pins, "nodes/b")).toEqual({ editorial: false, personal: true, any: true });
    expect(pinStateFor(pins, "nodes/c")).toEqual({ editorial: false, personal: false, any: false });
  });

  it("no data yet reads as unpinned", () => {
    expect(pinStateFor(undefined, "nodes/a")).toEqual({ editorial: false, personal: false, any: false });
  });
});
