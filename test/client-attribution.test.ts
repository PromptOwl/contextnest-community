/**
 * `client` — caller attribution on reads and writes (CONTEXT_NEST_SPEC §9.4).
 *
 * The three properties worth a test are the ones that are easy to break and
 * expensive to discover later:
 *
 *  1. it is recorded where a reader looks — on the version a write sealed, and
 *     on the activity trace every call lands on;
 *  2. it is OPTIONAL end to end — an unattributed call is a valid call, and is
 *     stored as absent rather than as an empty object;
 *  3. it is BOUNDED — the caller writes it into an append-only audit trail, and
 *     a near-miss on a reserved key is refused rather than filed as a custom
 *     key (which would leave the write silently unattributed).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
} from "./helpers";

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let nestId: string;
let apiKey: string;

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
let rpcId = 1;

async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const res = await app.request(`/nests/${nestId}/mcp`, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...authed(apiKey), ...headers },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const ct = res.headers.get("content-type") || "";
  const payload = ct.includes("application/json")
    ? (await res.json()).result
    : JSON.parse(
        (await res.text())
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice("data: ".length),
      ).result;
  return payload;
}

async function versionsOf(nodeId: string) {
  const { data } = await jsonRequest(
    app,
    "GET",
    `/nests/${nestId}/nodes/${nodeId}/versions`,
    undefined,
    apiKey,
  );
  return data.versions as Array<Record<string, any>>;
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key");
  const user = await registerUser(app, "attribution@example.com");
  apiKey = user.apiKey;
  const create = await jsonRequest(
    app,
    "POST",
    "/nests",
    { name: "Attribution Nest" },
    apiKey,
  );
  nestId = create.data.nest.id;
});

afterAll(async () => {
  delete process.env.CONTEXTNEST_NO_ATTRIBUTION;
  delete process.env.CONTEXTNEST_AGENT;
  await env.cleanup();
});

describe("REST writes", () => {
  it("records the caller's client on the version the write seals", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "Attributed Doc",
        content: "# Attributed\n\nbody.",
        client: { agent: "claude-code", session_id: "s-9f2", run: 7 },
      },
      apiKey,
    );
    expect(status).toBe(201);

    const [latest] = await versionsOf(data.node.id);
    expect(latest.client).toMatchObject({
      agent: "claude-code",
      session_id: "s-9f2",
      run: 7,
    });
    // The authoring record is untouched — `client` sits beside it, never
    // instead of it.
    expect(latest.editedBy).toBe("attribution@example.com");
  });

  it("carries a fresh client onto each later version", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "Second Writer",
        content: "v1",
        client: { agent: "first-agent" },
      },
      apiKey,
    );
    const nodeId = created.data.node.id;

    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content: "v2", client: { agent: "second-agent" } },
      apiKey,
    );

    const list = await versionsOf(nodeId);
    expect(list[0].client.agent).toBe("second-agent");
    expect(list[list.length - 1].client.agent).toBe("first-agent");
  });

  it("accepts a write with no client at all, and stores absence", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Unattributed Doc", content: "body" },
      apiKey,
    );
    expect(status).toBe(201);
    const [latest] = await versionsOf(data.node.id);
    // The key's label is what the transport derived (see the derivation
    // block below) — the point here is that no session was invented and the
    // block is never an empty object.
    expect(latest.client?.session_id).toBeUndefined();
    expect(latest.client).not.toEqual({});
  });

  it.each([
    ["a near-miss on a reserved key", { sessionId: "s-1" }],
    ["a non-scalar value", { agent: "x", extra: { nested: true } }],
    ["an over-long value", { agent: "a".repeat(513) }],
    [
      "too many custom keys",
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, i])),
    ],
  ])("refuses %s", async (_label, client) => {
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: `Bad Client ${_label}`, content: "body", client },
      apiKey,
    );
    expect(status).toBe(400);
  });
});

describe("MCP", () => {
  it("records the tool call's client, and serves it back on context_versions", async () => {
    await callTool("context_create", {
      title: "MCP Attributed",
      content: "# MCP\n\nbody.",
      client: { agent: "ctx-cli", session_id: "cli-42" },
    });

    const res = await callTool("context_versions", { title: "MCP Attributed" });
    const versions = res.structuredContent.versions;
    expect(versions[0].client).toMatchObject({
      agent: "ctx-cli",
      session_id: "cli-42",
    });
  });

  it("refuses an out-of-bounds client as a tool error, not a crash", async () => {
    const res = await callTool("context_create", {
      title: "MCP Bad Client",
      content: "body",
      client: { Agent: "claude-code" },
    });
    expect(res.isError).toBe(true);
    // Names the key the caller meant. A near-miss filed as a custom key would
    // "succeed" and leave the write unattributed, which is the failure this
    // refusal exists to prevent.
    expect(JSON.stringify(res)).toContain(
      "looks like the reserved key",
    );
    // And nothing was written.
    const list = await callTool("context_list", {});
    expect(JSON.stringify(list)).not.toContain("MCP Bad Client");
  });

  it("records attribution for a READ on the activity trace", async () => {
    await callTool("context_search", {
      query: "MCP",
      client: { agent: "reader-agent", session_id: "r-1" },
    });

    const { getDb } = await import("../src/db/client.js");
    const row = (await getDb().get(
      `SELECT client_json FROM api_events
        WHERE tool = 'context_search' AND client_json IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
    )) as { client_json: string } | undefined;
    expect(JSON.parse(row!.client_json)).toMatchObject({
      agent: "reader-agent",
      session_id: "r-1",
    });
  });
});

/** A Hono context stripped to what the binding reads. */
function fakeCtx(opts: { apiKeyLabel?: string; headers?: Record<string, string> } = {}) {
  return {
    get: (k: string) => (k === "apiKeyLabel" ? opts.apiKeyLabel : undefined),
    set: () => {},
    req: { header: (h: string) => opts.headers?.[h] },
  } as any;
}

