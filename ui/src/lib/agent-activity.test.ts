import { describe, it, expect } from "vitest";
import { undoPromise, kindLabel } from "./agent-activity";
import type { AgentActivityItem } from "./api";

const item = (over: Partial<AgentActivityItem>): AgentActivityItem => ({
  id: "nodes/p@v2",
  kind: "update",
  nodeId: "nodes/p",
  title: "Pricing",
  version: 2,
  actor: "owner@acme.com",
  agent: "hootie",
  at: "2026-09-28T00:00:00.000Z",
  undo: { available: true },
  ...over,
});

describe("agent activity copy", () => {
  it("says a restore keeps the agent's version in history", () => {
    const text = undoPromise(item({ undo: { available: true, effect: "restore", restoreTo: 1 } }));
    expect(text).toContain("version 1");
    expect(text).toMatch(/new version/);
    expect(text).toMatch(/stays in the history/);
  });

  it("warns that undoing a create deletes the document", () => {
    expect(undoPromise(item({ kind: "create", undo: { available: true, effect: "delete" } }))).toMatch(/deletes the document/);
  });

  it("explains a draft discard, including the never-published case", () => {
    const text = undoPromise(item({ undo: { available: true, effect: "discard" } }));
    expect(text).toMatch(/draft/);
    expect(text).toMatch(/never published/);
  });

  it("promises nothing for a change that can't be undone", () => {
    expect(undoPromise(item({ undo: { available: false, reason: "Changed since" } }))).toBe("");
  });

  it("falls back to the node id when the title is gone", () => {
    expect(undoPromise(item({ title: undefined, undo: { available: true, effect: "delete" } }))).toContain("nodes/p");
  });

  it("labels each kind", () => {
    expect(kindLabel("create")).toBe("Created");
    expect(kindLabel("delete")).toBe("Deleted");
  });
});
