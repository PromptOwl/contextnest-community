import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

// An import says what happened: which step stopped it, which documents were
// not imported (and why), and what the engine repaired on the way in.
describe("import outcome and errors", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let apiKey: string;
  let db: any;

  const md = (path: string, fm: string, body = "body") => ({ path, content: `---\n${fm}\n---\n${body}\n` });
  const importFolder = (name: string, files: Array<{ path: string; content: string }>) =>
    jsonRequest(app, "POST", "/nests/import", { name, files }, apiKey);

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    ({ apiKey } = await registerUser(app, "errors@test.com", "Errors"));
    // The same module instance the app uses (createTestApp resets modules).
    db = (await import("../src/db/client.js")).getDb();
  });
  afterAll(() => env.cleanup());

  it("reports a refused file with its reason, and the engine's repairs", async () => {
    const { status, data } = await importFolder("Outcome", [
      md("notes/good.md", "title: Good\nstatus: published"),
      md("notes/odd.md", "title: Odd\nstatus: published\nversion: 1.1"),
      md("../escape.md", "title: Escape"),
    ]);
    expect(status).toBe(201);
    expect(data.documents).toBe(2);
    expect(data.rejected).toEqual(["../escape.md"]);
    expect(data.problems).toHaveLength(1);
    expect(data.problems[0]).toMatch(/^\.\.\/escape\.md: /);
    expect(data.warnings.some((w: string) => /notes\/odd.*version "1\.1"/.test(w))).toBe(true);
  });

  it("records the rest when one document's rows fail, naming it", async () => {
    const realTx = db.transaction.bind(db);
    db.transaction = (fn: (tx: any) => Promise<unknown>) =>
      realTx((tx: any) =>
        fn({
          get: tx.get.bind(tx),
          all: tx.all.bind(tx),
          exec: tx.exec.bind(tx),
          run: (sql: string, params: unknown[] = []) =>
            sql.includes("node_versions") && params.includes("notes/bad")
              ? Promise.reject(new Error("simulated bad row"))
              : tx.run(sql, params),
        }),
      );
    try {
      const { status, data } = await importFolder("Isolated", [
        md("notes/good.md", "title: Good\nstatus: published"),
        md("notes/bad.md", "title: Bad\nstatus: published"),
      ]);
      expect(status).toBe(201);
      expect(data.documents).toBe(1);
      expect(data.problems).toEqual(["notes/bad: not imported — simulated bad row"]);
    } finally {
      db.transaction = realTx;
    }
  });

  it("names the step that stopped the import instead of a generic error", async () => {
    const realAll = db.all.bind(db);
    db.all = (sql: string, params?: unknown[]) =>
      sql.includes("SELECT DISTINCT node_id FROM node_versions")
        ? Promise.reject(new Error("simulated outage"))
        : realAll(sql, params);
    try {
      const { status, data } = await importFolder("Stopped", [md("notes/a.md", "title: A\nstatus: published")]);
      expect(status).toBe(500);
      expect(data.error).toBe("Import stopped while publishing documents: simulated outage");
    } finally {
      db.all = realAll;
    }
  });
});