describe("binding precedence (§9.4.2)", () => {
  it("prefers what the MCP connection reported over the API key's label", async () => {
    const { derivedClient } = await import("../src/shared/client-metadata.js");
    expect(
      derivedClient(fakeCtx({ apiKeyLabel: "key-label" }), {
        agent: "handshake-agent",
        session_id: "conn-1",
      }),
    ).toEqual({ agent: "handshake-agent", session_id: "conn-1" });
  });

  it("falls back to the key label when the connection reports nothing", async () => {
    const { derivedClient } = await import("../src/shared/client-metadata.js");
    // No session invented: a stateless connection has none to report, and a
    // placeholder is indistinguishable from a real id (§9.4.2).
    expect(derivedClient(fakeCtx({ apiKeyLabel: "key-label" }), {})).toEqual({
      agent: "key-label",
    });
  });

  it("lets env override the connection, and the caller override env", async () => {
    const { derivedClient, mergeClient } = await import(
      "../src/shared/client-metadata.js"
    );
    process.env.CONTEXTNEST_AGENT = "env-agent";
    try {
      const derived = derivedClient(fakeCtx({ apiKeyLabel: "key-label" }), {
        agent: "handshake-agent",
        session_id: "conn-1",
      });
      expect(derived.agent).toBe("env-agent");
      expect(
        mergeClient(derived, { agent: "caller-agent" }),
      ).toEqual({ agent: "caller-agent", session_id: "conn-1" });
    } finally {
      delete process.env.CONTEXTNEST_AGENT;
    }
  });

  it("derives nothing at all under the opt-out, connection included", async () => {
    const { derivedClient } = await import("../src/shared/client-metadata.js");
    process.env.CONTEXTNEST_NO_ATTRIBUTION = "1";
    try {
      expect(
        derivedClient(fakeCtx({ apiKeyLabel: "key-label" }), {
          agent: "handshake-agent",
        }),
      ).toEqual({});
    } finally {
      delete process.env.CONTEXTNEST_NO_ATTRIBUTION;
    }
  });
});

describe("derived defaults (§9.4.2)", () => {
  it("names the agent from what the operator called the API key", async () => {
    const { data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Derived Agent Doc", content: "body" },
      apiKey,
    );
    const [latest] = await versionsOf(data.node.id);
    expect(latest.client.agent).toBe("test"); // registerUser's key label
  });

  it("merges per key — a caller's agent keeps its own, and still gains the rest", async () => {
    process.env.CONTEXTNEST_SESSION_ID = "env-session";
    try {
      const { data } = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        {
          title: "Per Key Merge Doc",
          content: "body",
          client: { agent: "caller-agent" },
        },
        apiKey,
      );
      const [latest] = await versionsOf(data.node.id);
      expect(latest.client).toMatchObject({
        agent: "caller-agent", // caller wins
        session_id: "env-session", // still gained
      });
    } finally {
      delete process.env.CONTEXTNEST_SESSION_ID;
    }
  });

  it("derives nothing under CONTEXTNEST_NO_ATTRIBUTION, but keeps what the caller sent", async () => {
    process.env.CONTEXTNEST_NO_ATTRIBUTION = "1";
    try {
      const bare = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title: "Opted Out Doc", content: "body" },
        apiKey,
      );
      const [bareVersion] = await versionsOf(bare.data.node.id);
      expect(bareVersion.client).toBeUndefined();

      const explicit = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        {
          title: "Opted Out But Explicit",
          content: "body",
          client: { agent: "caller-said-so" },
        },
        apiKey,
      );
      const [explicitVersion] = await versionsOf(explicit.data.node.id);
      expect(explicitVersion.client).toEqual({ agent: "caller-said-so" });
    } finally {
      delete process.env.CONTEXTNEST_NO_ATTRIBUTION;
    }
  });
});
