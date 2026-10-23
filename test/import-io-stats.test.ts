import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

// Each import call logs one I/O summary line, so a slow import on a network
// mount shows which storage operation (or DB hook) dominates.
describe("import I/O summary", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let apiKey: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    ({ apiKey } = await registerUser(app, "stats@test.com", "Stats"));
  });
  afterAll(() => env.cleanup());

  it("logs one line per staging and registration call, naming the operations", async () => {
    const log = vi.spyOn(console, "log");
    try {
      const files = Array.from({ length: 3 }, (_, i) => ({
        path: `notes/doc-${i}.md`,
        content: `---\ntitle: Doc ${i}\nstatus: published\n---\nbody ${i}\n`,
      }));
      const { status } = await jsonRequest(app, "POST", "/nests/import", { name: "Stats", files }, apiKey);
      expect(status).toBe(201);
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[import] io "));
      const stage = lines.filter((l) => l.startsWith("[import] io stage:"));
      const register = lines.filter((l) => l.startsWith("[import] io register:"));
      expect(stage).toHaveLength(1);
      expect(register).toHaveLength(1);
      expect(stage[0]).toMatch(/writeVaultFile 3x\//);
      expect(register[0]).toMatch(/discoverDocuments \d+x\//);
    } finally {
      log.mockRestore();
    }
  });
});
