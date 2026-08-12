/**
 * A verdict on an out-of-band edit must land in document history.
 *
 * Approving one already did — the engine commits a version and the community
 * server mirrors it into node_versions, which is what the history panel reads.
 * Rejecting one wrote nothing: the engine archives the suggestion under
 * _archive/rejected/ and leaves the chain head alone, so the reviewer, the
 * time, and the reason were unrecoverable from the audit trail.
 *
 * Both verdicts now seal a version, so both show up the same way.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";

describe("external edit verdicts are recorded in document history", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string };
  let nestId: string;
  let nodeId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key", { superAdmins: ["owner@acme.com"] });
    owner = await registerUser(app, "owner@acme.com", "Owner");

    const { data: nestData } = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Drift Vault" },
      owner.apiKey,
    );
    nestId = nestData.nest.id;

    const { data: nodeData } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Rate Limits", content: "# Rate Limits\n\n100 rpm.\n" },
      owner.apiKey,
    );
    nodeId = nodeData.node.id;
  }, 30000);

  afterAll(() => env.cleanup());

  /** Hand-edit the node's file outside the toolchain, the way the ticket does. */
  function editOnDisk(suffix: string) {
    const nestDir = join(process.env.DATA_ROOT!, "nests", nestId);
    const docFile = (
      readdirSync(nestDir, { recursive: true } as any) as string[]
    )
      .map(String)
      .find(
        (f) =>
          f.endsWith(".md") &&
          f.includes("nodes") &&
          !f.endsWith("INDEX.md") &&
          !f.endsWith("CONTEXT.md"),
      );
    expect(docFile).toBeTruthy();
    const docPath = join(nestDir, docFile!);
    writeFileSync(docPath, readFileSync(docPath, "utf-8") + suffix);
  }

  async function stageDrift(suffix: string): Promise<string> {
    editOnDisk(suffix);
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/external-edits/scan`,
      {},
      owner.apiKey,
    );
    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/external-edits`,
      undefined,
      owner.apiKey,
    );
    expect(data.pending).toBeTruthy();
    return data.pending.suggestion_id;
  }

  async function history() {
    const { status, data } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/versions`,
      undefined,
      owner.apiKey,
    );
    expect(status).toBe(200);
    return data.versions as Array<{
      version: number;
      editedBy: string;
      editedAt: string;
      changeNote?: string;
    }>;
  }

  it("records a rejection — who, when, and why", async () => {
    const before = await history();
    const suggestionId = await stageDrift("\n\nSomeone's unreviewed paragraph.\n");

    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/external-edits/${encodeURIComponent(suggestionId)}/reject`,
      { reason: "not sourced" },
      owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.rejected).toBe(true);

    const after = await history();
    expect(after.length).toBe(before.length + 1);

    const entry = after[0];
    expect(entry.changeNote).toBe("External edit rejected: not sourced");
    expect(entry.editedBy).toBe("owner@acme.com");
    expect(entry.editedAt).toBeTruthy();

    // The reject reverted the file, so the rejection is an audit entry over
    // unchanged content — the pending banner must be gone either way.
    const { data: pending } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/external-edits`,
      undefined,
      owner.apiKey,
    );
    expect(pending.pending).toBeFalsy();
  }, 30000);

  it("records an approval the same way, carrying the reviewer's comment", async () => {
    const suggestionId = await stageDrift("\n\nA welcome clarification.\n");

    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/external-edits/${encodeURIComponent(suggestionId)}/approve`,
      { comment: "checked with ops" },
      owner.apiKey,
    );
    expect(status).toBe(200);

    const entry = (await history())[0];
    expect(entry.changeNote).toBe("External edit approved: checked with ops");
    expect(entry.editedBy).toBe("owner@acme.com");
  }, 30000);
});
