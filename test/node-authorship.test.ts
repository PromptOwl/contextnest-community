/**
 * Author + collaborators on the node list and detail responses
 * (CU-wdqcpzw7hg): `author` = creator (frontmatter author, else the first
 * version's author), `collaborators` = distinct version authors UNION
 * document-scope grant holders, minus the author, sorted. Additive fields —
 * nothing else in the response shape changes.
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
let alice: { apiKey: string; userId: string; email: string }; // creator/owner
let bob: { apiKey: string; userId: string; email: string }; // edits the doc
let carol: { apiKey: string; userId: string; email: string }; // doc grant only
let nestId: string;

const DOC = "nodes/team-doc";
const SOLO = "nodes/solo-doc";

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "a-alice@acme.com", "Alice");
  bob = await registerUser(app, "b-bob@acme.com", "Bob");
  carol = await registerUser(app, "c-carol@acme.com", "Carol");

  const nest = await jsonRequest(app, "POST", "/nests", { name: "Authorship" }, alice.apiKey);
  nestId = nest.data.nest.id;

  // Doc A creates, B edits, C holds a document-scope grant.
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`,
    { title: "Team Doc", content: "# team" }, alice.apiKey);
  // A second doc only Alice ever touched — no collaborators expected.
  await jsonRequest(app, "POST", `/nests/${nestId}/nodes`,
    { title: "Solo Doc", content: "# solo" }, alice.apiKey);

  // Bob becomes a nest-wide write collaborator, then edits the team doc.
  const collab = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`,
    { email: bob.email, permission: "write" }, alice.apiKey);
  expect([200, 201]).toContain(collab.status);
  const edit = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${DOC}`,
    { append: "edited by bob" }, bob.apiKey);
  expect(edit.status).toBe(200);

  // Carol gets a document-scope grant on the team doc only.
  const grant = await jsonRequest(app, "POST", `/nests/${nestId}/grants`,
    { target_type: "document", target: DOC, email: carol.email, role: "read" },
    alice.apiKey);
  expect(grant.status).toBe(201);
});

afterAll(() => env.cleanup());

describe("node LIST response", () => {
  it("carries author (creator) + collaborators (editors ∪ grantees, minus author, sorted)", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, alice.apiKey);
    expect(res.status).toBe(200);

    const team = res.data.nodes.find((n: any) => n.id === DOC);
    expect(team).toBeDefined();
    expect(team.author).toBe(alice.email);
    // Bob (edited a version) ∪ Carol (document grant), sorted, Alice excluded.
    expect(team.collaborators).toEqual([bob.email, carol.email]);
    expect(team.collaborators).not.toContain(alice.email);
  });

  it("a doc with a single author and no grants has empty collaborators", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, alice.apiKey);
    const solo = res.data.nodes.find((n: any) => n.id === SOLO);
    expect(solo).toBeDefined();
    expect(solo.author).toBe(alice.email);
    expect(solo.collaborators).toEqual([]);
  });

  it("existing response shape is intact (additive fields only)", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, alice.apiKey);
    expect(res.data.count).toBe(res.data.nodes.length);
    const team = res.data.nodes.find((n: any) => n.id === DOC);
    for (const key of ["id", "title", "type", "tags", "status", "version", "content"]) {
      expect(team).toHaveProperty(key);
    }
  });

  it("a grant-only caller (below nest-read) still gets sane fields on the docs they see", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, carol.apiKey);
    expect(res.status).toBe(200);
    // Grant scoping unchanged: exactly the granted doc, nothing else.
    expect(res.data.nodes.map((n: any) => n.id)).toEqual([DOC]);
    const team = res.data.nodes[0];
    expect(team.author).toBe(alice.email);
    expect(team.collaborators).toEqual([bob.email, carol.email]);
  });
});

describe("node DETAIL response", () => {
  it("carries the same author + collaborators fields", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${DOC}`, undefined, alice.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.node.author).toBe(alice.email);
    expect(res.data.node.collaborators).toEqual([bob.email, carol.email]);
    expect(res.data.node.collaborators).not.toContain(alice.email);
  });

  it("solo doc detail: author set, collaborators empty", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${SOLO}`, undefined, alice.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.node.author).toBe(alice.email);
    expect(res.data.node.collaborators).toEqual([]);
  });

  it("grant-only caller sees the fields on the granted doc", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${DOC}`, undefined, carol.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.node.author).toBe(alice.email);
    expect(res.data.node.collaborators).toEqual([bob.email, carol.email]);
  });
});

/**
 * The roster is the nest's people, not its published content. A public
 * reader reaches the nest only via visibility='public' — they get the
 * approved body, but must not learn who edited it or who holds a grant on
 * it. `author` stays frontmatter-only for them, exactly as before this
 * feature; `collaborators` is withheld entirely.
 */
describe("public reader", () => {
  let pubNest: string;
  // Carol is the outsider here: she holds a grant on the *private* nest
  // above, but has no relationship to this one, so `visibility: public` is
  // her only way in. (Registering a fourth user would trip the auth
  // rate limiter — 3 registrations per window.)

  beforeAll(async () => {
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Public" }, alice.apiKey);
    pubNest = nest.data.nest.id;
    await jsonRequest(app, "POST", `/nests/${pubNest}/nodes`,
      { title: "Team Doc", content: "# team" }, alice.apiKey);

    // Bob edits it, so there IS a collaborator to leak.
    await jsonRequest(app, "POST", `/nests/${pubNest}/collaborators`,
      { email: bob.email, permission: "write" }, alice.apiKey);
    const edit = await jsonRequest(app, "PATCH", `/nests/${pubNest}/nodes/${DOC}`,
      { append: "edited by bob" }, bob.apiKey);
    expect(edit.status).toBe(200);

    const vis = await jsonRequest(app, "PATCH", `/nests/${pubNest}/visibility`,
      { visibility: "public" }, alice.apiKey);
    expect(vis.status).toBe(200);

    // Guard the setup: Bob must actually be a collaborator on this doc, or
    // the assertions below would pass against an empty roster.
    const owner = await jsonRequest(app, "GET", `/nests/${pubNest}/nodes/${DOC}`, undefined, alice.apiKey);
    expect(owner.data.node.collaborators).toEqual([bob.email]);
  });

  it("LIST withholds collaborators and does not fall back to a version author", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${pubNest}/nodes`, undefined, carol.apiKey);
    expect(res.status).toBe(200);
    const team = res.data.nodes.find((n: any) => n.id === DOC);
    expect(team).toBeDefined();
    expect(team.collaborators).toBeUndefined();
    expect(JSON.stringify(team)).not.toContain(bob.email);
  });

  it("DETAIL withholds collaborators", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${pubNest}/nodes/${DOC}`, undefined, carol.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.node.collaborators).toBeUndefined();
    expect(JSON.stringify(res.data.node)).not.toContain(bob.email);
  });

  it("the owner still sees the roster on the same public nest", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${pubNest}/nodes/${DOC}`, undefined, alice.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.node.collaborators).toEqual([bob.email]);
  });
});
