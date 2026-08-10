/**
 * listNodesForCaller filters (CU — context_list convergence).
 *
 * These filters are shared with the engine's `context_list` via
 * `filterDocuments`, and three of them were quietly broken here beforehand:
 * `type` compared frontmatter literally so untyped documents never matched
 * `document`; `tag` compared a bare filter value against #-prefixed frontmatter
 * tags and so matched nothing at all; and there was no `status` filter.
 * `limit` also applied after the per-node enrichment rather than before it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import { listNodesForCallerByEmail } from "../src/nodes/service.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

const EMAIL = "alice@acme.com";

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, EMAIL, "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Filters" }, alice.apiKey);
  nestId = nest.data.nest.id;

  const make = (body: Record<string, unknown>) =>
    jsonRequest(app, "POST", `/nests/${nestId}/nodes`, body, alice.apiKey);

  // Plain documents carry no explicit `type:` — the case a literal comparison
  // used to skip.
  await make({ title: "Alpha Doc", content: "# Alpha", tags: ["api"] });
  await make({ title: "Beta Doc", content: "# Beta", tags: ["Ops"] });
  await make({ title: "Gamma Skill", content: "# Gamma", type: "skill" });
}, 30000);

afterAll(() => env.cleanup());

const list = (filters: Parameters<typeof listNodesForCallerByEmail>[2]) =>
  listNodesForCallerByEmail(nestId, EMAIL, filters);

describe("listNodesForCaller filters", () => {
  it("matches untyped documents against type:document", async () => {
    const titles = (await list({ type: "document" })).map((n) => n.title).sort();
    expect(titles).toEqual(["Alpha Doc", "Beta Doc"]);
  });

  it("still narrows to a non-default type", async () => {
    const titles = (await list({ type: "skill" })).map((n) => n.title);
    expect(titles).toEqual(["Gamma Skill"]);
  });

  it("accepts several types at once", async () => {
    expect(await list({ type: ["document", "skill"] })).toHaveLength(3);
  });

  it("matches a tag with or without its # and regardless of case", async () => {
    // Frontmatter stores "#api"; every one of these used to return nothing.
    for (const tag of ["api", "#api", "API", "#API"]) {
      const titles = (await list({ tag })).map((n) => n.title);
      expect(titles).toEqual(["Alpha Doc"]);
    }
  });

  it("matches a tag whose stored casing differs from the query", async () => {
    expect((await list({ tag: "ops" })).map((n) => n.title)).toEqual(["Beta Doc"]);
  });

  it("returns nothing for a tag no node carries", async () => {
    expect(await list({ tag: "nonexistent" })).toHaveLength(0);
  });

  it("filters by status, and an unmatched status returns nothing", async () => {
    const published = await list({ status: "published" });
    expect(published.length).toBeGreaterThan(0);
    // The filter has to actually narrow — before this existed the argument was
    // ignored, so every one of these came back with the full list.
    expect(await list({ status: "rejected" })).toHaveLength(0);
    expect(await list({ status: "pending_review" })).toHaveLength(0);
    // Aliases resolve to the same set as the canonical name.
    const viaAlias = await list({ status: "active" });
    expect(viaAlias.map((n) => n.id).sort()).toEqual(published.map((n) => n.id).sort());
  });

  it("applies limit to the returned set", async () => {
    expect(await list({ limit: 2 })).toHaveLength(2);
    expect(await list({ limit: 99 })).toHaveLength(3);
  });

  it("combines filters", async () => {
    const titles = (await list({ type: "document", tag: "api" })).map((n) => n.title);
    expect(titles).toEqual(["Alpha Doc"]);
  });

  it("approvedOnly serves each node at its approved version", async () => {
    const approved = await list({ approvedOnly: true });
    expect(approved.length).toBeGreaterThan(0);
    // This is the view a public nest gives a stranger: only nodes with an
    // approved version, each reported at that version rather than the live file.
    for (const n of approved) {
      expect(n.status).toBe("published");
      expect(n.version).toBeGreaterThanOrEqual(1);
      expect(n.content).toBeTruthy();
    }
  });
});

// ─── REST ────────────────────────────────────────────────────────────────────
//
// GET /nests/:id/nodes accepted no filters at all: callers fetched the whole
// nest and narrowed it client-side, paying the per-node governance enrichment
// for every document they then discarded.

describe("GET /nests/:id/nodes filters", () => {
  const get = (qs: string) =>
    jsonRequest(app, "GET", `/nests/${nestId}/nodes${qs}`, undefined, alice.apiKey);

  it("filters by type", async () => {
    const { status, data } = await get("?type=skill");
    expect(status).toBe(200);
    expect(data.nodes.map((n: any) => n.title)).toEqual(["Gamma Skill"]);
  });

  it("filters by tag, with or without the #", async () => {
    for (const q of ["?tag=api", "?tag=%23api"]) {
      const { data } = await get(q);
      expect(data.nodes.map((n: any) => n.title)).toEqual(["Alpha Doc"]);
    }
  });

  it("filters by status", async () => {
    const { data } = await get("?status=rejected");
    expect(data.nodes).toHaveLength(0);
  });

  it("applies limit, and reports the returned count", async () => {
    const { data } = await get("?limit=2");
    expect(data.nodes).toHaveLength(2);
    expect(data.count).toBe(2);
  });

  it("ignores a junk limit rather than failing the listing", async () => {
    const { status, data } = await get("?limit=abc");
    expect(status).toBe(200);
    expect(data.nodes.length).toBeGreaterThan(0);
  });

  it("returns everything when no filter is given", async () => {
    const { data } = await get("");
    expect(data.nodes).toHaveLength(3);
  });
});
