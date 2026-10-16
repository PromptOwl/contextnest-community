import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import { opContext } from "../src/nodes/engine.js";

// IMPORT_IO_CONCURRENCY reaches the engine as limits.ioConcurrency, and only a
// usable value does — anything else leaves the engine default.
describe("IMPORT_IO_CONCURRENCY → engine limits.ioConcurrency", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let nestId: string;
  let app: any;
  let apiKey: string;

  beforeAll(async () => {
    env = setupTestEnv();
    // ownerEmail makes the user license admin, so /admin/settings is allowed.
    app = await createTestApp("key", { ownerEmail: "io@test.com" });
    ({ apiKey } = await registerUser(app, "io@test.com", "IO"));
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "io" }, apiKey);
    nestId = data.nest.id;
  });
  afterEach(() => {
    delete process.env.IMPORT_IO_CONCURRENCY;
  });
  afterAll(() => env.cleanup());

  it("passes a positive value through", async () => {
    process.env.IMPORT_IO_CONCURRENCY = "64";
    expect((await opContext(nestId, "io@test.com")).limits?.ioConcurrency).toBe(64);
  });

  it("leaves the engine default when unset or invalid", async () => {
    for (const v of [undefined, "", "0", "-4", "abc"]) {
      if (v === undefined) delete process.env.IMPORT_IO_CONCURRENCY;
      else process.env.IMPORT_IO_CONCURRENCY = v;
      expect((await opContext(nestId, "io@test.com")).limits?.ioConcurrency, String(v)).toBeUndefined();
    }
  });

  it("is editable from Server settings and reaches the engine live", async () => {
    expect((await jsonRequest(app, "GET", "/admin/settings", undefined, apiKey)).data.import_io_concurrency).toBe(32);
    const saved = await jsonRequest(app, "PATCH", "/admin/settings", { import_io_concurrency: 128 }, apiKey);
    expect(saved.status).toBe(200);
    expect(saved.data.settings.import_io_concurrency).toBe(128);
    expect((await opContext(nestId, "io@test.com")).limits?.ioConcurrency).toBe(128);

    const cleared = await jsonRequest(app, "PATCH", "/admin/settings", { import_io_concurrency: null }, apiKey);
    expect(cleared.status).toBe(200);
    expect((await opContext(nestId, "io@test.com")).limits?.ioConcurrency).toBeUndefined();
  });

  it("refuses a value outside 1–256", async () => {
    for (const bad of [0, 257, 1.5, "abc"]) {
      const res = await jsonRequest(app, "PATCH", "/admin/settings", { import_io_concurrency: bad }, apiKey);
      expect(res.status, String(bad)).toBe(400);
    }
  });
});
