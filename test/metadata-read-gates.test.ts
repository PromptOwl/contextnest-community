/**
 * Metadata endpoints must not describe documents the caller cannot read.
 *
 * Three read paths handed out facts about restricted documents to a caller
 * who could not open them — a public reader of a governed nest, here:
 *  - `GET /comment-counts` returned the node id (and comment activity) of
 *    every annotated document, drafts included;
 *  - `GET /folders` and the census folder tree listed every folder on disk,
 *    so a folder holding only unapproved drafts still showed its name, and
 *    the per-folder counts included documents the caller could not see;
 *  - `context_stewards` by title (MCP) and `GET /nodes/:id/stewards` (REST)
 *    resolved a restricted document and returned its stewards' emails.
 *
 * A restricted document must look exactly like a missing one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

type User = { apiKey: string; userId: string; email: string };

const SECRET_ID = "nodes/secret/plans/secret-plan";
const STEWARD_EMAIL = "secret.steward@corp.test";
const NEST_STEWARD_EMAIL = "nest.steward@corp.test";

async function mcpTool(
  app: any,
  nestId: string,
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const ct = res.headers.get("content-type") || "";
  let body: any;
  if (ct.includes("application/json")) body = await res.json();
  else {
    const raw = await res.text();
    const dataLine = raw.split("\n").find((l: string) => l.startsWith("data: "));
    body = dataLine ? JSON.parse(dataLine.slice("data: ".length)) : raw;
  }
  if (body?.error) return { text: String(body.error.message ?? ""), isError: true };
  const text = (body?.result?.content ?? []).map((c: any) => c.text).join("");
  return { text, isError: body?.result?.isError === true };
}

describe("metadata read gates — public reader of a governed nest", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: User;
  let outsider: User;
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@corp.test", "Owner");
    outsider = await registerUser(app, "outsider@example.com", "Outsider");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Gated Meta" }, owner.apiKey);
    nestId = nest.data.nest.id;

    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { stewardship_enabled: true, allow_self_approve: true },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "public", acknowledge_public: true },
      owner.apiKey,
    );

    // Approved: visible to the public reader.
    const open = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Open Plan", folder: "plans", content: "Public roadmap." },
      owner.apiKey,
    );
    expect(open.status, JSON.stringify(open.data)).toBe(201);

    // From here on nothing is approved: these stay drafts the public reader
    // must not learn about.
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/settings`,
      { allow_self_approve: false },
      owner.apiKey,
    );
    const secret = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Secret Plan", folder: "secret/plans", content: "Acquisition target." },
      owner.apiKey,
    );
    expect(secret.status, JSON.stringify(secret.data)).toBe(201);
    expect(secret.data.node?.id ?? secret.data.id).toBe(SECRET_ID);
    const hidden = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Hidden Note", folder: "plans", content: "Unreleased." },
      owner.apiKey,
    );
    expect(hidden.status, JSON.stringify(hidden.data)).toBe(201);

    const steward = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      { scope: "document", documentId: SECRET_ID, users: [{ email: STEWARD_EMAIL, role: "reviewer" }] },
      owner.apiKey,
    );
    expect(steward.status, JSON.stringify(steward.data)).toBe(201);
    const nestSteward = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      { scope: "nest", users: [{ email: NEST_STEWARD_EMAIL, role: "reviewer" }] },
      owner.apiKey,
    );
    expect(nestSteward.status, JSON.stringify(nestSteward.data)).toBe(201);

    const thread = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${SECRET_ID}/annotations`,
      { body: "Check the price before this goes out." },
      owner.apiKey,
    );
    expect(thread.status, JSON.stringify(thread.data)).toBe(201);
  });

  afterAll(() => env?.cleanup?.());

  it("comment-counts omits documents the caller cannot read", async () => {
    const mine = await jsonRequest(app, "GET", `/nests/${nestId}/comment-counts`, undefined, owner.apiKey);
    expect(mine.status).toBe(200);
    expect(Object.keys(mine.data.counts)).toContain(SECRET_ID);

    const theirs = await jsonRequest(app, "GET", `/nests/${nestId}/comment-counts`, undefined, outsider.apiKey);
    expect(theirs.status).toBe(200);
    expect(Object.keys(theirs.data.counts)).not.toContain(SECRET_ID);
  });

  it("folders hides folders holding only unreadable documents and counts readable ones", async () => {
    const mine = await jsonRequest(app, "GET", `/nests/${nestId}/folders`, undefined, owner.apiKey);
    const minePaths = mine.data.folders.map((f: any) => f.path);
    expect(minePaths).toContain("secret/plans");

    const theirs = await jsonRequest(app, "GET", `/nests/${nestId}/folders`, undefined, outsider.apiKey);
    expect(theirs.status).toBe(200);
    const paths = theirs.data.folders.map((f: any) => f.path);
    expect(paths).not.toContain("secret");
    expect(paths).not.toContain("secret/plans");
    const plans = theirs.data.folders.find((f: any) => f.path === "plans");
    expect(plans, JSON.stringify(theirs.data.folders)).toBeTruthy();
    expect(plans.count).toBe(1);
  });

  it("members still see empty folders; a narrowed reader does not", async () => {
    const made = await jsonRequest(app, "POST", `/nests/${nestId}/folders`, { folder: "empty/shelf" }, owner.apiKey);
    expect(made.status, JSON.stringify(made.data)).toBe(201);
    const mine = await jsonRequest(app, "GET", `/nests/${nestId}/folders`, undefined, owner.apiKey);
    expect(mine.data.folders.map((f: any) => f.path)).toContain("empty/shelf");
    const census = await jsonRequest(app, "GET", `/nests/${nestId}/census`, undefined, owner.apiKey);
    expect(census.data.census.folders.map((f: any) => f.path)).toContain("empty/shelf");
    const theirs = await jsonRequest(app, "GET", `/nests/${nestId}/folders`, undefined, outsider.apiKey);
    expect(theirs.data.folders.map((f: any) => f.path)).not.toContain("empty/shelf");
    const theirCensus = await jsonRequest(app, "GET", `/nests/${nestId}/census`, undefined, outsider.apiKey);
    expect(theirCensus.data.census.folders.map((f: any) => f.path)).not.toContain("empty/shelf");
  });

  it("census folder tree hides folders holding only unreadable documents", async () => {
    const theirs = await jsonRequest(app, "GET", `/nests/${nestId}/census`, undefined, outsider.apiKey);
    expect(theirs.status).toBe(200);
    const paths = theirs.data.census.folders.map((f: any) => f.path);
    expect(paths).not.toContain("secret");
    expect(paths).not.toContain("secret/plans");
  });

  it("context_stewards by title treats a restricted document as missing", async () => {
    const restricted = await mcpTool(app, nestId, outsider.apiKey, "context_stewards", { title: "Secret Plan" });
    const missing = await mcpTool(app, nestId, outsider.apiKey, "context_stewards", { title: "No Such Document" });
    expect(restricted.text).not.toContain(STEWARD_EMAIL);
    expect(restricted.text.replace("Secret Plan", "X")).toBe(missing.text.replace("No Such Document", "X"));

    const asOwner = await mcpTool(app, nestId, owner.apiKey, "context_stewards", { title: "Secret Plan" });
    expect(asOwner.text).toContain(STEWARD_EMAIL);
  });

  it("context_stewards never hands a public reader steward emails", async () => {
    const res = await mcpTool(app, nestId, outsider.apiKey, "context_stewards", { title: "Open Plan" });
    expect(res.text).not.toMatch(/@corp\.test/);
  });

  it("GET /nodes/:id/stewards denies a restricted document like the versions route", async () => {
    const theirs = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${SECRET_ID}/stewards`, undefined, outsider.apiKey);
    expect(theirs.status).toBe(403);
    expect(JSON.stringify(theirs.data)).not.toContain(STEWARD_EMAIL);

    const mine = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${SECRET_ID}/stewards`, undefined, owner.apiKey);
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.data)).toContain(STEWARD_EMAIL);
  });

  it("GET /nodes/:id/stewards gives a public reader no emails on a readable document", async () => {
    const theirs = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/plans/open-plan/stewards`, undefined, outsider.apiKey);
    expect(theirs.status).toBe(200);
    expect(JSON.stringify(theirs.data)).not.toMatch(/@corp\.test/);
  });
});
