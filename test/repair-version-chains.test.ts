/**
 * The one-shot repair pass for grafted version chains.
 *
 * Documents grafted before numbering was fixed stay unreadable until touched:
 * `history.yaml` holds two entries at the same version, the v{N}.diff written
 * second overwrote the first, and reconstruction dies from the graft point on.
 * `repairGraftedVersionChains` re-anchors each broken document's latest version
 * onto its live bytes, externalizes any patches still inline in history.yaml,
 * and gates itself through schema_migrations so a restart doesn't repeat it.
 *
 * The graft is seeded with raw file writes on purpose: the engine now seals
 * version artifacts, so `writeDiff` refuses to overwrite v{N}.diff. Nothing
 * stopped it back when these chains were grafted, which is the state on disk
 * this pass exists to clean up.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string; userId: string };
let nestId: string;
const nodeId = "nodes/graft-doc";
const MIGRATION_ID = "010_repair_grafted_version_chains";

async function engine() {
  const { engineCache } = await import("../src/nodes/engine.js");
  return engineCache.get(nestId);
}

async function db() {
  const { getDb } = await import("../src/db/client.js");
  return getDb();
}

/** Run the pass with the gate cleared, so it actually scans. */
async function runRepair(): Promise<void> {
  await (await db()).run("DELETE FROM schema_migrations WHERE id = ?", [MIGRATION_ID]);
  const { repairGraftedVersionChains } = await import(
    "../src/db/repair-version-chains.js"
  );
  await repairGraftedVersionChains(await db());
}

function versionFile(name: string, slug = "graft-doc"): string {
  return join(env.dataDir, "nests", nestId, "nodes", ".versions", slug, name);
}

/** A document with a v1 keyframe and two diff versions on top. */
async function seedDoc(title: string, slug: string): Promise<string> {
  await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/nodes`,
    { title, content: "# base\n\nv1 body" },
    owner.apiKey,
  );
  for (const n of [2, 3]) {
    const r = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/${slug}`,
      { content: `# base\n\nv${n} body` },
      owner.apiKey,
    );
    expect(r.status).toBe(200);
  }
  return `nodes/${slug}`;
}

/**
 * Reproduce a graft: a second history entry at the live head version, whose
 * v{N}.diff overwrote the original one and no longer applies to v{N-1}.
 */
async function graftChain(docId = nodeId, slug = "graft-doc"): Promise<number> {
  const { storage } = await engine();
  const history = (await storage.readHistory(docId))!;
  const head = history.versions[history.versions.length - 1];
  const bogus = `sha256:${"b".repeat(64)}`;

  history.versions.push({
    ...head,
    keyframe: false,
    content_hash: bogus,
    chain_hash: bogus,
  });
  await storage.writeHistory(docId, history);
  writeFileSync(
    versionFile(`v${head.version}.diff`, slug),
    `Index: v${head.version}
===================================================================
--- v${head.version - 1}
+++ v${head.version}
@@ -1,3 +1,3 @@
 # unrelated
-a line that is not in the previous version
+a replacement for a line that never existed
`,
  );
  return head.version;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "lead@acme.com", "Lead");

  const created = await jsonRequest(app, "POST", "/nests", { name: "Repair" }, owner.apiKey);
  nestId = created.data.nest.id;

  await seedDoc("Graft Doc", "graft-doc");
});

afterAll(() => env.cleanup());

describe("repairGraftedVersionChains", () => {
  it("re-anchors a grafted chain onto the live bytes, and is idempotent", async () => {
    const head = await graftChain();
    const { storage, versions } = await engine();
    await expect(versions.reconstructVersion(nodeId, head)).rejects.toThrow();

    await runRepair();

    // The head reads again, and reads as what the document actually says now.
    await expect(versions.reconstructVersion(nodeId, head)).resolves.toContain("v3 body");
    // Nothing renumbered, no version appended — the graft is anchored in place.
    const after = (await storage.readHistory(nodeId))!;
    expect(Math.max(...after.versions.map((e) => e.version))).toBe(head);

    // Rerunning over a repaired chain must not touch it again.
    const snapshot = JSON.stringify(after);
    await runRepair();
    expect(JSON.stringify(await storage.readHistory(nodeId))).toBe(snapshot);
    await expect(versions.reconstructVersion(nodeId, head)).resolves.toContain("v3 body");
  });

  it("moves patches still inline in history.yaml into v{N}.diff files", async () => {
    const { storage } = await engine();
    const history = (await storage.readHistory(nodeId))!;
    const v2 = history.versions.find((e) => e.version === 2)!;

    // Put v2 back the way pre-externalization histories stored it: patch bytes
    // inline on the entry, no standalone change-log file.
    v2.diff = (await storage.readDiff(nodeId, 2))!;
    await storage.writeHistory(nodeId, history);
    rmSync(versionFile("v2.diff"));

    await runRepair();

    expect(existsSync(versionFile("v2.diff"))).toBe(true);
    const after = (await storage.readHistory(nodeId))!.versions.find((e) => e.version === 2)!;
    expect(after.diff).toBeUndefined();
  });

  it("runs once — a restart with the gate already recorded skips the scan", async () => {
    const lateDoc = await seedDoc("Late Doc", "late-doc");
    const head = await graftChain(lateDoc, "late-doc");
    const { versions } = await engine();

    // No gate clearing this time: the row from the previous run is still there.
    const { repairGraftedVersionChains } = await import(
      "../src/db/repair-version-chains.js"
    );
    await repairGraftedVersionChains(await db());

    await expect(versions.reconstructVersion(lateDoc, head)).rejects.toThrow();
  });

  it("survives a nest with nothing on disk and still records the gate", async () => {
    const orphan = await jsonRequest(app, "POST", "/nests", { name: "Orphan" }, owner.apiKey);
    const orphanDir = join(env.dataDir, "nests", orphan.data.nest.id);
    rmSync(orphanDir, { recursive: true, force: true });
    mkdirSync(orphanDir, { recursive: true });

    await expect(runRepair()).resolves.toBeUndefined();

    const row = await (
      await db()
    ).get("SELECT id FROM schema_migrations WHERE id = ?", [MIGRATION_ID]);
    expect(row).toBeTruthy();
  });
});
