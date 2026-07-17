/**
 * CU-wdqcpzwf2k — GET /nests/:id/nodes/:nodeId?format=raw — direct raw fetch.
 *
 * The raw path returns the node BODY as text (no JSON envelope), with a
 * Content-Type picked per node type, optionally prefixed with the stored
 * YAML frontmatter block (?frontmatter=1). It rides the exact same
 * auth/access/grant pipeline as the JSON GET: a caller who would get a
 * restricted JSON response gets the same restricted content raw, and a
 * caller who would get 403/404 gets that error with zero body bytes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
} from "./helpers.js";
import { frontmatterBlockOf } from "../src/nodes/markdown-export.js";

// ─── Suite A: formats, content types, precedence (open mode) ─────────────

describe("?format=raw — body, content types, precedence", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let nestId: string;

  // node id + stored (JSON-served) body by type, filled in beforeAll. The
  // engine appends a trailing newline on publish, so parity is asserted
  // against the JSON GET's `content` — the raw path must be byte-identical
  // to what the JSON envelope carries.
  const ids: Record<string, string> = {};
  const stored: Record<string, string> = {};
  const bodies: Record<string, string> = {
    document: "# Hello\n\nThe document body.",
    agent: "You are a helpful agent. Do the thing.",
    skill: "## Skill steps\n\n1. First\n2. Second",
    artifact: "<h1>Deck</h1><p>Artifact HTML body</p>",
    tool: 'export async function run() { return "tool body"; }',
    table: "sku,price\nA,10\nB,20",
  };

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("open");
    const created = await jsonRequest(app, "POST", "/nests", {
      name: "Raw Fetch Nest",
    });
    nestId = created.data.nest.id;
    for (const [type, content] of Object.entries(bodies)) {
      const res = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
        title: `Raw ${type}`,
        content,
        type,
        tags: ["raw"],
      });
      expect(res.status).toBe(201);
      ids[type] = res.data.node.id;
      const read = await jsonRequest(
        app,
        "GET",
        `/nests/${nestId}/nodes/${ids[type]}`,
      );
      stored[type] = read.data.node.content;
      expect(stored[type]).toContain(content.slice(0, 20));
    }
  });

  afterAll(() => env.cleanup());

  const expectedContentType: Record<string, string> = {
    document: "text/markdown; charset=utf-8",
    agent: "text/markdown; charset=utf-8",
    skill: "text/markdown; charset=utf-8",
    artifact: "text/html; charset=utf-8",
    tool: "text/plain; charset=utf-8",
    table: "text/plain; charset=utf-8",
  };

  for (const type of Object.keys(expectedContentType)) {
    it(`serves a raw ${type} body with ${expectedContentType[type]}`, async () => {
      const res = await app.request(
        `/nests/${nestId}/nodes/${ids[type]}?format=raw`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(expectedContentType[type]);
      const text = await res.text();
      // Body only — byte-identical to the JSON GET's `content`, no JSON
      // envelope, no frontmatter block.
      expect(text).toBe(stored[type]);
      expect(text.startsWith("---")).toBe(false);
    });
  }

  it("?frontmatter=1 prepends the stored YAML block above the body", async () => {
    const res = await app.request(
      `/nests/${nestId}/nodes/${ids.document}?format=raw&frontmatter=1`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const text = await res.text();
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("Raw document"); // stored title line
    expect(text).toContain("type: document");
    // Body follows the closing delimiter, intact.
    expect(text.endsWith(stored.document)).toBe(true);
    // Exactly one frontmatter block.
    expect(text.split("\n---\n").length).toBe(2);
  });

  it("Accept: text/markdown triggers raw when no format param is present", async () => {
    const res = await app.request(`/nests/${nestId}/nodes/${ids.document}`, {
      headers: { Accept: "text/markdown" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await res.text()).toBe(stored.document);
  });

  it("Accept parsing is exact — a q-listed text/markdown matches, */* does not", async () => {
    const matched = await app.request(`/nests/${nestId}/nodes/${ids.document}`, {
      headers: { Accept: "application/json;q=0.8, text/markdown;q=0.9" },
    });
    expect(matched.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );

    const browserish = await app.request(
      `/nests/${nestId}/nodes/${ids.document}`,
      { headers: { Accept: "text/html,application/xhtml+xml,*/*" } },
    );
    expect(browserish.headers.get("content-type")).toContain("application/json");
  });

  it("format param wins over the Accept header", async () => {
    // format=markdown + Accept: text/markdown → the frontmatter+body export,
    // NOT the raw body.
    const md = await app.request(
      `/nests/${nestId}/nodes/${ids.document}?format=markdown`,
      { headers: { Accept: "text/markdown" } },
    );
    expect(md.headers.get("content-type")).toContain("text/markdown");
    const mdText = await md.text();
    expect(mdText.startsWith("---")).toBe(true); // export always has frontmatter

    // Any other format value + Accept: text/markdown → JSON (param wins).
    const json = await app.request(
      `/nests/${nestId}/nodes/${ids.document}?format=json`,
      { headers: { Accept: "text/markdown" } },
    );
    expect(json.headers.get("content-type")).toContain("application/json");

    // format=raw + Accept: text/markdown → raw (agreement, still raw).
    const raw = await app.request(
      `/nests/${nestId}/nodes/${ids.artifact}?format=raw`,
      { headers: { Accept: "text/markdown" } },
    );
    expect(raw.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await raw.text()).toBe(stored.artifact);
  });

  it("artifact raw is sandboxed with the SAME headers as /hosted", async () => {
    const raw = await app.request(
      `/nests/${nestId}/nodes/${ids.artifact}?format=raw`,
    );
    const hosted = await app.request(
      `/nests/${nestId}/nodes/${ids.artifact}/hosted`,
    );
    expect(raw.status).toBe(200);
    expect(hosted.status).toBe(200);
    // Exact parity with the hosted viewer — the policy must never drift.
    const csp = raw.headers.get("content-security-policy");
    expect(csp).toBe(hosted.headers.get("content-security-policy"));
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
    expect(raw.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("every raw response carries nosniff; non-artifacts get no sandbox CSP", async () => {
    for (const type of Object.keys(expectedContentType)) {
      const res = await app.request(
        `/nests/${nestId}/nodes/${ids[type]}?format=raw`,
      );
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      if (type !== "artifact") {
        expect(res.headers.get("content-security-policy")).toBeNull();
      }
    }
  });

  it("frontmatterBlockOf stops at the real closing delimiter — a --- hr right after frontmatter stays in the body", () => {
    // Unit-level: gray-matter (via the engine's parseDocument, the same
    // library the storage write path serializes with) closes frontmatter at
    // the FIRST `---` fence, so an hr at byte 0 of the body is not swallowed.
    const raw = "---\ntitle: X\n---\n---\n\nBody after hr\n";
    const block = frontmatterBlockOf(raw);
    expect(block).toBe("---\ntitle: X\n---\n");
    expect(block + "---\n\nBody after hr\n").toBe(raw); // block+body = stored bytes
    // No frontmatter at all → empty block, nothing invented.
    expect(frontmatterBlockOf("just a body\n")).toBe("");
  });

  it("frontmatter split survives a --- hr line inside the body (endpoint)", async () => {
    const hrBody = "Intro line\n\n---\n\nAfter the hr";
    const created = await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
      title: "HR Doc",
      content: hrBody,
    });
    expect(created.status).toBe(201);
    const id = created.data.node.id;
    const json = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${id}`);
    const jsonContent: string = json.data.node.content;
    expect(jsonContent).toContain("After the hr");

    const res = await app.request(
      `/nests/${nestId}/nodes/${id}?format=raw&frontmatter=1`,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    // Body is intact after the block (byte parity with the JSON content)…
    expect(text.endsWith(jsonContent)).toBe(true);
    // …and the extracted frontmatter block is ONLY the real frontmatter —
    // the body's `---` hr was not swallowed into it.
    const block = text.slice(0, text.length - jsonContent.length);
    expect(block.startsWith("---\n")).toBe(true);
    expect(block).toContain("HR Doc");
    expect(block).not.toContain("Intro line");
  });

  it("default JSON path is unchanged (regression)", async () => {
    const res = await app.request(`/nests/${nestId}/nodes/${ids.document}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const data = await res.json();
    expect(data.node.id).toBe(ids.document);
    expect(data.node.content).toBe(stored.document);
    expect(data.node.type).toBe("document");
  });

  it("404s raw for a missing node without leaking any body", async () => {
    const res = await app.request(
      `/nests/${nestId}/nodes/nodes/does-not-exist?format=raw`,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

// ─── Suite B: grants — raw fetch is gated exactly like the JSON GET ──────

describe("?format=raw under document grants (key mode)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string; email: string };
  let guest: { apiKey: string; userId: string; email: string };
  let nestId: string;
  const SECRET = "SIBLING_SECRET_BYTES";

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@raw.test", "Owner");
    guest = await registerUser(app, "guest@raw.test", "Guest");
    const nest = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Granted" },
      owner.apiKey,
    );
    nestId = nest.data.nest.id;
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Shared One", content: "# shared body" },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Sibling Secret", content: `# ${SECRET}` },
      owner.apiKey,
    );
    const grant = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/grants`,
      {
        target_type: "document",
        target: "nodes/shared-one",
        email: guest.email,
        role: "read",
      },
      owner.apiKey,
    );
    expect(grant.status).toBe(201);
  });

  afterAll(() => env.cleanup());

  it("grant-only caller can raw-fetch exactly their granted node", async () => {
    const res = await app.request(
      `/nests/${nestId}/nodes/nodes/shared-one?format=raw`,
      { headers: authed(guest.apiKey) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    // Byte-parity with the JSON GET's content field.
    const json = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/shared-one`,
      undefined,
      guest.apiKey,
    );
    expect(await res.text()).toBe(json.data.node.content);
  });

  it("grant-only caller is denied raw on the sibling — no body bytes leak", async () => {
    for (const suffix of [
      "?format=raw",
      "?format=raw&frontmatter=1",
      "", // JSON path denies identically
    ]) {
      const res = await app.request(
        `/nests/${nestId}/nodes/nodes/sibling-secret${suffix}`,
        { headers: { ...authed(guest.apiKey), Accept: "text/markdown" } },
      );
      expect([403, 404]).toContain(res.status);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.text()).not.toContain(SECRET);
    }
  });
});

