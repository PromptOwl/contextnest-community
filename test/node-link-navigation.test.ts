/**
 * A browser opening a node's API URL lands on the app's document page instead
 * of raw JSON — including the common pasted form that drops the `nodes/` id
 * prefix (CU-wdqcq05rah). API callers keep getting JSON.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;
const ID = "nodes/governed/log/weekly-sync";

const navigate = (path: string) =>
  app.request(`http://localhost${path}`, {
    headers: {
      Authorization: `Bearer ${alice.apiKey}`,
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Dest": "document",
      Accept: "text/html",
    },
  });

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Links" }, alice.apiKey);
  nestId = nest.data.nest.id;
  const created = await jsonRequest(
    app, "POST", `/nests/${nestId}/nodes`,
    { title: "Weekly Sync", content: "# Sync", folder: "governed/log" },
    alice.apiKey,
  );
  expect(created.data.node.id).toBe(ID);
});

afterAll(() => env.cleanup());

const docUrl = (id: string) => `/nest/${nestId}?${new URLSearchParams({ doc: id })}`;

describe("browser navigation to a node API URL", () => {
  it("redirects the full id to the document page", async () => {
    const res = await navigate(`/nests/${nestId}/nodes/${ID}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(docUrl(ID));
  });

  it("resolves an id missing the nodes/ prefix", async () => {
    const res = await navigate(`/nests/${nestId}/nodes/governed/log/weekly-sync`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(docUrl(ID));
  });

  it("leaves an unknown id to the API's 404", async () => {
    const res = await navigate(`/nests/${nestId}/nodes/governed/log/nope`);
    expect(res.status).toBe(404);
  });

  it("leaves suffix routes and explicit formats alone", async () => {
    expect((await navigate(`/nests/${nestId}/nodes/${ID}/versions`)).status).toBe(200);
    const raw = await navigate(`/nests/${nestId}/nodes/${ID}?format=raw`);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toContain("# Sync");
  });

  it("still answers API fetches with JSON", async () => {
    const res = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${ID}`, undefined, alice.apiKey);
    expect(res.status).toBe(200);
    expect(res.data.node.id).toBe(ID);
  });
});
