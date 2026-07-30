/**
 * Nest export bundle — GET /nests/:id/export?format=bundle[&includeDrafts=1].
 *
 * The export is a .zip of markdown documents that the EXISTING folder importer
 * (POST /nests/import) ingests — no separate import path. These tests unzip the
 * bundle in-process and feed it straight to /nests/import to prove the
 * dev→prod "export here, import there" round-trip works unchanged.
 *
 *  - approved/published docs export as `status: published` and re-import published
 *  - unapproved drafts export ONLY with ?includeDrafts=1
 *  - only the owner/admin may export a bundle
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import JSZip from "jszip";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
} from "./helpers.js";

type ImportedFile = { path: string; content: string };

async function unzipToFiles(bytes: ArrayBuffer): Promise<ImportedFile[]> {
  const zip = await JSZip.loadAsync(bytes);
  const out: ImportedFile[] = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    out.push({ path: entry.name, content: await entry.async("string") });
  }
  return out;
}

describe("nest export bundle → existing folder import", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let alice: { apiKey: string };
  let bob: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@test.com", "Alice");
    bob = await registerUser(app, "bob@test.com", "Bob");

    const created = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Portable Nest" },
      alice.apiKey,
    );
    nestId = created.data.nest.id;

    // Two auto-published docs (ungoverned → approved on create).
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Alpha Doc", content: "# Alpha\n\nalpha body", tags: ["x"] }, alice.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Beta Doc", content: "# Beta\n\nbeta body", tags: ["y"] }, alice.apiKey);

    // Turn on stewardship, then add a doc that stays an unapproved draft.
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { stewardship_enabled: true }, alice.apiKey);
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, { title: "Draft Doc", content: "# Draft\n\ndraft body" }, alice.apiKey);

    // Sanity: the draft really is unapproved.
    const list = await jsonRequest(app, "GET", `/nests/${nestId}/nodes`, undefined, alice.apiKey);
    const draft = list.data.nodes.find((n: any) => n.id.endsWith("draft-doc"));
    expect(draft?.status).not.toBe("published");
  }, 60000);

  afterAll(() => env.cleanup());

  const exportBundle = (key: string, includeDrafts = false) =>
    app.request(
      `/nests/${nestId}/export?format=bundle${includeDrafts ? "&includeDrafts=1" : ""}`,
      { headers: authed(key) },
    );

  it("refuses a bundle export from a non-owner", async () => {
    const res = await exportBundle(bob.apiKey);
    expect([403, 404]).toContain(res.status);
  });

  it("exports approved docs only, and they re-import published via /nests/import", async () => {
    const res = await exportBundle(alice.apiKey);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/zip");
    const files = await unzipToFiles(await res.arrayBuffer());

    const paths = files.map((f) => f.path).sort();
    expect(paths.some((p) => p.endsWith("alpha-doc.md"))).toBe(true);
    expect(paths.some((p) => p.endsWith("beta-doc.md"))).toBe(true);
    // Draft excluded by default.
    expect(paths.some((p) => p.endsWith("draft-doc.md"))).toBe(false);
    // Approved doc ships as published.
    const alpha = files.find((f) => f.path.endsWith("alpha-doc.md"))!;
    expect(alpha.content).toContain("status: published");
    expect(alpha.content).toContain("alpha body");

    // Engine sidecars travel too: version history + nest config.
    expect(paths.some((p) => p.split("/").includes(".versions"))).toBe(true);
    expect(paths.some((p) => p.startsWith(".context/"))).toBe(true);

    // Feed the unzipped files to the EXISTING importer.
    const imp = await jsonRequest(app, "POST", "/nests/import", { name: "Imported Nest", files }, alice.apiKey);
    expect(imp.status).toBe(201);
    expect(imp.data.documents).toBe(2);

    const list = await jsonRequest(app, "GET", `/nests/${imp.data.nest.id}/nodes`, undefined, alice.apiKey);
    expect(list.data.nodes.length).toBe(2);
    expect(list.data.nodes.every((n: any) => n.status === "published")).toBe(true);
  }, 60000);

  it("never exports .context/stewards.yaml (identity), keeps config.yaml", async () => {
    // Plant a steward roster on the source nest's disk — the file
    // loadStewardsConfig reads and stewards/sync activates by email.
    const ctx = join(env.dataDir, "nests", nestId, ".context");
    mkdirSync(ctx, { recursive: true });
    writeFileSync(
      join(ctx, "stewards.yaml"),
      "stewards:\n  - email: leaked-steward@example.com\n    role: reviewer\n",
    );

    const files = await unzipToFiles(await (await exportBundle(alice.apiKey)).arrayBuffer());
    const paths = files.map((f) => f.path);
    // Identity file excluded; non-identity config still travels.
    expect(paths.some((p) => p.endsWith(".context/stewards.yaml"))).toBe(false);
    expect(paths).toContain(".context/config.yaml");
    // The steward's email must not leak anywhere in the bundle.
    expect(files.every((f) => !f.content.includes("leaked-steward@example.com"))).toBe(true);
  });

  it("includes drafts with ?includeDrafts=1", async () => {
    const res = await exportBundle(alice.apiKey, true);
    const files = await unzipToFiles(await res.arrayBuffer());
    const paths = files.map((f) => f.path);
    expect(paths.some((p) => p.endsWith("draft-doc.md"))).toBe(true);
    const draft = files.find((f) => f.path.endsWith("draft-doc.md"))!;
    expect(draft.content).toContain("status: draft");
  }, 60000);
});
