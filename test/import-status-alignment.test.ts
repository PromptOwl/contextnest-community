import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";

/**
 * A document the engine could not publish is reported as a draft at its own
 * version (`status: version !== undefined ? "published" : "draft"` in the
 * engine's import executor), but the file keeps whatever status its source
 * vault wrote. One saying `published` on disk then displayed as Draft forever,
 * because the badge reads the governance DB and never consults frontmatter.
 *
 * The trigger — a publish failing mid-import — belongs to the engine and is not
 * reproducible from here without corrupting internals it repairs on its own, so
 * these cover the reconciliation itself: given a recorded status, the file is
 * made to agree, and nothing else about it moves.
 */

let env: ReturnType<typeof setupTestEnv>;
beforeEach(() => {
  env = setupTestEnv();
});

const frontmatterStatus = (raw: string) =>
  raw.match(/^status:\s*(\S+)\s*$/m)?.[1] ?? null;

async function seedNest(app: any, apiKey: string, name: string) {
  const nest = await jsonRequest(app, "POST", "/nests", { name }, apiKey);
  return nest.data.nest.id as string;
}

function writeDoc(dataDir: string, nestId: string, status: string) {
  const dir = join(dataDir, "nests", nestId, "nodes");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "claims-published.md");
  writeFileSync(
    path,
    [
      "---",
      "title: Claims Published",
      "type: document",
      `status: ${status}`,
      "version: 8",
      "checksum: 'sha256:deadbeef'",
      "---",
      "",
      "# Claims Published",
      "",
      "body text that must survive",
      "",
    ].join("\n"),
    "utf-8",
  );
  return path;
}

describe("import status alignment", () => {
  it("rewrites a file that claims published when the row records a draft", async () => {
    const app = await createTestApp("key");
    const user = await registerUser(app, "align1@example.com");
    const nestId = await seedNest(app, user.apiKey, "Align");
    const docPath = writeDoc(env.dataDir, nestId, "published");

    const { alignOnDiskStatus } = await import("../src/nodes/service.js");
    await alignOnDiskStatus(nestId, "nodes/claims-published", "draft");

    const raw = readFileSync(docPath, "utf-8");
    expect(frontmatterStatus(raw)).toBe("draft");
    // The body is what the checksum covers — rewriting the status must not
    // touch it, or the drift scanner would see a phantom external edit.
    expect(raw).toContain("body text that must survive");
    expect(raw).toContain("sha256:deadbeef");
  });

  it("leaves a file alone when it already agrees", async () => {
    const app = await createTestApp("key");
    const user = await registerUser(app, "align2@example.com");
    const nestId = await seedNest(app, user.apiKey, "Align2");
    const docPath = writeDoc(env.dataDir, nestId, "draft");
    const before = readFileSync(docPath, "utf-8");

    const { alignOnDiskStatus } = await import("../src/nodes/service.js");
    await alignOnDiskStatus(nestId, "nodes/claims-published", "draft");

    expect(readFileSync(docPath, "utf-8")).toBe(before);
  });

  it("does not throw when the document is missing", async () => {
    const app = await createTestApp("key");
    const user = await registerUser(app, "align3@example.com");
    const nestId = await seedNest(app, user.apiKey, "Align3");

    const { alignOnDiskStatus } = await import("../src/nodes/service.js");
    // Best-effort by design: the governance row is already written, and failing
    // the whole import over a cosmetic mismatch would be the worse trade.
    await expect(
      alignOnDiskStatus(nestId, "nodes/not-there", "draft"),
    ).resolves.toBeUndefined();
  });
});
