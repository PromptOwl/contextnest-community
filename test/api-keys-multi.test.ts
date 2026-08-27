/**
 * Multiple API keys per user.
 *
 * Migration 003 capped the table at one row per user, which made rotation
 * destructive at a distance: someone who had wired four clients and lost the
 * plaintext had to rotate to get a readable key, silently killing all four.
 * Migration 035 lifted the cap; these tests pin the behaviour that replaces it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers.js";
import { MAX_API_KEYS_PER_USER } from "../src/auth/keys.js";

describe("multiple API keys per user", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let user: { apiKey: string; userId: string };

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    user = await registerUser(app, "keys@test.com", "Keys");
  });

  afterAll(() => env.cleanup());

  const list = async () =>
    (await jsonRequest(app, "GET", "/auth/keys", undefined, user.apiKey)).data
      .keys as Array<{ id: string; label: string | null; key_prefix: string }>;

  it("mints more than one key instead of 409ing on the second", async () => {
    const before = (await list()).length;

    const a = await jsonRequest(
      app,
      "POST",
      "/auth/keys",
      { label: "laptop" },
      user.apiKey,
    );
    const b = await jsonRequest(
      app,
      "POST",
      "/auth/keys",
      { label: "desktop" },
      user.apiKey,
    );

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.data.api_key).toMatch(/^cnst_/);
    expect(b.data.api_key).not.toBe(a.data.api_key);
    expect(a.data.id).toBeTruthy();

    const keys = await list();
    expect(keys.length).toBe(before + 2);
    expect(keys.map((k) => k.label)).toEqual(
      expect.arrayContaining(["laptop", "desktop"]),
    );
  });

  it("every minted key authenticates independently", async () => {
    const one = (
      await jsonRequest(app, "POST", "/auth/keys", { label: "one" }, user.apiKey)
    ).data.api_key;
    const two = (
      await jsonRequest(app, "POST", "/auth/keys", { label: "two" }, user.apiKey)
    ).data.api_key;

    expect((await jsonRequest(app, "GET", "/nests", undefined, one)).status).toBe(200);
    expect((await jsonRequest(app, "GET", "/nests", undefined, two)).status).toBe(200);
  });

  it("rotating one key by id leaves the others working", async () => {
    const keep = (
      await jsonRequest(app, "POST", "/auth/keys", { label: "keep" }, user.apiKey)
    ).data.api_key;
    const doomed = await jsonRequest(
      app,
      "POST",
      "/auth/keys",
      { label: "doomed" },
      user.apiKey,
    );

    const rotated = await jsonRequest(
      app,
      "POST",
      "/auth/keys/rotate",
      { key_id: doomed.data.id },
      user.apiKey,
    );
    expect(rotated.status).toBe(200);
    expect(rotated.data.api_key).not.toBe(doomed.data.api_key);
    // Label carries across a rotate when the caller doesn't supply one.
    expect(rotated.data.label).toBe("doomed");

    // The rotated key is dead, its replacement lives, and the bystander is
    // untouched — the whole point of the change.
    expect(
      (await jsonRequest(app, "GET", "/nests", undefined, doomed.data.api_key))
        .status,
    ).toBe(401);
    expect(
      (await jsonRequest(app, "GET", "/nests", undefined, rotated.data.api_key))
        .status,
    ).toBe(200);
    expect(
      (await jsonRequest(app, "GET", "/nests", undefined, keep)).status,
    ).toBe(200);
  });

  it("refuses an ambiguous rotate rather than picking a key", async () => {
    expect((await list()).length).toBeGreaterThan(1);
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/auth/keys/rotate",
      {},
      user.apiKey,
    );
    expect(status).toBe(400);
    expect(data.error).toMatch(/which one/i);
  });

  it("404s on a key id the caller doesn't own", async () => {
    const other = await registerUser(app, "other@test.com", "Other");
    const mine = await jsonRequest(
      app,
      "POST",
      "/auth/keys",
      { label: "mine" },
      user.apiKey,
    );

    const rotate = await jsonRequest(
      app,
      "POST",
      "/auth/keys/rotate",
      { key_id: mine.data.id },
      other.apiKey,
    );
    expect(rotate.status).toBe(404);

    const del = await jsonRequest(
      app,
      "DELETE",
      `/auth/keys/${mine.data.id}`,
      undefined,
      other.apiKey,
    );
    expect(del.status).toBe(404);

    // Still ours, still working.
    expect(
      (await jsonRequest(app, "GET", "/nests", undefined, mine.data.api_key))
        .status,
    ).toBe(200);
  });

  it("rejects a label that's too long", async () => {
    const { status } = await jsonRequest(
      app,
      "POST",
      "/auth/keys",
      { label: "x".repeat(200) },
      user.apiKey,
    );
    expect(status).toBe(400);
  });

  it("caps the number of live keys", async () => {
    let last = { status: 201 } as { status: number };
    // Mint until the ceiling answers; the loop is bounded by the cap itself.
    for (let i = (await list()).length; i <= MAX_API_KEYS_PER_USER; i++) {
      last = await jsonRequest(
        app,
        "POST",
        "/auth/keys",
        { label: `bulk-${i}` },
        user.apiKey,
      );
    }
    expect(last.status).toBe(409);
    expect((await list()).length).toBe(MAX_API_KEYS_PER_USER);
  });
});
