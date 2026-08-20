/**
 * GET /search — full-text search across every nest the caller can see. The
 * security-critical property is the negative: a nest you have no access to
 * never contributes a hit, however well it matches.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let outsider: { apiKey: string; userId: string; email: string };
let nestA: string;
let nestB: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  outsider = await registerUser(app, "outsider@acme.com", "Outsider");

  const a = await jsonRequest(app, "POST", "/nests", { name: "Nest A" }, owner.apiKey);
  nestA = a.data.nest.id;
  const b = await jsonRequest(app, "POST", "/nests", { name: "Nest B" }, owner.apiKey);
  nestB = b.data.nest.id;

  await jsonRequest(
    app,
    "POST",
    `/nests/${nestA}/nodes`,
    { title: "Onboarding Runbook", content: "# how to onboard a widget" },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestB}/nodes`,
    { title: "Widget Pricing", content: "# pricing for the widget" },
    owner.apiKey,
  );
});

afterAll(() => env.cleanup());

describe("GET /search", () => {
  it("returns hits from every nest the caller can see, stamped with the nest", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      "/search?q=widget",
      undefined,
      owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.count).toBe(2);
    expect(new Set(data.nodes.map((n: any) => n.nest_id))).toEqual(
      new Set([nestA, nestB]),
    );
    expect(new Set(data.nodes.map((n: any) => n.nest_name))).toEqual(
      new Set(["Nest A", "Nest B"]),
    );
  });

  it("finds a rejected document, which the nest's own list also shows", async () => {
    // Engine discovery drops status:rejected by default — right for retrieval,
    // wrong here: this app keeps unpublished work in the node list, so a doc
    // that is plainly visible in the nest must not be unfindable by search.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestA}/nodes`,
      // Deliberately free of "widget" — the limit cases below count those hits.
      { title: "Retired Note", content: "# an old note", status: "rejected" },
      owner.apiKey,
    );

    const list = await jsonRequest(app, "GET", `/nests/${nestA}/nodes`, undefined, owner.apiKey);
    expect(list.data.nodes.map((n: any) => n.id)).toContain("nodes/retired-note");

    for (const path of [`/nests/${nestA}/search?q=retired`, "/search?q=retired"]) {
      const { data } = await jsonRequest(app, "GET", path, undefined, owner.apiKey);
      expect(data.nodes.map((n: any) => n.id)).toEqual(["nodes/retired-note"]);
    }
  });

  it("matches title, body and tags with every term required", async () => {
    const { data } = await jsonRequest(
      app,
      "GET",
      "/search?q=widget%20pricing",
      undefined,
      owner.apiKey,
    );
    expect(data.nodes.map((n: any) => n.title)).toEqual(["Widget Pricing"]);
  });

  it("includes nests the caller only reads as a public Viewer", async () => {
    // A public nest is reached by visibility alone — no collaborator or steward
    // row — so it was the one readable category global search used to skip.
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestB}/visibility`,
      { visibility: "public" },
      owner.apiKey,
    );
    const direct = await jsonRequest(
      app,
      "GET",
      `/nests/${nestB}/nodes/nodes/widget-pricing`,
      undefined,
      outsider.apiKey,
    );
    expect(direct.status).toBe(200);

    const { data } = await jsonRequest(
      app,
      "GET",
      "/search?q=widget",
      undefined,
      outsider.apiKey,
    );
    expect(data.nodes.map((n: any) => n.nest_id)).toEqual([nestB]);

    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestB}/visibility`,
      { visibility: "private" },
      owner.apiKey,
    );
  });

  it("never returns documents from nests the caller can't see", async () => {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      "/search?q=widget",
      undefined,
      outsider.apiKey,
    );
    expect(status).toBe(200);
    expect(data.count).toBe(0);
  });

  // Runs after the "can't see" case above: it hands the outsider a grant, and
  // the point of that case is an outsider with nothing at all.
  it("includes a nest the caller only holds a document grant on", async () => {
    // A doc/folder grantee has no collaborator or steward row, so the nest was
    // absent from the search fan-out — while the doc opened fine by direct link.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestA}/grants`,
      {
        target_type: "document",
        target: "nodes/onboarding-runbook",
        email: outsider.email,
        role: "read",
      },
      owner.apiKey,
    );

    const { data } = await jsonRequest(
      app,
      "GET",
      "/search?q=widget",
      undefined,
      outsider.apiKey,
    );
    // Exactly the granted doc: nest B never contributes, and nest A's other
    // documents stay behind the grant.
    expect(data.nodes.map((n: any) => n.id)).toEqual(["nodes/onboarding-runbook"]);
  });

  it("ranks a title match above body matches, whatever the discovery order", async () => {
    // Both in one nest so nest ordering can't carry the test: "Alpha Note"
    // sorts first on disk and only mentions the term in its body, while the
    // document actually called "Beacon" would trail it — and fall off the end
    // once the result cap bites. Neither title carries "widget"/"retired", so
    // the count assertions elsewhere in this file stay put.
    for (const [title, content] of [
      ["Alpha Note", "# the beacon shines here"],
      ["Beacon", "# short"],
    ] as const) {
      await jsonRequest(
        app,
        "POST",
        `/nests/${nestA}/nodes`,
        { title, content },
        owner.apiKey,
      );
    }

    for (const path of [`/nests/${nestA}/search?q=beacon`, "/search?q=beacon"]) {
      const { data } = await jsonRequest(app, "GET", path, undefined, owner.apiKey);
      expect(data.nodes.map((n: any) => n.title)).toEqual(["Beacon", "Alpha Note"]);
    }
  });

  it("ranks a title match that starts a word above one buried inside a word", async () => {
    // Matching is plain substring, so "Latest" contains "test" — a title that
    // never mentions the concept used to tie with the document named for it.
    // "Track…" sorts before "Zeta…" on disk, so discovery order alone would
    // put the buried match first — only the word-start tier can flip it.
    for (const title of ["Track the Latest Engine", "Zeta Test Plan"]) {
      await jsonRequest(
        app,
        "POST",
        `/nests/${nestA}/nodes`,
        { title, content: "# no keyword in the body" },
        owner.apiKey,
      );
    }

    const { data } = await jsonRequest(
      app,
      "GET",
      "/search?q=test",
      undefined,
      owner.apiKey,
    );
    expect(data.nodes.map((n: any) => n.title)).toEqual([
      "Zeta Test Plan",
      "Track the Latest Engine",
    ]);
  });

  it("requires q, whitespace included", async () => {
    for (const path of ["/search", "/search?q=", "/search?q=%20%20"]) {
      const { status } = await jsonRequest(app, "GET", path, undefined, owner.apiKey);
      expect(status).toBe(400);
    }
  });

  it("caps the result count at the requested limit", async () => {
    const { data } = await jsonRequest(
      app,
      "GET",
      "/search?q=widget&limit=1",
      undefined,
      owner.apiKey,
    );
    // count reports everything found; nodes carries the capped page.
    expect(data.count).toBe(2);
    expect(data.nodes).toHaveLength(1);
  });

  it("clamps a limit outside [1,50] instead of honouring it", async () => {
    // Above the ceiling: capped at 50, so both hits still come back.
    const high = await jsonRequest(
      app,
      "GET",
      "/search?q=widget&limit=1000",
      undefined,
      owner.apiKey,
    );
    expect(high.data.nodes).toHaveLength(2);

    // Zero and junk fall back to the default page size rather than returning
    // nothing — a search that answers with an empty list is never what a
    // caller meant by limit=0.
    for (const limit of ["0", "abc"]) {
      const { data } = await jsonRequest(
        app,
        "GET",
        `/search?q=widget&limit=${limit}`,
        undefined,
        owner.apiKey,
      );
      expect(data.nodes).toHaveLength(2);
    }

    // A negative number is a real number, so it clamps to the floor of 1
    // rather than falling back to the default.
    const negative = await jsonRequest(
      app,
      "GET",
      "/search?q=widget&limit=-5",
      undefined,
      owner.apiKey,
    );
    expect(negative.data.nodes).toHaveLength(1);
  });
});
