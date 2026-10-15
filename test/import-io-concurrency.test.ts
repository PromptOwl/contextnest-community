import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import { opContext } from "../src/nodes/engine.js";

// IMPORT_IO_CONCURRENCY reaches the engine as limits.ioConcurrency, and only a
// usable value does — anything else leaves the engine default.
describe("IMPORT_IO_CONCURRENCY → engine limits.ioConcurrency", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    const app = await createTestApp("key");
    const user = await registerUser(app, "io@test.com", "IO");
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "io" }, user.apiKey);
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
});
