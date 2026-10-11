/**
 * MCP context_my_drafts { id } hands an author their OWN unapproved draft.
 *
 * Under stewardship an unapproved body never reaches AI — but that left an
 * author fixing their draft through an agent editing blind: context_get
 * refuses a never-approved draft, and serves the older approved text once one
 * exists. The author can now ask for the working copy explicitly; everyone
 * else (owner and stewards included) is refused, and context_get itself stays
 * approved-only even for the author — an agent on the author's key must keep
 * answering from approved text unless it asks for the draft.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  setupTestEnv,
  createTestApp,
  jsonRequest,
  registerUser,
  authed,
} from "./helpers";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
let rpcId = 1;

async function callTool(
  app: any,
  nestId: string,
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...authed(apiKey) },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json")
    ? (await res.json()).result
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice("data: ".length),
      ).result;
}

const textOf = (r: any): string => (r?.content ?? []).map((c: any) => c.text ?? "").join("\n");

describe("MCP context_my_drafts: reading back the author's own draft", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string };
  let writer: { apiKey: string; userId: string };
  let reviewer: { apiKey: string; userId: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@acme.com", "Owner");
    writer = await registerUser(app, "writer@acme.com", "Writer");
    reviewer = await registerUser(app, "reviewer@acme.com", "Reviewer");

    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Draft Vault" }, owner.apiKey);
    nestId = data.nest.id;
    for (const email of ["writer@acme.com", "reviewer@acme.com"]) {
      await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/collaborators`,
        { email, permission: "write" },
        owner.apiKey,
      );
    }
    const nestPath = join(env.dataDir, "nests", nestId);
    mkdirSync(nestPath, { recursive: true });
    writeFileSync(
      join(nestPath, "stewards.yaml"),
      `nest:
  - email: reviewer@acme.com, role: reviewer, can_approve: true
`,
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/stewards/sync`, {}, owner.apiKey);
  });

  afterAll(() => env.cleanup());

  it("author reads a never-approved draft; even the nest owner is refused", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Fresh Draft", content: "unapproved words" },
      writer.apiKey,
    );
    expect(created.status).toBe(201);

    const mine = await callTool(app, nestId, writer.apiKey, "context_my_drafts", { id: "nodes/fresh-draft" });
    expect(mine.isError).toBeFalsy();
    expect(textOf(mine)).toContain("unapproved words");
    expect(textOf(mine)).toContain("your unapproved draft");

    // context_get is unchanged: still refused, even for the author.
    const plainGet = await callTool(app, nestId, writer.apiKey, "context_get", { id: "nodes/fresh-draft" });
    expect(plainGet.isError).toBe(true);
    expect(textOf(plainGet)).not.toContain("unapproved words");

    const theirs = await callTool(app, nestId, owner.apiKey, "context_my_drafts", { id: "nodes/fresh-draft" });
    expect(theirs.isError).toBe(true);
    expect(textOf(theirs)).not.toContain("unapproved words");
  });

  it("author reads their edit past the approved version; context_get and others stay approved", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Living Doc", content: "approved text" },
      writer.apiKey,
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes/nodes/living-doc/submit-review`, {}, writer.apiKey);
    const approve = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/living-doc/approve`,
      {},
      reviewer.apiKey,
    );
    expect(approve.status).toBe(200);

    const edit = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/living-doc`,
      { content: "fixed text" },
      writer.apiKey,
    );
    expect(edit.status).toBe(200);

    const mine = await callTool(app, nestId, writer.apiKey, "context_my_drafts", { id: "nodes/living-doc" });
    expect(textOf(mine)).toContain("fixed text");
    expect(textOf(mine)).toMatch(/AI readers still get approved v\d+/);

    // The author's plain context_get still serves the approved text.
    const plainGet = await callTool(app, nestId, writer.apiKey, "context_get", { id: "nodes/living-doc" });
    expect(textOf(plainGet)).toContain("approved text");
    expect(textOf(plainGet)).not.toContain("fixed text");

    // Owner and steward can't pull someone else's draft through this door.
    for (const key of [owner.apiKey, reviewer.apiKey]) {
      const r = await callTool(app, nestId, key, "context_my_drafts", { id: "nodes/living-doc" });
      expect(r.isError).toBe(true);
      expect(textOf(r)).not.toContain("fixed text");
    }
  });

  it("author revising a pending submission over MCP reads back the revision", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Submitted Doc", content: "as submitted" },
      writer.apiKey,
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes/nodes/submitted-doc/submit-review`, {}, writer.apiKey);

    const upd = await callTool(app, nestId, writer.apiKey, "context_update", {
      id: "nodes/submitted-doc",
      content: "revised after submit",
    });
    expect(upd.isError).toBeFalsy();

    const mine = await callTool(app, nestId, writer.apiKey, "context_my_drafts", { id: "nodes/submitted-doc" });
    expect(textOf(mine)).toContain("revised after submit");
    expect(textOf(mine)).toContain("pending_review");

    // Still locked for a teammate, and still unreadable by their agent.
    const lockedEdit = await callTool(app, nestId, owner.apiKey, "context_update", {
      id: "nodes/submitted-doc",
      content: "teammate edit",
    });
    expect(lockedEdit.isError).toBe(true);
    const theirs = await callTool(app, nestId, owner.apiKey, "context_my_drafts", { id: "nodes/submitted-doc" });
    expect(textOf(theirs)).not.toContain("revised after submit");
  });

  it("a rejected draft reads back as the author's working copy, by title too", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Bounced Doc", content: "needs another pass" },
      writer.apiKey,
    );
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes/nodes/bounced-doc/submit-review`, {}, writer.apiKey);
    const reject = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/nodes/bounced-doc/reject`,
      { note: "tighten the intro" },
      reviewer.apiKey,
    );
    expect(reject.status).toBe(200);

    const byTitle = await callTool(app, nestId, writer.apiKey, "context_my_drafts", { title: "Bounced Doc" });
    expect(byTitle.isError).toBeFalsy();
    expect(textOf(byTitle)).toContain("needs another pass");
    expect(textOf(byTitle)).toContain("rejected");
  });

  it("is refused on a nest without stewardship (context_get already serves the live text)", async () => {
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Open Vault" }, writer.apiKey);
    const openNest = data.nest.id;
    await jsonRequest(app, "PATCH", `/nests/${openNest}/settings`, { stewardship_enabled: false }, writer.apiKey);
    await jsonRequest(app, "POST", `/nests/${openNest}/nodes`, { title: "Open Doc", content: "live text" }, writer.apiKey);

    const r = await callTool(app, openNest, writer.apiKey, "context_my_drafts", { id: "nodes/open-doc" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("context_get");
    const get = await callTool(app, openNest, writer.apiKey, "context_get", { id: "nodes/open-doc" });
    expect(textOf(get)).toContain("live text");
  });

  // Last: downgrades the writer for the rest of the file.
  it("an author who lost edit rights can no longer read the draft back", async () => {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Orphaned Draft", content: "written before the downgrade" },
      writer.apiKey,
    );
    const before = await callTool(app, nestId, writer.apiKey, "context_my_drafts", { id: "nodes/orphaned-draft" });
    expect(textOf(before)).toContain("written before the downgrade");

    const collabs = await jsonRequest(app, "GET", `/nests/${nestId}/collaborators`, undefined, owner.apiKey);
    const row = (collabs.data.collaborators ?? collabs.data).find((c: any) => c.email === "writer@acme.com");
    const down = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/collaborators/${row.id}`,
      { permission: "read" },
      owner.apiKey,
    );
    expect(down.status).toBe(200);

    const after = await callTool(app, nestId, writer.apiKey, "context_my_drafts", { id: "nodes/orphaned-draft" });
    expect(after.isError).toBe(true);
    expect(textOf(after)).not.toContain("written before the downgrade");
  });
});
