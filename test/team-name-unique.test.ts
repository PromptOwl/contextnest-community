/** po-1211: two teams cannot share a name. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, jsonRequest, registerUser, setupTestEnv } from "./helpers.js";

describe("po-1211 team names", () => {
  const env = setupTestEnv();
  let app: any;
  let alice: any;
  const create = (name: string, who = alice) => jsonRequest(app, "POST", "/teams", { name }, who.apiKey);

  beforeAll(async () => {
    app = await createTestApp("key");
    alice = await registerUser(app, "alice@acme.com", "Alice");
  });
  afterAll(() => env.cleanup());

  it("a taken name is refused on create, in any case, also for another person", async () => {
    expect((await create("QA Dup")).status).toBe(201);
    const again = await create(" qa dup ");
    expect(again.status).toBe(409);
    expect(again.data.error).toBe("A team with this name already exists.");
    const bob = await registerUser(app, "bob@acme.com", "Bob");
    expect((await create("QA Dup", bob)).status).toBe(409);
  });

  it("a rename is refused the same way, and a team may keep or recase its own name", async () => {
    const other = (await create("Writers")).data.team;
    const rename = (name: string) => jsonRequest(app, "PATCH", `/teams/${other.id}`, { name }, alice.apiKey);
    expect((await rename("QA Dup")).status).toBe(409);
    expect((await rename("WRITERS")).status).toBe(200);
  });
});