// ─── Suite C: public reader — raw serves the approved snapshot only ──────

describe("?format=raw for public readers (approved snapshot only)", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: { apiKey: string; userId: string; email: string };
  let nestId: string;
  const APPROVED_BODY = "Approved: 100 req/min";
  const DRAFT_LEAK = "SECRET_DRAFT_LEAK 999 req/min";

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@pub.test", "Owner");
    const nest = await jsonRequest(
      app,
      "POST",
      "/nests",
      { name: "Public Docs" },
      owner.apiKey,
    );
    nestId = nest.data.nest.id;
    // No stewards → create auto-publishes and pins the approved version.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Rate Limits", content: APPROVED_BODY },
      owner.apiKey,
    );
    await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "public" },
      owner.apiKey,
    );
    // Diverge the working copy on disk — a draft edit that was never
    // approved. The approved-version pin stays where it was.
    writeFileSync(
      join(env.dataDir, "nests", nestId, "nodes", "rate-limits.md"),
      `---\ntitle: Rate Limits\nid: nodes/rate-limits\ntags: []\n---\n${DRAFT_LEAK}`,
    );
  });

  afterAll(() => env.cleanup());

  it("public reader raw fetch returns the approved snapshot body only", async () => {
    // Sanity: the divergence is real — the owner's raw read shows the draft
    // (same as their JSON read would).
    const ownerRaw = await app.request(
      `/nests/${nestId}/nodes/nodes/rate-limits?format=raw`,
      { headers: authed(owner.apiKey) },
    );
    expect(await ownerRaw.text()).toContain(DRAFT_LEAK);

    // Anonymous caller = public reader → approved body, never the draft.
    const res = await app.request(
      `/nests/${nestId}/nodes/nodes/rate-limits?format=raw`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const text = await res.text();
    expect(text).toContain(APPROVED_BODY);
    expect(text).not.toContain(DRAFT_LEAK);
  });

  it("public reader frontmatter=1 uses the approved snapshot's stored frontmatter", async () => {
    const res = await app.request(
      `/nests/${nestId}/nodes/nodes/rate-limits?format=raw&frontmatter=1`,
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.startsWith("---\n")).toBe(true);
    expect(text).toContain("title: Rate Limits");
    expect(text).toContain(APPROVED_BODY);
    expect(text).not.toContain(DRAFT_LEAK);
  });
});
