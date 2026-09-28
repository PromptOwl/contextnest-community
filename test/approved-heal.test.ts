/**
 * CU-wdqcq02vet — an approved version that can no longer be rebuilt heals to
 * the newest published version that can, on the read that hits it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let nestId: string;
let n = 0;

beforeAll(async () => {
  env = setupTestEnv();
  const app = await createTestApp("key");
  const owner = await registerUser(app, "heal-owner@example.com");
  const res = await jsonRequest(app, "POST", "/nests", { name: "Heal" }, owner.apiKey);
  nestId = res.data.nest?.id ?? res.data.id;
});

afterAll(() => env.cleanup());

/** A node with the given version statuses, the approval pinned at `pin`. */
async function seed(statuses: string[], pin: number): Promise<string> {
  const versions = await import("../src/governance/version-service.js");
  const nodeId = `nodes/heal-${++n}`;
  for (const [i, status] of statuses.entries()) {
    await versions.createVersion({
      nestId, nodeId, version: i + 1, content: `v${i + 1}`, author: "a@x", status: status as any,
    });
  }
  await versions.setApprovedVersion(nestId, nodeId, pin, "a@x");
  // An old approval stamp, so a refreshed approved_at is visible.
  const { getDb } = await import("../src/db/client.js");
  await getDb().run(
    "UPDATE approved_versions SET approved_at = '2000-01-01 00:00:00' WHERE nest_id = ? AND node_id = ?",
    [nestId, nodeId],
  );
  return nodeId;
}

/** An engine stand-in whose listed versions can't be rebuilt. */
const engine = (broken: number[]) => ({
  reconstructVersion: async (_id: string, v: number) => {
    if (broken.includes(v)) throw new Error(`failed to rebuild version ${v}`);
    return `body v${v}`;
  },
});

async function state(nodeId: string) {
  const versions = await import("../src/governance/version-service.js");
  const all = await versions.getVersions(nestId, nodeId);
  return {
    pin: await versions.getApprovedVersion(nestId, nodeId),
    count: all.length,
    notes: all.map((v) => v.changeNote).filter(Boolean),
  };
}

describe("reconstructApproved", () => {
  it("moves the pin to the newest rebuildable published version, once, with no new version", async () => {
    const { reconstructApproved } = await import("../src/governance/approved-body.js");
    const nodeId = await seed(["published", "published", "published", "published"], 3);

    const first = await reconstructApproved(engine([3]), nestId, nodeId, 3);
    expect(first).toEqual({ raw: "body v4", version: 4 });
    const after = await state(nodeId);
    expect(after.pin).toBe(4);
    expect(after.count).toBe(4);
    expect(after.notes).toEqual(["Approved version moved from v3 to v4 — v3 could not be rebuilt"]);
    // Credited to the server, not the reviewer who approved v3.
    const { getDb } = await import("../src/db/client.js");
    const { APPROVED_HEAL_AUTHOR } = await import("../src/governance/version-service.js");
    const pinRow = (await getDb().get(
      "SELECT approved_by, approved_at FROM approved_versions WHERE nest_id = ? AND node_id = ?",
      [nestId, nodeId],
    )) as { approved_by: string; approved_at: string };
    expect(pinRow.approved_by).toBe(APPROVED_HEAL_AUTHOR);
    expect(pinRow.approved_at).not.toBe("2000-01-01 00:00:00");

    // A stale caller still holding v3 gets v4 and changes nothing more.
    expect(await reconstructApproved(engine([3]), nestId, nodeId, 3)).toEqual({ raw: "body v4", version: 4 });
    expect(await reconstructApproved(engine([3]), nestId, nodeId, 4)).toEqual({ raw: "body v4", version: 4 });
    expect(await state(nodeId)).toEqual(after);
  });

  it("never heals to a draft or pending version", async () => {
    const { reconstructApproved } = await import("../src/governance/approved-body.js");
    const nodeId = await seed(["published", "published", "published", "pending_review", "draft"], 2);
    expect(await reconstructApproved(engine([2]), nestId, nodeId, 2)).toEqual({ raw: "body v3", version: 3 });
    expect((await state(nodeId)).pin).toBe(3);
  });

  it("leaves everything unchanged when no newer published version rebuilds", async () => {
    const { reconstructApproved } = await import("../src/governance/approved-body.js");
    const nodeId = await seed(["published", "published", "published"], 2);
    await expect(reconstructApproved(engine([2, 3]), nestId, nodeId, 2)).rejects.toThrow(/rebuild version 2/);
    expect(await state(nodeId)).toEqual({ pin: 2, count: 3, notes: [] });
  });

  it("does nothing extra for a healthy approved version", async () => {
    const { reconstructApproved } = await import("../src/governance/approved-body.js");
    const nodeId = await seed(["published", "published"], 1);
    expect(await reconstructApproved(engine([]), nestId, nodeId, 1)).toEqual({ raw: "body v1", version: 1 });
    expect(await state(nodeId)).toEqual({ pin: 1, count: 2, notes: [] });
  });
});
