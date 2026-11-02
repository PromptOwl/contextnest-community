/**
 * How Hootie resolves a `[[X]]` in an answer to one of the retrieved nodes
 * (server side, src/hootie/citations.ts). The panel has the same rules in
 * ui/src/lib/hootie-panel.ts, tested with the same cases in
 * ui/src/lib/hootie-panel.test.ts — keep the two in step.
 */
import { describe, it, expect } from "vitest";
import {
  citationKey,
  citedNodes,
  resolveCitation,
  splitWikiLink,
} from "../src/hootie/citations.js";

const live = { id: "nodes/projects/nov/project-november-live-dashboard", title: "Project November — Live Dashboard" };
const plan = { id: "nodes/q3-plan", title: "Q3 Plan — Owner’s Review" };
const price = { id: "nodes/pricing", title: "Pricing “Draft” Notes" };
const runbookOps = { id: "nodes/ops/runbook", title: "Runbook" };
const runbookSales = { id: "nodes/sales/runbook", title: "Runbook" };
const nodes = [live, plan, price, runbookOps, runbookSales];

describe("Hootie citations — resolving [[X]] against the retrieved nodes", () => {
  it("normalises case, dash variants, quote variants and whitespace", () => {
    expect(citationKey("  Q3 Plan – Owner's   Review ")).toBe(citationKey("q3 plan — owner’s review"));
    expect(citationKey("Pricing \"Draft\" Notes")).toBe(citationKey("pricing “draft” notes"));
    expect(citationKey("a‐b‑c−d")).toBe("a-b-c-d");
  });

  it("matches an exact title, the full id, or the id's last segment (slug)", () => {
    expect(resolveCitation("Project November — Live Dashboard", nodes)).toBe(live);
    expect(resolveCitation("project november - live dashboard", nodes)).toBe(live);
    expect(resolveCitation("nodes/projects/nov/project-november-live-dashboard", nodes)).toBe(live);
    expect(resolveCitation("project-november-live-dashboard", nodes)).toBe(live);
    expect(resolveCitation("Q3 Plan - Owner's Review", nodes)).toBe(plan);
    expect(resolveCitation('PRICING "DRAFT" NOTES', nodes)).toBe(price);
  });

  it("resolves nothing that isn't retrieved", () => {
    expect(resolveCitation("Something not retrieved", nodes)).toBeUndefined();
    expect(resolveCitation("", nodes)).toBeUndefined();
    expect(resolveCitation("nodes/projects/nov", nodes)).toBeUndefined();
  });

  it("a shared title resolves to the first node in retrieval order, and a title beats another node's slug", () => {
    expect(resolveCitation("Runbook", nodes)).toBe(runbookOps);
    // "runbook" is also both runbooks' slug: still the first one.
    expect(resolveCitation("runbook", [runbookSales, runbookOps])).toBe(runbookSales);
    const titled = { id: "nodes/other", title: "pricing" };
    expect(resolveCitation("pricing", [price, titled])).toBe(titled);
  });

  it("splits [[target|alias]] — resolve the target, show the alias", () => {
    expect(splitWikiLink("q3-plan|the plan")).toEqual({ target: "q3-plan", label: "the plan" });
    expect(splitWikiLink(" Runbook ")).toEqual({ target: "Runbook", label: null });
    expect(splitWikiLink("Runbook| ")).toEqual({ target: "Runbook", label: null });
  });

  it("lists cited nodes in order of first mention, each once", () => {
    const answer =
      "See [[project-november-live-dashboard]], then [[q3 plan - owner's review|the plan]], " +
      "[[nodes/projects/nov/project-november-live-dashboard]] again, [[Nope]] and [[Runbook]].";
    expect(citedNodes(answer, nodes)).toEqual([live, plan, runbookOps]);
    expect(citedNodes("no links here", nodes)).toEqual([]);
  });
});
