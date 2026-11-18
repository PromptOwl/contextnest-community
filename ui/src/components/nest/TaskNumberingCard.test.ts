import { describe, it, expect } from "vitest";
import { draftFromRules, draftProblem, rulesFromDraft, TASK_PRESETS } from "./TaskNumberingCard";
import type { TaskRules } from "../../lib/api";

describe("task numbering form <-> task_rules", () => {
  const rules: TaskRules = {
    exclusive_namespaces: ["stage"],
    default_stage_tag: "stage:backlog",
    ticket_numbering: true,
    ticket_prefix: "PO",
    ticket_start_at: 500,
    default_surface: "Core",
    priorities: [{ key: "p0", label: "P0" }, { key: "p1", label: "P1" }],
    stage_order: ["backlog", "in-progress", "done"],
    surfaces: [
      { name: "Core", tags: ["contextnest", "engine"] },
      { name: "Docs", tags: ["docs"] },
    ],
  };

  it("round-trips without losing anything", () => {
    expect(rulesFromDraft(draftFromRules(rules))).toEqual(rules);
  });

  it("normalizes what a person types", () => {
    const d = draftFromRules(rules);
    d.rows[0] = { name: " Core ", tags: "#ContextNest , engine,," };
    d.prefix = " po ";
    d.defaultStage = "#Stage:Backlog";
    const out = rulesFromDraft(d);
    expect(out.surfaces[0]).toEqual({ name: "Core", tags: ["contextnest", "engine"] });
    expect(out.ticket_prefix).toBe("PO");
    expect(out.default_stage_tag).toBe("stage:backlog");
  });

  it("a new priority level has no key until the server makes one", () => {
    const d = draftFromRules(rules);
    d.priorities.push({ label: " Blocker " });
    expect(rulesFromDraft(d).priorities).toEqual([
      { key: "p0", label: "P0" },
      { key: "p1", label: "P1" },
      { label: "Blocker" },
    ]);
  });

  it("an empty draft turns everything off", () => {
    expect(rulesFromDraft(draftFromRules(undefined))).toEqual({
      exclusive_namespaces: [],
      default_stage_tag: null,
      ticket_numbering: false,
      ticket_prefix: null,
      ticket_start_at: null,
      default_surface: null,
      surfaces: [],
      priorities: [],
      stage_order: [],
    });
  });

  it("presets name no organisation's surfaces", () => {
    for (const p of TASK_PRESETS) expect(p.draft.rows).toEqual([]);
  });
});

// PO-1234: Save is blocked with one plain message, never the server's.
describe("draftProblem", () => {
  const base = { ...TASK_PRESETS[1]!.draft };
  it("needs a prefix when numbering is on", () => {
    expect(draftProblem({ ...base, numbering: true, prefix: "" })).toMatch(/Pick a prefix/);
    expect(draftProblem({ ...base, numbering: true, prefix: "qa" })).toBeNull();
  });
  it("refuses a prefix the server would refuse, numbering on or off", () => {
    expect(draftProblem({ ...base, prefix: "Q" })).toMatch(/2–6 letters/);
    expect(draftProblem({ ...base, prefix: "1QA" })).toMatch(/starts with a letter/);
    expect(draftProblem(base)).toBeNull();
  });
});
