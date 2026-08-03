/**
 * Nested folders: POST /nests/:id/nodes accepts a `folder` path so documents
 * can live at nodes/<seg>/<seg>/<slug>. Storage + read/update/delete already
 * handled nested ids — only creation flattened everything to nodes/<slug>.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";
import { createNode } from "../src/nodes/service.js";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let alice: { apiKey: string; userId: string; email: string };
let nestId: string;

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  alice = await registerUser(app, "alice@acme.com", "Alice");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Nested" }, alice.apiKey);
  nestId = nest.data.nest.id;
});

afterAll(() => env.cleanup());

describe("nested folder creation", () => {
  it("creates a node under a nested folder path", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Win Loss Log", content: "# Log", folder: "GTM/Deals" },
      alice.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.node.id).toBe("nodes/gtm/deals/win-loss-log");
  });

  it("reads and updates the nested node by its slashed id", async () => {
    const get = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/gtm/deals/win-loss-log`,
      undefined,
      alice.apiKey,
    );
    expect(get.status).toBe(200);
    expect(get.data.node.title).toBe("Win Loss Log");

    const patch = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/gtm/deals/win-loss-log`,
      { append: "\nUpdated." },
      alice.apiKey,
    );
    expect(patch.status).toBe(200);
  });

  it("slugifies traversal characters instead of escaping the vault", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Sneaky", content: "# S", folder: "../../etc//passwd" },
      alice.apiKey,
    );
    expect(res.status).toBe(201);
    // ".." segments slugify to empty and drop; only "etc"/"passwd" survive.
    expect(res.data.node.id).toBe("nodes/etc/passwd/sneaky");
  });

  it("strips a leading nodes/ segment instead of double-nesting", async () => {
    // Regression: callers think in node ids, so `folder: "nodes/signals"` is
    // natural — it used to produce nodes/nodes/signals/<slug>.
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Signal Harvest", content: "# S", folder: "nodes/signals" },
      alice.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.node.id).toBe("nodes/signals/signal-harvest");
  });

  it("rejects folders nested deeper than 8 levels", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Deep", content: "# D", folder: "a/b/c/d/e/f/g/h/i" },
      alice.apiKey,
    );
    expect(res.status).toBe(400);
  });

  it("omitting folder keeps the flat nodes/<slug> behavior", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Flat Doc", content: "# F" },
      alice.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.node.id).toBe("nodes/flat-doc");
  });

  it("rejects a non-string folder", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Bad Folder", content: "# B", folder: 123 },
      alice.apiKey,
    );
    expect(res.status).toBe(400);
  });

  it("rejects an overlong folder segment", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Too Long", content: "# T", folder: "a".repeat(101) },
      alice.apiKey,
    );
    expect(res.status).toBe(400);
  });

  it("ignores folder (incl. its depth limit) when an explicit id is given", async () => {
    // Regression for the fix commit: an explicit id skips folder derivation
    // AND folder validation, so a >8-level folder must not throw here.
    const { node } = await createNode(
      nestId,
      {
        id: "nodes/derived-fixed-id",
        title: "Derived",
        content: "# D",
        folder: "a/b/c/d/e/f/g/h/i/j",
      },
      alice.email,
    );
    expect(node.id).toBe("nodes/derived-fixed-id");
  });
});
