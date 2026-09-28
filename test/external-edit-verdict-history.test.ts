/**
 * A verdict on an out-of-band edit must land in document history.
 *
 * Approving one already did — the engine commits a version and the community
 * server mirrors it into node_versions, which is what the history panel reads.
 * Rejecting one wrote nothing: the engine builds a chain event carrying the
 * reviewer, the time and the reason, then returns it and forgets it, so the
 * rejection was unrecoverable from the audit trail.
 *
 * Verdicts are now appended to the engine's chain-event log and served
 * alongside the version list. A rejection commits no content, so it must NOT
 * mint a version — the version count is asserted here to keep it that way.
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
    return data as {
      versions: Array<{
        version: number;
        editedBy: string;
        editedAt: string;
        changeNote?: string;
      }>;
      externalEditVerdicts: Array<{
        suggestion_id: string;
        status: string;
        actor: string;
        at: string;
        note?: string;
      }>;
    };
  }

  it("records a rejection — who, when, and why — without minting a version", async () => {
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
    expect(data.historyRecorded).toBe(true);

    const after = await history();
    // Nothing was committed, so nothing may be numbered.
    expect(after.versions.length).toBe(before.versions.length);

    const verdict = after.externalEditVerdicts.at(-1)!;
    expect(verdict.status).toBe("rejected");
    expect(verdict.actor).toBe("owner@acme.com");
    expect(verdict.note).toBe("not sourced");
    expect(verdict.at).toBeTruthy();
    expect(verdict.suggestion_id).toBe(suggestionId);

    // Reverting to the chain head restores bytes that already carry a matching
    // checksum, so drift clears with no publish and the banner goes away.
    const { data: pending } = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${nodeId}/external-edits`,
      undefined,
      owner.apiKey,
    );
    expect(pending.pending).toBeFalsy();
  }, 30000);

  it("keeps every verdict — a second rejection does not overwrite the first", async () => {
    const before = await history();
    const suggestionId = await stageDrift("\n\nA second unreviewed pass.\n");

    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/external-edits/${encodeURIComponent(suggestionId)}/reject`,
      { reason: "still not sourced" },
      owner.apiKey,
    );

    const after = await history();
    expect(after.versions.length).toBe(before.versions.length);
    expect(after.externalEditVerdicts.length).toBe(
      before.externalEditVerdicts.length + 1,
    );
    expect(after.externalEditVerdicts.map((v) => v.note)).toContain(
      "not sourced",
    );
    expect(after.externalEditVerdicts.at(-1)!.note).toBe("still not sourced");
  }, 30000);

  it("records an approval as both a verdict and the version it commits", async () => {
    const before = await history();
    const suggestionId = await stageDrift("\n\nA welcome clarification.\n");

    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/external-edits/${encodeURIComponent(suggestionId)}/approve`,
      { comment: "checked with ops" },
      owner.apiKey,
    );
    expect(status).toBe(200);
    expect(data.historyRecorded).toBe(true);

    const after = await history();
    // An approval DOES change content, so it earns a version.
    expect(after.versions.length).toBe(before.versions.length + 1);
    expect(after.versions[0].changeNote).toBe(
      "External edit approved: checked with ops",
    );
    expect(after.versions[0].editedBy).toBe("owner@acme.com");

    const verdict = after.externalEditVerdicts.at(-1)!;
    expect(verdict.status).toBe("approved");
    expect(verdict.actor).toBe("owner@acme.com");
    expect(verdict.note).toBe("checked with ops");
  }, 30000);

  it("?count=1 answers with the total only — the badge read", async () => {
    await stageDrift("\n\nCounted paragraph.\n");
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/external-edits`, undefined, owner.apiKey);
    const count = await jsonRequest(app, "GET", `/nests/${nestId}/external-edits?count=1`, undefined, owner.apiKey);
    expect(count.status).toBe(200);
    expect(count.data).toEqual({ total: list.data.total });
    expect(count.data.total).toBeGreaterThan(0);
  });
});
