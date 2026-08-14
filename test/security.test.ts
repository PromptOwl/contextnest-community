/**
 * Security hardening regressions:
 *   - bcrypt password hashing + legacy SHA-256 auto-rehash on login
 *   - rate limiting on /auth/login
 *   - Bearer prefix parsing rejects non-cnst_ tokens
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "crypto";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
} from "./helpers";
import { parseBearerToken } from "../src/auth/keys";
import {
  mergeFrameAncestors,
  ARTIFACT_SANDBOX_CSP,
} from "../src/shared/artifact-sandbox";

describe("parseBearerToken", () => {
  it("accepts a valid Bearer cnst_ token", () => {
    const ok = "Bearer cnst_" + "a".repeat(64);
    expect(parseBearerToken(ok)).toBe("cnst_" + "a".repeat(64));
  });

  it("rejects a missing header", () => {
    expect(parseBearerToken(undefined)).toBeNull();
    expect(parseBearerToken("")).toBeNull();
  });

  it("rejects Bearer with wrong prefix (no cnst_)", () => {
    expect(parseBearerToken("Bearer foo1234567890abcdef")).toBeNull();
    expect(parseBearerToken("Bearer sk-wrong-format")).toBeNull();
  });

  it("rejects Bearer cnst_ that is too short", () => {
    expect(parseBearerToken("Bearer cnst_short")).toBeNull();
  });

  it("rejects non-Bearer schemes", () => {
    expect(parseBearerToken("Basic xxx")).toBeNull();
    expect(parseBearerToken("cnst_" + "a".repeat(64))).toBeNull();
  });
});

describe("bcrypt password hashing + legacy rehash", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;

  beforeEach(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
  });

  afterEach(() => env.cleanup());

  it("stores a bcrypt hash on registration", async () => {
    await registerUser(app, "alice@example.com");
    // Crack open the DB — confirm the stored hash is bcrypt
    const { getDb } = await import("../src/db/client");
    const row = (await getDb().get(
      "SELECT password_hash FROM users WHERE email = ?",
      ["alice@example.com"],
    )) as { password_hash: string };
    expect(row.password_hash.startsWith("$2")).toBe(true);
  });

  it("logs in with bcrypt-hashed password", async () => {
    await registerUser(app, "alice@example.com");
    const { status } = await jsonRequest(app, "POST", "/auth/login", {
      email: "alice@example.com",
      password: "testpass",
    });
    expect(status).toBe(200);
  });

  it("accepts a legacy SHA-256 stored hash and silently rehashes to bcrypt", async () => {
    const { getDb } = await import("../src/db/client");
    const db = getDb();
    // Seed a user with the legacy format directly.
    const password = "legacy-secret";
    const salt = randomBytes(16).toString("hex");
    const legacyHash =
      salt + ":" + createHash("sha256").update(salt + password).digest("hex");
    await db.run(
      "INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)",
      ["u-legacy", "legacy@example.com", null, legacyHash],
    );

    const { status } = await jsonRequest(app, "POST", "/auth/login", {
      email: "legacy@example.com",
      password,
    });
    expect(status).toBe(200);

    // Hash should now be upgraded to bcrypt on disk.
    const row = (await db.get(
      "SELECT password_hash FROM users WHERE email = ?",
      ["legacy@example.com"],
    )) as { password_hash: string };
    expect(row.password_hash.startsWith("$2")).toBe(true);
    expect(bcrypt.compareSync(password, row.password_hash)).toBe(true);
  });

  it("rejects wrong passwords", async () => {
    await registerUser(app, "alice@example.com");
    const { status } = await jsonRequest(app, "POST", "/auth/login", {
      email: "alice@example.com",
      password: "WRONG",
    });
    expect(status).toBe(401);
  });
});

describe("rate limiting on /auth/login", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;

  beforeEach(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    await registerUser(app, "target@example.com");
  });

  afterEach(() => env.cleanup());

  it("returns 429 after repeated bad-password attempts on one email", async () => {
    // LOGIN_LIMIT = 5 per 15 min. 5 bad attempts → 401; 6th → 429.
    for (let i = 0; i < 5; i++) {
      const { status } = await jsonRequest(app, "POST", "/auth/login", {
        email: "target@example.com",
        password: "wrong",
      });
      expect(status).toBe(401);
    }
    const { status } = await jsonRequest(app, "POST", "/auth/login", {
      email: "target@example.com",
      password: "wrong",
    });
    expect(status).toBe(429);
  });

  it("successful logins never count toward the limit", async () => {
    // 10 good logins (2x the limit) — none should trip the guard.
    for (let i = 0; i < 10; i++) {
      const { status } = await jsonRequest(app, "POST", "/auth/login", {
        email: "target@example.com",
        password: "testpass",
      });
      expect(status).toBe(200);
    }
  });

  it("a successful login resets accumulated failures", async () => {
    // 4 bad (one short of limit), then a good login clears the counter,
    // so another 4 bad still return 401 rather than 429.
    for (let i = 0; i < 4; i++) {
      const { status } = await jsonRequest(app, "POST", "/auth/login", {
        email: "target@example.com",
        password: "wrong",
      });
      expect(status).toBe(401);
    }
    const ok = await jsonRequest(app, "POST", "/auth/login", {
      email: "target@example.com",
      password: "testpass",
    });
    expect(ok.status).toBe(200);
    for (let i = 0; i < 4; i++) {
      const { status } = await jsonRequest(app, "POST", "/auth/login", {
        email: "target@example.com",
        password: "wrong",
      });
      expect(status).toBe(401);
    }
  });
});

describe("clickjacking guard (CSP frame-ancestors)", () => {
  let env: ReturnType<typeof setupTestEnv>;

  beforeEach(() => {
    env = setupTestEnv();
  });

  afterEach(() => {
    delete process.env.FRAME_ANCESTORS;
    env.cleanup();
  });

  it("defaults to 'self' — no other site may frame the server", async () => {
    const app = await createTestApp("key");
    const res = await app.request("/health");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'self'",
    );
  });

  it("allows a configured embedding origin (e.g. the PromptOwl Data Room)", async () => {
    process.env.FRAME_ANCESTORS = "https://app.promptowl.ai";
    const app = await createTestApp("key");
    const res = await app.request("/health");
    expect(res.headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'self' https://app.promptowl.ai",
    );
  });
});

describe("mergeFrameAncestors", () => {
  const directive = "frame-ancestors 'self'";

  it("sets the directive when the response has no CSP", () => {
    expect(mergeFrameAncestors(null, directive)).toBe(directive);
    expect(mergeFrameAncestors("", directive)).toBe(directive);
  });

  it("appends without dropping the artifact sandbox policy", () => {
    const merged = mergeFrameAncestors(ARTIFACT_SANDBOX_CSP, directive);
    // The sandbox is what keeps attacker-authored artifact HTML off the
    // session — losing it here would be a silent security regression.
    expect(merged.startsWith(ARTIFACT_SANDBOX_CSP)).toBe(true);
    expect(merged).toContain("sandbox allow-scripts");
    expect(merged).toContain(directive);
  });

  it("leaves a policy that already sets frame-ancestors alone", () => {
    const own = "default-src 'none'; frame-ancestors https://example.com";
    expect(mergeFrameAncestors(own, directive)).toBe(own);
  });
});
