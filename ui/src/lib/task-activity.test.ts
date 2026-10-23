import { describe, it, expect } from "vitest";
import { describeTaskEntry, taskActivityEntries, taskEntryNote } from "./task-activity";

const people = [{ email: "misha@x.com", name: "Misha" }];

describe("describeTaskEntry", () => {
  it("names agent, key and person", () => {
    expect(
      describeTaskEntry(
        { actor: "misha@x.com", agent: "Claude Code", key: { label: "ctx CLI (laptop)", scoped: true } },
        people,
      ),
    ).toBe("Claude Code (key ctx CLI (laptop)) on behalf of Misha");
  });
  it("names a key once when it is also the derived agent", () => {
    expect(
      describeTaskEntry({ actor: "misha@x.com", agent: "laptop", key: { label: "laptop", scoped: false } }, people),
    ).toBe("laptop on behalf of Misha");
  });
  it("falls back to the person alone, by email when off-roster", () => {
    expect(describeTaskEntry({ actor: "a@b.co" }, people)).toBe("a@b.co");
  });
});

describe("taskActivityEntries / taskEntryNote", () => {
  it("keeps only logged interactions and strips the status prefix", () => {
    const rows = taskActivityEntries([
      { type: "edit", nodeId: "n", actor: "a", at: "t" },
      { type: "task_activity", nodeId: "n", actor: "a", at: "t", status: "done", detail: "done · shipped it" },
    ]);
    expect(rows).toHaveLength(1);
    expect(taskEntryNote(rows[0])).toBe("shipped it");
  });
});
