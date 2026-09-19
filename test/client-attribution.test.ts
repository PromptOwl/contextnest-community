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
  resetAuthRateLimit,
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

describe("every path that seals a version carries it", () => {
  it("a revert records the client that asked for it", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Revert Me", content: "v1", client: { agent: "writer-agent" } },
      apiKey,
    );
    const nodeId = created.data.node.id;
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${nodeId}`,
      { content: "v2", client: { agent: "writer-agent" } },
      apiKey,
    );
    const { status } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${nodeId}/revert`,
      { targetVersion: 1, client: { agent: "reverting-agent" } },
      apiKey,
    );
    expect(status).toBe(200);
    const [latest] = await versionsOf(nodeId);
    expect(latest.client.agent).toBe("reverting-agent");
  });

  it("an import records it on every version row it seeds", async () => {
    const { status, data } = await jsonRequest(
      app,
      "POST",
      "/nests/import",
      {
        name: "Imported By Agent",
        files: [
          {
            path: "one.md",
            content: "---\ntitle: One\nstatus: published\n---\n\nbody",
          },
          {
            path: "two.md",
            content: "---\ntitle: Two\nstatus: published\n---\n\nbody",
          },
        ],
        client: { agent: "import-agent", session_id: "imp-1" },
      },
      apiKey,
    );
    expect(status).toBe(201);
    const importedNest = data.nest.id;
    for (const id of ["one", "two"]) {
      const { data: v } = await jsonRequest(
        app,
        "GET",
        `/nests/${importedNest}/nodes/${id}/versions`,
        undefined,
        apiKey,
      );
      expect(v.versions[0].client).toMatchObject({
        agent: "import-agent",
        session_id: "imp-1",
      });
    }
  });
});

