/**
 * Other side of nest-scoped key isolation (CU-wdqcq02xqt): a session and a
 * user-level key keep their full behavior on every route the nest-key guard
 * touches — keys CRUD, cross-nest search/stats/list, admin, teams, people, /me.
 * Its own app, so nothing a nest key attempts elsewhere can bleed in here.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

const OWNER_EMAIL = "owner@acme.com";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string; email: string };
let ownerCookie: string;
let nestA: string;
let nestB: string;
let nestKeyId: string;

async function cookieRequest(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: ownerCookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { ownerEmail: OWNER_EMAIL });
  owner = await registerUser(app, OWNER_EMAIL, "Owner");
  const login = await app.request("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: OWNER_EMAIL, password: "testpass" }),
  });
  ownerCookie = (login.headers.get("set-cookie") || "").split(";")[0];

  const a = await jsonRequest(app, "POST", "/nests", { name: "Nest A" }, owner.apiKey);
  nestA = a.data.nest.id;
  const b = await jsonRequest(app, "POST", "/nests", { name: "Nest B" }, owner.apiKey);
  nestB = b.data.nest.id;
  await jsonRequest(app, "POST", `/nests/${nestA}/nodes`,
    { title: "Widget Runbook", content: "# how to onboard a widget" }, owner.apiKey);
  await jsonRequest(app, "POST", `/nests/${nestB}/nodes`,
    { title: "Widget Pricing", content: "# pricing for the widget" }, owner.apiKey);
  // A nest key exists alongside — its presence must not narrow the owner.
  const minted = await jsonRequest(app, "POST", "/auth/keys",
    { label: "agent for A", nest_id: nestA }, owner.apiKey);
  nestKeyId = minted.data.id;
});

afterAll(() => env.cleanup());

describe("other side — user-level key and session keep full behavior", () => {
  for (const kind of ["user key", "session"] as const) {
    const call = (method: string, path: string, body?: unknown) =>
      kind === "user key"
        ? jsonRequest(app, method, path, body, owner.apiKey)
        : cookieRequest(method, path, body);

    describe(kind, () => {
      it("mints, lists and revokes keys", async () => {
        const minted = await call("POST", "/auth/keys", { label: `${kind} extra` });
        expect(minted.status).toBe(201);
        const list = await call("GET", "/auth/keys");
        expect(list.status).toBe(200);
        expect(list.data.keys.some((k: any) => k.id === minted.data.id)).toBe(true);
        // Scope is visible in the listing.
        expect(list.data.keys.find((k: any) => k.id === nestKeyId)?.nest_id).toBe(nestA);
        const rotated = await call("POST", "/auth/keys/rotate", { key_id: minted.data.id });
        expect(rotated.status).toBe(200);
        const del = await call("DELETE", `/auth/keys/${rotated.data.id}`);
        expect(del.status).toBe(200);
      });

      it("searches, counts and lists across every nest", async () => {
        const search = await call("GET", "/search?q=widget");
        expect(search.status).toBe(200);
        const nests = new Set(search.data.nodes.map((n: any) => n.nest_id));
        expect(nests.has(nestA) && nests.has(nestB)).toBe(true);
        const stats = await call("GET", "/stats");
        expect(stats.data.nests).toBe(2);
        const list = await call("GET", "/nests");
        const ids = list.data.nests.map((n: any) => n.id);
        expect(ids).toContain(nestA);
        expect(ids).toContain(nestB);
      });

      it("reaches admin, teams, people and /me routes", async () => {
        expect((await call("GET", "/admin/settings")).status).toBe(200);
        expect((await call("GET", "/admin/trace")).status).toBe(200);
        expect((await call("GET", "/teams")).status).toBe(200);
        expect((await call("GET", "/people/suggest?q=s")).status).toBe(200);
        expect((await call("GET", "/me/work")).status).toBe(200);
        expect((await call("GET", "/auth/teammates")).status).toBe(200);
        expect((await call("GET", `/nests/${nestB}`)).status).toBe(200);
      });
    });
  }
});
