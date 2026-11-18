import { describe, it, expect } from "vitest";
import {
  BLANK_RECIPE_ID,
  HARNESS_CHOICES,
  appliedSummary,
  orderedRecipes,
  recipeParam,
  recipeSummary,
  stageLabel,
  type Recipe,
} from "./recipes";

const recipe = (over: Partial<Recipe> & { id: string }): Recipe => ({
  name: over.id,
  purpose: "p",
  description: null,
  version: 1,
  source: "bundled",
  gets: { folders: [], documents: [], instructions: false, definitions: 0, boards: [], channels: [], agents: [], distill: false },
  ...over,
});

describe("stageLabel", () => {
  it("turns a stage slug into a heading", () => {
    expect(stageLabel("red-team")).toBe("Red team");
    expect(stageLabel("prd")).toBe("PRD");
    expect(stageLabel("smoke-eval")).toBe("Smoke eval");
    expect(stageLabel("in-progress")).toBe("In progress");
  });
});

describe("recipeSummary (AC8, AC9: what you get on the card)", () => {
  it("board with its stage count, documents, channels, agents", () => {
    const r = recipe({
      id: "product-factory",
      gets: {
        folders: ["specs/"],
        documents: ["Runbook", "Thesis"],
        instructions: true,
        definitions: 4,
        boards: [{ name: "Build pipeline", stages: ["a", "b", "c"] }],
        channels: [{ name: "builds", purpose: "x" }],
        agents: [{ kind: "key", handle: "builder", why: "w", channels: [] }],
        distill: true,
      },
    });
    expect(recipeSummary(r)).toEqual(["Build pipeline board, 3 stages", "3 starter documents", "1 channel", "1 agent to hire"]);
  });
  it("Blank says it adds nothing", () => {
    expect(recipeSummary(recipe({ id: BLANK_RECIPE_ID }))).toEqual(["Nothing added. Start from an empty nest."]);
  });
});

describe("ordering and the create parameter", () => {
  it("Blank goes last; Blank sends no recipe", () => {
    expect(orderedRecipes([recipe({ id: "blank" }), recipe({ id: "a" }), recipe({ id: "b" })]).map((r) => r.id)).toEqual(["a", "b", "blank"]);
    expect(recipeParam("blank")).toBeUndefined();
    expect(recipeParam(null)).toBeUndefined();
    expect(recipeParam("ideation")).toBe("ideation");
  });
});

describe("appliedSummary", () => {
  it("counts what was made and says when channels were skipped", () => {
    const s = appliedSummary(
      {
        id: "ops",
        status: "applied",
        drafts: 0,
        suggested_agents: [],
        items: [
          { kind: "folder", target: "a/", action: "created" },
          { kind: "context", target: "CONTEXT.md", action: "created" },
          { kind: "node", target: "nodes/x", action: "created" },
          { kind: "board", target: "B", action: "created" },
          { kind: "channel", target: "ops", action: "skipped", note: "off" },
        ],
      },
      "Operations",
    );
    expect(s).toBe("Operations is set up: 2 documents, 1 board. Channels were skipped because team chat is off.");
  });
  it("a failed apply says the nest is empty", () => {
    expect(appliedSummary({ id: "x", status: "failed", items: [], drafts: 0, suggested_agents: [], error: "boom" }, "X")).toMatch(/could not be applied: boom/);
  });
  it("nothing to say without a result", () => {
    expect(appliedSummary(null, "X")).toBeNull();
  });
});

describe("HARNESS_CHOICES (AC8, AC9: the three harness options)", () => {
  it("Local, Central lite, Central durable; only Local is available until the deploy bundle ships", () => {
    expect(HARNESS_CHOICES.map((h) => h.id)).toEqual(["local", "central-lite", "central-durable"]);
    expect(HARNESS_CHOICES.filter((h) => h.available).map((h) => h.id)).toEqual(["local"]);
  });
});
