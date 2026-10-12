/**
 * A PromptOwl shared agent runs on its OWNER's ticket (`sub`) while someone
 * else drives the chat (`act`). The held push names who asked, and keeps the
 * owner as the account behind the write.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "crypto";
import { setupTestEnv, createTestApp, registerUser, jsonRequest } from "./helpers.js";

const SECRET = "official-sso-secret-abcdef";
const BASE_URL = "https://community.test";

const b64url = (input: string | Buffer) =>
  Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

function ticket(over: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64url(
    JSON.stringify({ sub: "owner@acme.com", aud: BASE_URL, scope: "mcp", iat: now, exp: now + 300, ...over }),
  );
  return `${h}.${p}.${b64url(createHmac("sha256", SECRET).update(`${h}.${p}`).digest())}`;
}

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let root: { apiKey: string };
let owner: { apiKey: string };

beforeAll(async () => {
  env = setupTestEnv();
  process.env.OFFICIAL_COMMUNITY_SSO_SECRET = SECRET;
  process.env.PUBLIC_BASE_URL = BASE_URL;
  app = await createTestApp("key", { superAdmins: ["root@acme.com"] });
  root = await registerUser(app, "root@acme.com", "Root");
  owner = await registerUser(app, "owner@acme.com", "Owner");
});

afterAll(() => {
  delete process.env.OFFICIAL_COMMUNITY_SSO_SECRET;
  delete process.env.PUBLIC_BASE_URL;
  env.cleanup();
});

async function heldLabel(nestId: string, token: string, title: string): Promise<string> {
  await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "context_create", arguments: { title, content: "x" } },
    }),
  });
  const queue = await jsonRequest(app, "GET", `/nests/${nestId}/pending-pushes?status=pending`, undefined, owner.apiKey);
  const push = queue.data.pending_pushes.find((p: any) => p.manifest?.[0]?.title === title) ?? queue.data.pending_pushes.at(-1);
  return push.submitter_label;
}

describe("held push from a shared agent", () => {
  it("names the person driving the agent, and the owner behind it", async () => {
    const { data } = await jsonRequest(app, "POST", "/nests", { name: "shared-agent" }, owner.apiKey);
    const nestId = data.nest.id;
    await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { require_push_confirmation: true }, root.apiKey);

    expect(await heldLabel(nestId, ticket({ act: "hiren@acme.com" }), "Driven")).toBe(
      "hiren@acme.com via owner@acme.com's agent",
    );
    // Owner's own run, and a garbage act, both stay attributed to the owner.
    expect(await heldLabel(nestId, ticket({ act: "owner@acme.com" }), "Own")).toBe("owner@acme.com");
    expect(await heldLabel(nestId, ticket({ act: "not an email" }), "Junk")).toBe("owner@acme.com");
  });
});
