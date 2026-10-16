/**
 * A rules save that lands is reported as saved, even when counting the
 * existing violations afterwards fails (review of #403): the UI must never
 * say "save failed" for rules that are now in force.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

vi.mock("@promptowl/contextnest-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@promptowl/contextnest-engine")>()),
  structureReport: vi.fn(async () => {
    throw new Error("a document could not be read");
  }),
}));

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let owner: { apiKey: string };

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  owner = await registerUser(app, "owner@acme.com", "Owner");
});

afterAll(() => env.cleanup());

describe("PUT /structure when the report fails", () => {
  it("answers 200 with violations: null, and the rules are saved", async () => {
    const nestId = (await jsonRequest(app, "POST", "/nests", { name: "Saved" }, owner.apiKey)).data.nest.id;
    const rules = { structure: { enforce: true, closed: false }, folders: { notes: { types: ["document"] } } };
    const res = await jsonRequest(app, "PUT", `/nests/${nestId}/structure`, rules, owner.apiKey);
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data.violations).toBeNull();
    const saved = await jsonRequest(app, "GET", `/nests/${nestId}/structure`, undefined, owner.apiKey);
    expect(saved.data.rules.structure).toEqual({ enforce: true, closed: false });
  });
});
