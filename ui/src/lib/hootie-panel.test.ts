import { describe, it, expect } from "vitest";
import {
  HOOTIE_PANEL_DEFAULT,
  HOOTIE_PANEL_MAX,
  HOOTIE_PANEL_MIN,
  citationKey,
  citedNodes,
  clampPanelWidth,
  hootieAccentStyle,
  linkCitations,
  resolveCitation,
  splitWikiLink,
  hootieGreeting,
  pushesContent,
  readableOn,
} from "./hootie-panel";

describe("Hootie side panel layout", () => {
  it("clamps the width between min and max, leaving room for the page", () => {
    expect(clampPanelWidth(100, 1600)).toBe(HOOTIE_PANEL_MIN);
    expect(clampPanelWidth(5000, 1600)).toBe(HOOTIE_PANEL_MAX);
    expect(clampPanelWidth(500, 1600)).toBe(500);
    // A narrow window keeps at least 480px of page visible.
    expect(clampPanelWidth(700, 1000)).toBe(520);
    expect(clampPanelWidth(Number.NaN, 1600)).toBe(HOOTIE_PANEL_DEFAULT);
  });

  it("pushes the page on wide screens and overlays on narrow ones", () => {
    expect(pushesContent(1440)).toBe(true);
    expect(pushesContent(1280)).toBe(true);
    expect(pushesContent(1024)).toBe(false);
    expect(pushesContent(390)).toBe(false);
  });
});

describe("Hootie branding in the panel", () => {
  it("uses only a #rrggbb accent, with a readable foreground", () => {
    expect(hootieAccentStyle("#1d4ed8")).toEqual({ backgroundColor: "#1d4ed8", color: "#ffffff" });
    // A bright blue reads better with black text (5.3:1 vs 3.9:1 for white).
    expect(hootieAccentStyle("#0a7cff")).toEqual({ backgroundColor: "#0a7cff", color: "#000000" });
    expect(hootieAccentStyle("#ffe600")).toEqual({ backgroundColor: "#ffe600", color: "#000000" });
    expect(hootieAccentStyle(null)).toBeNull();
    // Anything that isn't a normalised hex never reaches a style.
    expect(hootieAccentStyle("red")).toBeNull();
    expect(hootieAccentStyle("#fff")).toBeNull();
    expect(hootieAccentStyle("#000000;background:url(x)")).toBeNull();
  });

  it("picks black or white by contrast", () => {
    expect(readableOn("#000000")).toBe("#ffffff");
    expect(readableOn("#ffffff")).toBe("#000000");
  });

  it("greets with the admin's line, or 'Hi, I'm <name>'", () => {
    expect(hootieGreeting({ name: "Hootie", logo_url: null, accent_color: null, greeting: null })).toBe(
      "Hi, I'm Hootie",
    );
    expect(hootieGreeting({ name: "Ava", logo_url: null, accent_color: null, greeting: "  " })).toBe(
      "Hi, I'm Ava",
    );
    expect(
      hootieGreeting({ name: "Ava", logo_url: null, accent_color: null, greeting: "Welcome to Acme." }),
    ).toBe("Welcome to Acme.");
  });
});

// The same cases as the server's test/hootie-citations.test.ts — the panel
// and the server must resolve a [[link]] the same way.
const live = { id: "nodes/projects/nov/project-november-live-dashboard", title: "Project November — Live Dashboard" };
const plan = { id: "nodes/q3-plan", title: "Q3 Plan — Owner’s Review" };
const price = { id: "nodes/pricing", title: "Pricing “Draft” Notes" };
const runbookOps = { id: "nodes/ops/runbook", title: "Runbook" };
const runbookSales = { id: "nodes/sales/runbook", title: "Runbook" };
const nodes = [live, plan, price, runbookOps, runbookSales];

describe("Hootie citations — resolving [[X]] against the retrieved nodes", () => {
  it("normalises case, dash variants, quote variants and whitespace", () => {
    expect(citationKey("  Q3 Plan – Owner's   Review ")).toBe(citationKey("q3 plan — owner’s review"));
    expect(citationKey('Pricing "Draft" Notes')).toBe(citationKey("pricing “draft” notes"));
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

describe("Hootie answer text — every [[link]] renders", () => {
  const cite = (n: { id: string }) => `#cite:${encodeURIComponent(n.id)}`;

  it("a slug or id link becomes a chip labelled with the node's title", () => {
    expect(linkCitations("Open [[project-november-live-dashboard]].", [live])).toBe(
      `Open [Project November — Live Dashboard](${cite(live)}).`,
    );
    expect(linkCitations("Open [[nodes/q3-plan]].", [plan])).toBe(`Open [Q3 Plan — Owner’s Review](${cite(plan)}).`);
  });

  it("a near-title (case, dash, quote) becomes the same chip", () => {
    expect(linkCitations("[[q3 plan - owner's review]]", [plan])).toBe(`[Q3 Plan — Owner’s Review](${cite(plan)})`);
  });

  it("an alias is shown, its target resolved", () => {
    expect(linkCitations("[[q3-plan|the plan]]", [plan])).toBe(`[the plan](${cite(plan)})`);
  });

  it("an unresolved link is plain text: no brackets, nothing clickable", () => {
    expect(linkCitations("See [[Something not retrieved]].", [live])).toBe("See Something not retrieved.");
    expect(linkCitations("See [[Nope|that one]].", [])).toBe("See that one.");
    // Before the answer is done nothing is cited yet: still no raw brackets.
    expect(linkCitations("[[project-november-live-dashboard]]", undefined)).toBe("project-november-live-dashboard");
  });

  it("a title with markdown punctuation can't break out of the link label", () => {
    const odd = { id: "nodes/odd", title: "Odd ] [title](x) \\ name" };
    const out = linkCitations("[[odd]]", [odd]);
    expect(out).toBe(`[Odd \\] \\[title\\](x) \\\\ name](${cite(odd)})`);
  });

  it("leaves text without links untouched", () => {
    expect(linkCitations("Just **text** and [a link](https://x.y).", [live])).toBe(
      "Just **text** and [a link](https://x.y).",
    );
  });
});
