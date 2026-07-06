/**
 * Glossary definitions: the table-based ontology per nest. Terms (tags or
 * new vocabulary) get one articulated definition each, upserted case-
 * insensitively; GET ?term= is the real-time lookup for external runtimes.
 * Read tier can read, write tier defines.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let reader: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
  reader = await registerUser(app, "reader@acme.com", "Reader");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Quant" }, owner.apiKey);
  nestId = nest.data.nest.id;
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: reader.email, permission: "read" },
    owner.apiKey,
  );
});

afterAll(() => env.cleanup());

describe("definitions CRUD", () => {
  it("defines a term with a linked tag", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/definitions`,
      {
        term: "CAC",
        definition: "Customer acquisition cost: total S&M spend / new customers, trailing 90 days.",
        linked_tag: "gtm",
      },
      owner.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.definition.term).toBe("CAC");
    expect(res.data.definition.linked_tag).toBe("#gtm");
    expect(res.data.definition.defined_by).toBe(owner.email);
  });

  it("re-defining the same term (any case) updates in place", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/definitions`,
      { term: "cac", definition: "Updated articulation." },
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/definitions`, undefined, owner.apiKey);
    expect(list.data.count).toBe(1);
    expect(list.data.definitions[0].definition).toBe("Updated articulation.");
    // linked_tag was OMITTED in the redefine — it must survive, not clear.
    expect(list.data.definitions[0].linked_tag).toBe("#gtm");
  });

  it("explicit linked_tag: null clears it", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/definitions`,
      { term: "CAC", definition: "Updated articulation.", linked_tag: null },
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.definition.linked_tag).toBeNull();
  });

  it("400s (not 500s) on non-string fields", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/definitions`,
      { term: 123, definition: "x" },
      owner.apiKey,
    );
    expect(res.status).toBe(400);
  });

  it("rejects empty term or definition", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/definitions`,
      { term: "  ", definition: "" },
      owner.apiKey,
    );
    expect(res.status).toBe(400);
  });
});

describe("real-time lookup", () => {
  it("GET ?term= resolves case-insensitively for read-tier callers", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/definitions?term=CaC`,
      undefined,
      reader.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.definition.definition).toBe("Updated articulation.");
  });

  it("404s on an undefined term", async () => {
    const res = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/definitions?term=WACC`,
      undefined,
      reader.apiKey,
    );
    expect(res.status).toBe(404);
  });

  it("read-tier callers cannot define or delete", async () => {
    const post = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/definitions`,
      { term: "LTV", definition: "Lifetime value." },
      reader.apiKey,
    );
    expect(post.status).toBe(403);

    const list = await jsonRequest(app, "GET", `/nests/${nestId}/definitions`, undefined, owner.apiKey);
    const del = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/definitions/${list.data.definitions[0].id}`,
      undefined,
      reader.apiKey,
    );
    expect(del.status).toBe(403);
  });

  it("write tier can delete", async () => {
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/definitions`, undefined, owner.apiKey);
    const del = await jsonRequest(
      app,
      "DELETE",
      `/nests/${nestId}/definitions/${list.data.definitions[0].id}`,
      undefined,
      owner.apiKey,
    );
    expect(del.status).toBe(200);
    const after = await jsonRequest(app, "GET", `/nests/${nestId}/definitions`, undefined, owner.apiKey);
    expect(after.data.count).toBe(0);
  });
});

describe("edit by editing_id (rename in place)", () => {
  // Runs last: the glossary is empty here (prior block deleted everything).
  let fooId: string;
  let barId: string;

  beforeAll(async () => {
    const foo = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/definitions`,
      { term: "Foo", definition: "the foo." },
      owner.apiKey,
    );
    fooId = foo.data.definition.id;
    const bar = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/definitions`,
      { term: "Bar", definition: "the bar." },
      owner.apiKey,
    );
    barId = bar.data.definition.id;
  });

  it("renames a row in place without creating a duplicate", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/definitions`,
      { term: "Foobar", definition: "the foo, renamed.", editing_id: fooId },
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.definition.id).toBe(fooId);
    expect(res.data.definition.term).toBe("Foobar");
    const gone = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/definitions?term=Foo`,
      undefined,
      owner.apiKey,
    );
    expect(gone.status).toBe(404); // old name gone, not duplicated
  });

  it("409s (no data loss) when a rename collides with another row", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/definitions`,
      { term: "Bar", definition: "overwrite attempt.", editing_id: fooId },
      owner.apiKey,
    );
    expect(res.status).toBe(409);
    // Bar's original definition must be untouched.
    const bar = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/definitions?term=Bar`,
      undefined,
      owner.apiKey,
    );
    expect(bar.data.definition.id).toBe(barId);
    expect(bar.data.definition.definition).toBe("the bar.");
  });

  it("404s when editing_id points at no row in this nest", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/definitions`,
      { term: "Ghost", definition: "x", editing_id: "does-not-exist" },
      owner.apiKey,
    );
    expect(res.status).toBe(404);
  });
});
