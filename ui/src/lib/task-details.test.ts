import { describe, it, expect } from "vitest";
import { currentStage, stageLabel, stageNamespace, stageOptions, withStage } from "./task-details";

describe("task details helpers", () => {
  it("finds the stage group from the rules, falling back to stage", () => {
    expect(stageNamespace({ default_stage_tag: "status:todo", exclusive_namespaces: ["x"] })).toBe("status");
    expect(stageNamespace({ default_stage_tag: null, exclusive_namespaces: ["phase"] })).toBe("phase");
    expect(stageNamespace(undefined)).toBe("stage");
  });

  it("reads the current stage whatever the tag's case or hash", () => {
    expect(currentStage(["projects", "#Stage:In-Review"], "stage")).toBe("in-review");
    expect(currentStage(["projects"], "stage")).toBeUndefined();
  });

  it("offers the nest's order first, then values in use, then the task's own", () => {
    const nest = [["stage:done"], ["stage:icebox", "x"], ["stage:backlog"]];
    expect(stageOptions({ stage_order: ["backlog", "done"] }, nest, "stage", "weird")).toEqual([
      "backlog",
      "done",
      "icebox",
      "weird",
    ]);
    expect(stageOptions(undefined, nest, "stage")).toEqual(["backlog", "done", "icebox"]);
  });

  it("a stage change replaces the group and keeps everything else, ticket included", () => {
    expect(withStage(["projects", "stage:in-review", "ticket:po-3"], "stage", "done")).toEqual([
      "projects",
      "ticket:po-3",
      "stage:done",
    ]);
    expect(withStage(["a", "stage:x", "stage:y"], "stage", null)).toEqual(["a"]);
  });

  it("labels a stage for people", () => {
    expect(stageLabel("in-review")).toBe("In review");
    expect(stageLabel("qa_staging")).toBe("Qa staging");
  });
});
