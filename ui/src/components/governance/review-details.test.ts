import { describe, it, expect } from "vitest";
import { provenanceRows } from "./ReviewProvenance";
import { taskDetailRows, isTaskLike } from "./ReviewTaskDetails";

describe("review provenance rows", () => {
  it("names the agent, its session, who submitted and who sealed the last version", () => {
    const rows = provenanceRows({
      requestedBy: "stacey@promptowl.ai",
      requestedAt: "2026-11-17T10:22:00Z",
      lastEdit: {
        version: 2,
        edited_by: "stacey@promptowl.ai",
        edited_at: "2026-11-17T10:22:00Z",
        client: { agent: "grok", session_id: "s-9f2", listener: "support" },
      },
    });
    const by = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(by["Written by"]).toBe("grok");
    expect(by["Session"]).toBe("s-9f2");
    expect(by["listener"]).toBe("support");
    expect(by["Submitted by"]).toContain("stacey@promptowl.ai");
    expect(by["Last edit"]).toContain("v2");
  });

  it("a plain human edit is a short card, with no agent rows", () => {
    const rows = provenanceRows({ requestedBy: "a@b.co" });
    expect(rows.map((r) => r.label)).toEqual(["Submitted by"]);
  });
});

describe("review task details", () => {
  it("shows owner, due, priority, stage and plain tags, never the ticket tag", () => {
    const rows = taskDetailRows({
      type: "task",
      assignee: "stacey@promptowl.ai",
      due: "2026-11-18",
      priority: "high",
      tags: ["#task", "#stage:doing", "#ticket:po-12"],
    });
    expect(rows).toEqual([
      { label: "Owner", value: "stacey@promptowl.ai" },
      { label: "Due", value: "2026-11-18" },
      { label: "Priority", value: "High" },
      { label: "Stage", value: "Doing" },
      { label: "Tags", value: "#task" },
    ]);
  });

  it("a document with no task fields is not task-like", () => {
    expect(isTaskLike({ type: "document" })).toBe(false);
    expect(isTaskLike({ type: "task" })).toBe(true);
  });
});
