import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

// Each document write logs one I/O summary line, so a slow save on a network
// mount shows which step (storage call, engine op, DB hook, notification)
// the user waited on.
describe("write I/O summary", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let apiKey: string;
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    ({ apiKey } = await registerUser(app, "writes@test.com", "Writes"));
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "Writes" }, apiKey);
    nestId = data.nest.id;
  });
  afterAll(() => env.cleanup());

  it("logs one line per create, update and delete, naming the engine op", async () => {
    const log = vi.spyOn(console, "log");
    try {
      const created = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title: "Timed", content: "first" },
        apiKey,
      );
      expect(created.status).toBe(201);
      const id = created.data.node.id;
      const updated = await jsonRequest(app, "PATCH", `/nests/${nestId}/nodes/${id}`, { content: "second" }, apiKey);
      expect(updated.status).toBe(200);
      const deleted = await jsonRequest(app, "DELETE", `/nests/${nestId}/nodes/${id}`, undefined, apiKey);
      expect(deleted.status).toBeLessThan(300);

      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[write] io "));
      const of = (label: string) => lines.filter((l) => l.startsWith(`[write] io ${label}:`));
      expect(of("create")).toHaveLength(1);
      expect(of("update")).toHaveLength(1);
      expect(of("delete")).toHaveLength(1);
      expect(of("create")[0]).toMatch(new RegExp(`nest=${nestId} total=\\d+ms `));
      expect(of("create")[0]).toMatch(/engine:context_create 1x\/\d+ms/);
      expect(of("update")[0]).toMatch(/engine:context_update 1x\/\d+ms/);
      expect(of("delete")[0]).toMatch(/engine:context_delete \d+x\/\d+ms/);
    } finally {
      log.mockRestore();
    }
  });
});