describe("an approval seals its own version, with its own client", () => {
  // The one write path the rest of this file cannot reach: publishing through
  // review. The engine bumps the version the approval publishes, so the row it
  // seals is the REVIEWER's, not the author's — and each row has to keep the
  // attribution of the call that made it.
  let govNest: string;
  let author: { apiKey: string; email: string };
  let reviewer: { apiKey: string; email: string };

  beforeAll(async () => {
    await resetAuthRateLimit();
    author = await registerUser(app, "approval-author@example.com");
    await resetAuthRateLimit();
    reviewer = await registerUser(app, "approval-reviewer@example.com");
    const nest = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Approval Nest" },
      apiKey,
    );
    govNest = nest.data.nest.id;
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${govNest}/settings`,
      { stewardship_enabled: true },
      apiKey,
    );
    for (const [email, permission] of [
      [author.email, "write"],
      [reviewer.email, "read"],
    ]) {
      await jsonRequest(
        app,
        "POST",
        `/nests/${govNest}/collaborators`,
        { email, permission },
        apiKey,
      );
    }
    await jsonRequest(
      app,
      "POST",
      `/nests/${govNest}/stewards`,
      { scope: "nest", users: [{ email: reviewer.email, role: "reviewer" }] },
      apiKey,
    );
  });

  it("records the approver's client, and leaves the author's untouched", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${govNest}/nodes`,
      {
        title: "Needs Approval",
        content: "body",
        client: { agent: "author-agent" },
      },
      author.apiKey,
    );
    const nodeId = created.data.node.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${govNest}/nodes/${nodeId}/submit-review`,
      { note: "please review" },
      author.apiKey,
    );
    const approved = await jsonRequest(
      app,
      "POST",
      `/nests/${govNest}/nodes/${nodeId}/approve`,
      {
        note: "looks right",
        client: { agent: "approving-agent", session_id: "appr-1" },
      },
      reviewer.apiKey,
    );
    expect(approved.status).toBe(200);

    const { data } = await jsonRequest(
      app,
      "GET",
      `/nests/${govNest}/nodes/${nodeId}/versions`,
      undefined,
      apiKey,
    );
    const versions = data.versions as Array<Record<string, any>>;
    // The version the approval published carries the approver.
    expect(versions[0].editedBy).toBe(reviewer.email);
    expect(versions[0].client).toMatchObject({
      agent: "approving-agent",
      session_id: "appr-1",
    });
    // A later write never rewrites an earlier row's attribution.
    expect(versions[versions.length - 1].client).toEqual({
      agent: "author-agent",
    });
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
    // The prose half says it too — a chat client reads nothing else.
    expect(res.content[0].text).toContain("[via ctx-cli]");
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

describe("escaping — `client` is untrusted caller data", () => {
  // Every value here is stored verbatim into an append-only audit trail, read
  // back through a JSON column, served over REST and MCP, and rendered in the
  // UI. Verbatim is the whole contract: an audit record that silently rewrites
  // what the caller said is worse than no record.
  const HOSTILE: Record<string, string> = {
    sql: "'; DROP TABLE node_versions;--",
    quotes: 'he said "hi" \'twice\'',
    backslashes: "C:\\path\\to\\thing \\\" \\n",
    newlines: "line one\nline two\r\nline three\ttabbed",
    html: "<script>alert('xss')</script>",
    markdown: "**bold** `code` [link](http://x) \n# heading",
    json: '{"nested":"json","arr":[1,2]}',
    yaml: "*anchor &ref !!python/object:os.system",
    path: "../../etc/passwd",
    unicode: "café 日本語 🙂 \u202eRTL",
    template: "${process.env.SECRET} {{7*7}} <%= x %>",
  };

  it.each(Object.entries(HOSTILE))(
    "round-trips a %s payload byte for byte through version history",
    async (key, value) => {
      const { data } = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        {
          title: `Escape ${key}`,
          content: "body",
          client: { agent: value, session_id: `s-${key}` },
        },
        apiKey,
      );
      expect(data.node).toBeTruthy();
      const [latest] = await versionsOf(data.node.id);
      expect(latest.client.agent).toBe(value);
    },
  );

  it("leaves the table it was written to intact", async () => {
    // The SQL payload above went through a bound parameter, not string
    // interpolation. If it hadn't, this read is what would fail.
    const list = await versionsOf("nodes/escape-sql");
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].client.agent).toBe(HOSTILE.sql);
  });

  it("round-trips hostile values through the activity trace too", async () => {
    await callTool("context_search", {
      query: "Escape",
      client: { agent: HOSTILE.newlines, session_id: HOSTILE.quotes },
    });
    const { getDb } = await import("../src/db/client.js");
    const row = (await getDb().get(
      `SELECT client_json FROM api_events
        WHERE tool = 'context_search' AND client_json IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
    )) as { client_json: string } | undefined;
    expect(JSON.parse(row!.client_json)).toEqual({
      agent: HOSTILE.newlines,
      session_id: HOSTILE.quotes,
    });
  });

  it("serves hostile values back over MCP unchanged", async () => {
    await callTool("context_create", {
      title: "MCP Escape Doc",
      content: "body",
      client: { agent: HOSTILE.html, session_id: HOSTILE.markdown },
    });
    const res = await callTool("context_versions", { title: "MCP Escape Doc" });
    expect(res.structuredContent.versions[0].client).toMatchObject({
      agent: HOSTILE.html,
      session_id: HOSTILE.markdown,
    });
  });

  it("keeps a numeric-looking string a string", async () => {
    // Coercing "1.0" to 1 would lose characters from an audit record.
    const { data } = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "Numeric String Doc",
        content: "body",
        client: { agent: "a", version: "1.0", build: "007", n: 1 },
      },
      apiKey,
    );
    const [latest] = await versionsOf(data.node.id);
    expect(latest.client.version).toBe("1.0");
    expect(latest.client.build).toBe("007");
    expect(latest.client.n).toBe(1);
  });

  it("takes a value at the bound and refuses one past it", async () => {
    const ok = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "At The Bound",
        content: "body",
        client: { agent: "b".repeat(512) },
      },
      apiKey,
    );
    expect(ok.status).toBe(201);
    const [latest] = await versionsOf(ok.data.node.id);
    expect(latest.client.agent).toHaveLength(512);

    const over = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      {
        title: "Past The Bound",
        content: "body",
        client: { agent: "b".repeat(513) },
      },
      apiKey,
    );
    expect(over.status).toBe(400);
  });

  it.each([["sessionId"], ["session-id"], ["Agent"], ["SESSION_ID"], ["agent "]])(
    "refuses %s as a custom key rather than filing it silently",
    async (key) => {
      const { status, data } = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title: `Near Miss ${key}`, content: "body", client: { [key]: "x" } },
        apiKey,
      );
      expect(status).toBe(400);
      expect(String(data.error)).toContain("looks like the reserved key");
    },
  );

  it("trims a derived value without leaving half a character", async () => {
    // The 512th code unit lands mid-emoji. A plain slice would store the lone
    // high surrogate; the whole character is dropped instead. The bound itself
    // is in code units, so the result must still be <= 512.
    process.env.CONTEXTNEST_AGENT = "a".repeat(511) + "\u{1F642}";
    try {
      const { status, data } = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title: "Surrogate Boundary", content: "body" },
        apiKey,
      );
      expect(status).toBe(201);
      const [latest] = await versionsOf(data.node.id);
      expect(latest.client.agent).toBe("a".repeat(511));
      expect(latest.client.agent.length).toBeLessThanOrEqual(512);
      // No unpaired surrogate survived into the stored record.
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(latest.client.agent)).toBe(
        false,
      );
    } finally {
      delete process.env.CONTEXTNEST_AGENT;
    }
  });

  it("never lets a derived value break an otherwise valid call", async () => {
    // An operator can name an API key anything. A label past the engine's bound
    // is truncated, not turned into a 400 on every write that key makes.
    process.env.CONTEXTNEST_AGENT = "x".repeat(900);
    try {
      const { status, data } = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes`,
        { title: "Long Derived Agent", content: "body" },
        apiKey,
      );
      expect(status).toBe(201);
      const [latest] = await versionsOf(data.node.id);
      expect(latest.client.agent).toHaveLength(512);
    } finally {
      delete process.env.CONTEXTNEST_AGENT;
    }
  });
});

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
