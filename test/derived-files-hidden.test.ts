import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "path";
import { writeFileSync } from "fs";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers";
import { engineCache } from "../src/nodes/engine.js";
import { isMetaFile } from "../src/nodes/meta-files.js";

describe("derived vault files never list as documents", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string };
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@test.com", "Owner");
    const { data } = await jsonRequest(
      app, "POST", "/nests", { name: "Structured" }, owner.apiKey,
    );
    nestId = data.nest.id;
    await jsonRequest(
      app, "POST", `/nests/${nestId}/nodes`,
      { title: "Gtm One", content: "# Gtm One\n\nBody.", folder: "gtm" },
      owner.apiKey,
    );
  });

  afterAll(() => env.cleanup());

  it("ignores name, extension case and nesting", () => {
    expect(isMetaFile("gtm/CONTEXT")).toBe(true);
    expect(isMetaFile("nodes/gtm/README.md")).toBe(true);
    expect(isMetaFile("gtm\\INDEX.md")).toBe(true);
    expect(isMetaFile("gtm/context.md")).toBe(true);
    expect(isMetaFile("Readme.md")).toBe(true);
    expect(isMetaFile("nodes/Index.MD")).toBe(true);
    expect(isMetaFile("gtm/context-nest-guide")).toBe(false);
    expect(isMetaFile("gtm/readme-driven-design.md")).toBe(false);
  });

  // The engine's own exclusion is root-only for CONTEXT.md and misses
  // README.md, so on a structured (non-imported) nest these listed as
  // editable documents that regenerateIndex overwrites on the next write.
  it("hides a nested CONTEXT.md / README.md on a structured nest", async () => {
    const dir = join(process.env.DATA_ROOT!, "nests", nestId, "nodes", "gtm");
    for (const name of ["CONTEXT.md", "README.md", "GEMINI.md"]) {
      writeFileSync(join(dir, name), `---\ntitle: ${name}\n---\n\nderived\n`);
    }
    (await engineCache.get(nestId)).invalidateDiscovery();

    const { data } = await jsonRequest(
      app, "GET", `/nests/${nestId}/nodes`, undefined, owner.apiKey,
    );
    expect(data.nodes.map((n: any) => n.id)).toEqual(["nodes/gtm/gtm-one"]);
  });
});
