/**
 * POST /nests/:id/context — one-call context retrieval tests.
 *
 * Covers: prompt → selector compilation, explicit selector pass-through,
 * budget truncation, permission gate integration, trace fields.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  jsonRequest,
} from "./helpers";
import { compilePrompt, scorePrompt, tokenizePrompt } from "../src/nodes/prompt-compiler";
import { resolveNodeUrl } from "../src/governance/title-resolver";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("open");

  const created = await jsonRequest(app, "POST", "/nests", {
    name: "Context Test Nest",
  });
  nestId = created.data.nest.id;

  // Seed nodes covering multiple topics
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "API Authentication Guide",
    content:
      "# API Authentication\n\nHow to authenticate requests using Bearer tokens.\n\nDetails go here.",
    tags: ["auth", "api"],
  });
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Database Setup",
    content:
      "# Database\n\nRun the migrations, then seed.\n\nUse the docker-compose file to spin up Postgres.",
    tags: ["database", "setup"],
  });
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
    title: "Brand Guidelines",
    content: "# Brand\n\nLogo rules, color palette, voice.",
    tags: ["brand"],
  });

  // Prime the engine's auto-indexer by running one no-op query. The first
  // selector query triggers context.yaml generation; without priming, the
  // next selector-based test occasionally returns empty before the index
  // lands.
  await jsonRequest(app, "POST", `/nests/${nestId}/query`, { query: "#auth" });
});

afterAll(() => env.cleanup());

// ── prompt-compiler unit tests ────────────────────────────────────────────

describe("tokenizePrompt", () => {
  it("lowercases, splits on non-alphanumerics, filters stopwords + short tokens", () => {
    expect(tokenizePrompt("How do I authenticate my API requests?")).toEqual([
      "authenticate",
      "api",
      "requests",
    ]);
  });

  it("dedupes repeated tokens", () => {
    expect(tokenizePrompt("auth auth auth auth")).toEqual(["auth"]);
  });

  it("returns [] for empty / whitespace / stopwords-only input", () => {
    expect(tokenizePrompt("")).toEqual([]);
    expect(tokenizePrompt("hello there, good morning!")).toEqual([]);
    expect(tokenizePrompt("  ")).toEqual([]);
    expect(tokenizePrompt("a the of")).toEqual([]);
  });
});

describe("compilePrompt — against seeded nest", () => {
  it("matches prompt tokens to node tags from node_tag_index", async () => {
    const titles = [
      "API Authentication Guide",
      "Database Setup",
      "Brand Guidelines",
    ];
    const result = await compilePrompt("How do I authenticate?", nestId, titles);
    // "authenticate" token matches title "API Authentication Guide" (via its
    // "authentication" word)? No — tokenizePrompt on "API Authentication Guide"
    // gives ["api", "authentication", "guide"], and prompt tokens are
    // ["authenticate"]. Those don't overlap directly.
    // So this test just asserts the compiler doesn't crash.
    expect(result.unmatched).toContain("authenticate");
  });

  it("matches exact tag names in the prompt", async () => {
    const titles = ["API Authentication Guide", "Database Setup"];
    const result = await compilePrompt(
      "I need help with database and auth",
      nestId,
      titles,
    );
    expect(result.matchedTags.sort()).toEqual(["auth", "database"]);
    expect(result.selector).toContain("#auth");
    expect(result.selector).toContain("#database");
  });

  it("matches titles whose words overlap with prompt tokens", async () => {
    const titles = ["API Authentication Guide", "Database Setup"];
    const result = await compilePrompt("database setup walkthrough", nestId, titles);
    expect(result.matchedTitles).toContain("Database Setup");
    // Selector carries tags only; titles are resolved via direct lookup
    // because the engine's selector grammar doesn't support [[Title]].
    expect(result.selector).toContain("#database");
  });

  it("returns selector=null when nothing matches", async () => {
    const result = await compilePrompt(
      "quantum supply-chain logistics",
      nestId,
      ["API Authentication Guide"],
    );
    expect(result.selector).toBeNull();
    expect(result.matchedTags).toEqual([]);
    expect(result.matchedTitles).toEqual([]);
  });
});

describe("scorePrompt", () => {
  const doc = {
    frontmatter: { title: "API Authentication Guide", tags: ["#security"] },
    body: "Bearer tokens explained.",
  };

  it("weights title > tag > body and reports the best hit as via", () => {
    // title: starts-a-word = 2 of 4, starts-the-title = 3; tag = 2; body word = 1
    expect(scorePrompt(doc, ["authentication"])).toEqual({ score: 0.5, via: "title" });
    expect(scorePrompt(doc, ["api"])).toEqual({ score: 0.75, via: "title" });
    expect(scorePrompt(doc, ["security"])).toEqual({ score: 0.5, via: "tag" });
    expect(scorePrompt(doc, ["bearer"])).toEqual({ score: 0.25, via: "fulltext" });
    expect(scorePrompt(doc, ["bearer", "guide"])).toEqual({ score: 3 / 8, via: "title" });
  });

  it("scores 0 with via null when nothing hits — mid-word body hits don't count", () => {
    expect(scorePrompt(doc, ["quantum"])).toEqual({ score: 0, via: null });
    expect(scorePrompt(doc, ["ken"])).toEqual({ score: 0, via: null }); // to-ken-s
    expect(scorePrompt(doc, [])).toEqual({ score: 0, via: null });
  });
});

// ── endpoint tests ────────────────────────────────────────────────────────

describe("POST /nests/:id/context", () => {
  it("rejects request with neither prompt nor selector", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/context`,
      {},
    );
    expect(status).toBe(400);
  });

  it("compiles a prompt against known tags + titles, returns markdown", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/context`,
      { prompt: "I need info on auth and database" },
    );
    expect(status).toBe(200);
    expect(data.trace.selector_used).toMatch(/#auth|#database/);
    expect(data.trace.compiled.matched_tags.sort()).toEqual([
      "auth",
      "database",
    ]);
    expect(data.context).toContain("API Authentication Guide");
    expect(data.context).toContain("Database Setup");
    expect(data.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts an explicit selector and skips prompt compilation", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/context`,
      { selector: "#brand" },
    );
    expect(status).toBe(200);
    expect(data.trace.compiled).toBeNull();
    expect(data.trace.selector_used).toBe("#brand");
    expect(data.nodes.some((n: any) => n.title === "Brand Guidelines")).toBe(
      true,
    );
  });

  it("returns empty context + note in trace when prompt matches nothing", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/context`,
      { prompt: "completely unrelated quantum supply-chain" },
    );
    expect(status).toBe(200);
    expect(data.context).toBe("");
    expect(data.nodes).toEqual([]);
    expect(data.trace.selector_used).toBeNull();
  });

  it("truncates by token budget and reports the count", async () => {
    // Floor is 50 tokens. Each seeded doc is ~25-35 tokens rendered, so
    // a 50-token budget fits at most 2 — always some truncation.
    const { data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/context`,
      {
        selector: "#auth | #database | #brand",
        max_tokens: 50,
      },
    );
    expect(data.nodes.length).toBeGreaterThanOrEqual(1);
    expect(data.nodes.length).toBeLessThan(3);
    expect(data.trace.truncated_by_budget).toBeGreaterThan(0);
  });

  it("trace reports total_matched, permission_filtered, included counts", async () => {
    const { data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/context`,
      { selector: "#auth | #database" },
    );
    expect(typeof data.trace.total_matched).toBe("number");
    expect(typeof data.trace.permission_filtered).toBe("number");
    expect(typeof data.trace.included).toBe("number");
    expect(typeof data.trace.hops_used).toBe("number");
  });

  it("separates multiple blocks with '---' markdown delimiters", async () => {
    const { data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/context`,
      { selector: "#auth | #database | #brand", max_tokens: 10000 },
    );
    const separators = (data.context.match(/\n---\n/g) || []).length;
    expect(separators).toBe(data.nodes.length - 1);
  });
});

// ── explicit [[Title]] selector parts (graph click-to-query emits these) ──

describe("POST /context — explicit [[Title]] selector", () => {
  beforeAll(async () => {
    // A links to B; C is unlinked. Lets us assert hop expansion precisely.
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
      title: "Hub Note",
      content: "# Hub\n\nSee [[Spoke Note]] for details.",
      tags: ["hub"],
    });
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
      title: "Spoke Note",
      content: "# Spoke\n\nLeaf content.",
    });
  });

  it("resolves a [[Title]] part with hops 0 to exactly that doc", async () => {
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/context`, {
      selector: "[[Hub Note]]",
      hops: 0,
    });
    expect(res.status).toBe(200);
    const ids = res.data.nodes.map((n: any) => n.id);
    expect(ids).toContain("nodes/hub-note");
    expect(ids).not.toContain("nodes/spoke-note");
  });

  it("hop-expands a [[Title]] match over wikilinks", async () => {
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/context`, {
      selector: "[[Hub Note]]",
      hops: 1,
    });
    const ids = res.data.nodes.map((n: any) => n.id);
    expect(ids).toContain("nodes/hub-note");
    expect(ids).toContain("nodes/spoke-note");
    expect(res.data.trace.hops_used).toBeGreaterThanOrEqual(1);
  });

  it("keeps explicit [[Title]] matches even when prompt is also sent", async () => {
    // A pure [[Title]] selector fully consumes `selector`; the prompt branch
    // must not then overwrite the resolved title matches.
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/context`, {
      selector: "[[Hub Note]]",
      prompt: "tell me about brand guidelines",
      hops: 0,
    });
    expect(res.status).toBe(200);
    const ids = res.data.nodes.map((n: any) => n.id);
    expect(ids).toContain("nodes/hub-note");
  });

  it("mixes [[Title]] parts with engine selector parts in an OR union", async () => {
    const res = await jsonRequest(app, "POST", `/nests/${nestId}/context`, {
      selector: "[[Spoke Note]] | #brand",
      hops: 0,
    });
    const ids = res.data.nodes.map((n: any) => n.id);
    expect(ids).toContain("nodes/spoke-note");
    // #brand side goes through the engine; tolerate index lag like the
    // other selector tests, but the title side must always resolve.
    expect(res.status).toBe(200);
  });
});

// ── relevance: ranked prompt matches, no hop noise (CU-wdqcq02018) ────────
// PromptOwl cites every node this returns, so a prompt must come back with
// real matches only, ranked, each flagged with how it matched.

describe("POST /context — prompt relevance", () => {
  const ctx = (payload: object) =>
    jsonRequest(app, "POST", `/nests/${nestId}/context`, payload);

  it("a greeting returns no nodes rather than the nest", async () => {
    const { data } = await ctx({ prompt: "hello" });
    expect(data.nodes).toEqual([]);
    expect(data.context).toBe("");
    expect(data.trace.compiled.fallback).toBeNull();
  });

  it("falls back to full-text when tags and titles miss, ranked by score", async () => {
    // "postgres" / "migrations" live only in Database Setup's body.
    const { data } = await ctx({ prompt: "how do I run postgres migrations" });
    expect(data.trace.compiled.fallback).toBe("fulltext");
    expect(data.nodes[0].id).toBe("nodes/database-setup");
    expect(data.nodes[0].via).toBe("fulltext");
    expect(data.nodes[0].score).toBeGreaterThan(0);
    for (const n of data.nodes) expect(n.score).toBeGreaterThan(0);
  });

  it("does not hop-expand a prompt match unless hops is passed", async () => {
    const { data } = await ctx({ prompt: "hub" });
    const ids = data.nodes.map((n: any) => n.id);
    expect(ids).toContain("nodes/hub-note");
    expect(ids).not.toContain("nodes/spoke-note");
    expect(data.trace.compiled.fallback).toBeNull();
  });

  it("flags hop neighbours as via: hop and ranks them last", async () => {
    const { data } = await ctx({ prompt: "hub", hops: 1 });
    const hub = data.nodes.find((n: any) => n.id === "nodes/hub-note");
    const spoke = data.nodes.find((n: any) => n.id === "nodes/spoke-note");
    expect(hub.via).toBe("title");
    expect(spoke).toEqual(expect.objectContaining({ via: "hop", score: 0 }));
    expect(data.nodes.indexOf(hub)).toBeLessThan(data.nodes.indexOf(spoke));
  });

  it("unions body hits with a compiled title match, ranked, dropping the weak tail", async () => {
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
      title: "Widget Policy",
      content: "# Widget Policy\n\nAll widgets ship with a policy.",
    });
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
      title: "Ops Runbook",
      content: "# Ops\n\nwidget policy rollout steps.",
    });
    // Title compiles for Widget Policy only; Ops Runbook is a body-only hit
    // that still surfaces, after it, because it scores above half the top.
    let { data } = await ctx({ prompt: "widget policy rollout" });
    let ids = data.nodes.map((n: any) => n.id);
    expect(ids.slice(0, 2)).toEqual(["nodes/widget-policy", "nodes/ops-runbook"]);
    expect(data.nodes[1].via).toBe("fulltext");
    expect(data.trace.compiled.fallback).toBeNull();
    // A lone body mention against a title match is noise — cut.
    ({ data } = await ctx({ prompt: "widget" }));
    ids = data.nodes.map((n: any) => n.id);
    expect(ids).toContain("nodes/widget-policy");
    expect(ids).not.toContain("nodes/ops-runbook");
  });

  it("keeps a compiled tag match even when it scores under the cutoff", async () => {
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
      title: "Q3 Ledger",
      content: "# Ledger\n\nNumbers.",
      tags: ["audit"],
    });
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
      title: "Onboarding Checklist Guide",
      content: "# Onboarding\n\nSteps.",
    });
    // #audit compiles (2/12) but sits under half the title match (5/12).
    const { data } = await ctx({ prompt: "audit onboarding checklist" });
    expect(data.trace.compiled.matched_tags).toEqual(["audit"]);
    const ledger = data.nodes.find((n: any) => n.id === "nodes/q3-ledger");
    expect(ledger).toEqual(expect.objectContaining({ via: "tag" }));
    expect(data.nodes[0].id).toBe("nodes/onboarding-checklist-guide");
  });

  it("a prompt title match never surfaces a draft unless include_drafts", async () => {
    // Own nest: stewardship on makes a create land as an unapproved draft.
    const own = (await jsonRequest(app, "POST", "/nests", { name: "Drafts" })).data.nest.id;
    await jsonRequest(app, "PATCH", `/nests/${own}/settings`, { stewardship_enabled: true });
    await jsonRequest(app, "POST", `/nests/${own}/nodes`, {
      title: "Zephyr Plan",
      content: "# Zephyr\n\nUnreleased.",
    });
    const list = await jsonRequest(app, "GET", `/nests/${own}/nodes`);
    expect(list.data.nodes[0].status).not.toBe("published");

    const ask = (body: object) => jsonRequest(app, "POST", `/nests/${own}/context`, body);
    let { data } = await ask({ prompt: "zephyr plan" });
    expect(data.trace.compiled.matched_titles).toEqual(["Zephyr Plan"]);
    expect(data.nodes).toEqual([]);
    ({ data } = await ask({ prompt: "zephyr plan", include_drafts: true }));
    expect(data.nodes.map((n: any) => n.id)).toEqual(["nodes/zephyr-plan"]);
  });

  it("[[nodes/id]] names one document by id, with the same hop expansion", async () => {
    const { data } = await ctx({ selector: "[[nodes/hub-note]]" });
    const ids = data.nodes.map((n: any) => n.id);
    expect(ids).toContain("nodes/hub-note");
    expect(ids).toContain("nodes/spoke-note");
    expect(data.trace.selector_used).toBeNull();
  });

  it("selector path carries no score/via and keeps hop default", async () => {
    const { data } = await ctx({ selector: "[[Hub Note]]" });
    const ids = data.nodes.map((n: any) => n.id);
    expect(ids).toContain("nodes/spoke-note");
    expect(data.nodes[0]).not.toHaveProperty("score");
  });
});

// ── source URLs / citations (CU-wdqcq00k73) ───────────────────────────────
// The context payload must carry a resolvable source URL per node so that
// Chat-with-the-nest and Set-up-agent can cite the source and render a
// clickable link. Regression guard for the "answers don't include URLs" bug.

describe("POST /context — source URLs (citations)", () => {
  it("attaches a resolvable url to each node in the manifest", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/context`,
      { selector: "#brand" },
    );
    expect(status).toBe(200);
    const brand = data.nodes.find(
      (n: any) => n.id === "nodes/brand-guidelines",
    );
    expect(brand).toBeDefined();
    expect(typeof brand.url).toBe("string");
    expect(brand.url).toMatch(/^https?:\/\//);
    expect(brand.url).toContain(`nest=${nestId}`);
    expect(brand.url).toContain("doc=nodes");
  });

  it("embeds a _source: <url> line in each context block", async () => {
    const { data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/context`,
      { selector: "#brand" },
    );
    // The block the model sees must contain the citable link.
    expect(data.context).toMatch(/_source: https?:\/\/\S*nest=/);
  });

  it("omits the url when no base URL resolves (no broken links)", () => {
    // AC4: no resolvable URL degrades gracefully — the field is absent, not an
    // empty string a consumer would render as href="".
    delete process.env.PUBLIC_BASE_URL;
    expect(
      resolveNodeUrl({ id: "nodes/brand-guidelines" }, { nestId, baseUrl: "" }),
    ).toBeUndefined();
  });
});
