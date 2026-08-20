/**
 * Deletion requests over MCP — the same flow the UI offers, so an agent isn't
 * left at a dead end when context_delete refuses.
 *
 * The /mcp transport is read-tier (MCP is always POST), so the per-tool checks
 * here are the only gate: anyone who can READ may flag, only a nest
 * owner/admin may resolve.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;
let owner: { apiKey: string; email: string };
let editor: { apiKey: string; email: string };
let reader: { apiKey: string; email: string };

async function callTool(
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
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
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.error).toBeUndefined();
  return body.result.content.map((c: any) => c.text).join("");
}

/** Pull the `id` out of a "Request id: `<uuid>`" line. */
function requestIdOf(text: string): string {
  const m = text.match(/Request id: `([^`]+)`/);
  expect(m).toBeTruthy();
  return m![1];
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["owner@acme.com"] });
  owner = await registerUser(app, "owner@acme.com", "Owner");
  editor = await registerUser(app, "editor@acme.com", "Editor");
  reader = await registerUser(app, "reader@acme.com", "Reader");

  const { data } = await jsonRequest(app, "POST", "/nests", { name: "MCP Vault" }, owner.apiKey);
  nestId = data.nest.id;

  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: "editor@acme.com", permission: "write" },
    owner.apiKey,
  );
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/collaborators`,
    { email: "reader@acme.com", permission: "read" },
    owner.apiKey,
  );

  for (const [title, folder] of [
    ["Stale Doc", ""],
    ["Kept Doc", ""],
    ["Legacy One", "legacy/api"],
  ] as const) {
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title, content: "# x", ...(folder ? { folder } : {}) },
      owner.apiKey,
    );
  }
}, 30000);

afterAll(() => env.cleanup());

describe("MCP: deletion requests", () => {
  it("points a refused delete at the request tool", async () => {
    const out = await callTool(reader.apiKey, "context_delete", {
      title: "Stale Doc",
    });
    expect(out).toContain("don't have permission");
    expect(out).toContain("context_request_deletion");
  });

  it("refuses a viewer's flag — document, folder and nest alike", async () => {
    // Same rule as REST: proposing a deletion is an editor's act, and the MCP
    // path must not be the way around it.
    for (const args of [
      { title: "Stale Doc", reason: "I don't like it" },
      { folder: "legacy/api", reason: "nope" },
      { nest: true, reason: "nope" },
    ]) {
      expect(
        await callTool(reader.apiKey, "context_request_deletion", args),
      ).toContain("Only an editor");
    }
  });

  it("an editor flags a document, and can't flag it twice", async () => {
    const out = await callTool(editor.apiKey, "context_request_deletion", {
      title: "Stale Doc",
      reason: "superseded by the new runbook",
    });
    expect(out).toContain("Stale Doc");
    expect(out).toContain("nothing is removed yet");

    const dup = await callTool(editor.apiKey, "context_request_deletion", {
      title: "Stale Doc",
      reason: "again",
    });
    expect(dup).toMatch(/already pending/i);
  });

  it("requires a reason, and refuses an unknown folder", async () => {
    expect(
      await callTool(editor.apiKey, "context_request_deletion", {
        title: "Kept Doc",
        reason: "   ",
      }),
    ).toContain("reason is required");

    expect(
      await callTool(editor.apiKey, "context_request_deletion", {
        folder: "no/such/folder",
        reason: "stale",
      }),
    ).toContain("No folder");
  });

  it("shows the queue with reasons, and refuses a reader's verdict", async () => {
    const queue = await callTool(owner.apiKey, "context_deletion_queue", {});
    expect(queue).toContain("Stale Doc");
    expect(queue).toContain("superseded by the new runbook");

    const id = requestIdOf(queue);
    const denied = await callTool(reader.apiKey, "context_resolve_deletion", {
      request_id: id,
      action: "delete",
    });
    expect(denied).toContain("don't have permission");

    // Refused means refused — the document is still listed.
    const list = await callTool(owner.apiKey, "context_list", {});
    expect(list).toContain("Stale Doc");
  });

  it("declines with a note, keeping the document", async () => {
    const queue = await callTool(owner.apiKey, "context_deletion_queue", {});
    const id = requestIdOf(queue);

    expect(
      await callTool(owner.apiKey, "context_resolve_deletion", {
        request_id: id,
        action: "decline",
      }),
    ).toContain("note is required");

    const out = await callTool(owner.apiKey, "context_resolve_deletion", {
      request_id: id,
      action: "decline",
      note: "still referenced by onboarding",
    });
    expect(out).toContain("Rejected");
    expect(await callTool(owner.apiKey, "context_list", {})).toContain("Stale Doc");

    // Declined verdicts stay listed with their note; nothing is pending.
    const declined = await callTool(owner.apiKey, "context_deletion_queue", {
      status: "declined",
    });
    expect(declined).toContain("still referenced by onboarding");
    expect(await callTool(owner.apiKey, "context_deletion_queue", {})).toContain(
      "All caught up",
    );
  });

  it("honours a folder request, deleting everything under it", async () => {
    const flag = await callTool(editor.apiKey, "context_request_deletion", {
      folder: "legacy/api",
      reason: "dead api docs",
    });
    expect(flag).toContain("1 document(s) inside");

    const out = await callTool(owner.apiKey, "context_resolve_deletion", {
      request_id: requestIdOf(flag),
      action: "delete",
    });
    expect(out).toContain("Deleted");

    const list = await callTool(owner.apiKey, "context_list", {});
    expect(list).not.toContain("Legacy One");
    // Honoured requests leave the queue.
    expect(await callTool(owner.apiKey, "context_deletion_queue", {})).toContain(
      "All caught up",
    );
  });
});
