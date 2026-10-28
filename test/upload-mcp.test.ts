/**
 * Uploads without multipart — MCP `context_upload` and the JSON body on the
 * REST upload routes, one code path (src/nodes/upload-service.ts).
 *
 * Given/When/Then (ticket community-nest-upload-files-over-mcp-without-handling-binaries):
 *  - Given an editor over MCP, when they upload a png as base64, then it is
 *    stored as an asset and `![…](/nests/…/assets/<uuid>.png)` comes back.
 *  - Given a PDF URL, then a governed pdf document is created, as over REST.
 *  - Given a viewer, then it is refused (write tier).
 *  - Given an svg, exe or oversize file, then the error names the allowed
 *    types and caps.
 *  - Given a URL on a private or loopback address, then it is refused.
 *  - Given REST with a JSON body {filename, content_base64}, then it behaves
 *    the same as multipart.
 *  - API.md's video cap matches config.VIDEO_MAX_BYTES.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
  resetAuthRateLimit,
} from "./helpers.js";
import { textPdf } from "./pdf-fixtures.js";
import { buildPptx } from "./office-fixtures.js";

type User = { apiKey: string; userId: string; email: string };

// 1x1 transparent PNG.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

let env: ReturnType<typeof setupTestEnv>;
let app: any;
let root: User;
let owner: User;
let editor: User;
let viewer: User;
let reviewer: User;
let nestId: string;

async function callTool(
  apiKey: string,
  name: string,
  args: Record<string, unknown>,
  target = nestId,
): Promise<{ isError: boolean; text: string; data?: any }> {
  const res = await app.request(`/nests/${target}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const ct = res.headers.get("content-type") || "";
  const payload = ct.includes("application/json")
    ? await res.json()
    : JSON.parse((await res.text()).split("\n").find((l: string) => l.startsWith("data: "))!.slice(6));
  expect(payload.error).toBeUndefined();
  const result = payload.result;
  return {
    isError: !!result.isError,
    text: (result.content || []).map((c: any) => c.text).join(""),
    data: result.structuredContent,
  };
}

/** Stand in for the network: the next URL fetches answer with these bytes. */
async function serveUrl(bytes: Uint8Array, headers: Record<string, string> = {}) {
  const mod = await import("../src/nodes/upload-service.js");
  return vi.spyOn(mod.uploadNet, "fetch").mockImplementation(async () => new Response(bytes, { status: 200, headers }));
}

function nestFiles(sub: string): string[] {
  const dir = join(env.dataDir, "nests", nestId, sub);
  return existsSync(dir) ? readdirSync(dir) : [];
}

beforeAll(async () => {
  env = setupTestEnv();
  app = await createTestApp("key", { superAdmins: ["root@upload.test"] });
  root = await registerUser(app, "root@upload.test", "Root");
  owner = await registerUser(app, "owner@upload.test", "Owner");
  editor = await registerUser(app, "editor@upload.test", "Editor");
  await resetAuthRateLimit();
  viewer = await registerUser(app, "viewer@upload.test", "Viewer");
  reviewer = await registerUser(app, "reviewer@upload.test", "Reviewer");
  const nest = await jsonRequest(app, "POST", "/nests", { name: "Upload Nest" }, owner.apiKey);
  nestId = nest.data.nest.id;
  for (const [u, permission] of [
    [editor, "write"],
    [viewer, "read"],
    [reviewer, "read"],
  ] as const) {
    const r = await jsonRequest(app, "POST", `/nests/${nestId}/collaborators`, { email: u.email, permission }, owner.apiKey);
    expect([200, 201]).toContain(r.status);
  }
  const stewards = await jsonRequest(
    app,
    "POST",
    `/nests/${nestId}/stewards`,
    { scope: "nest", users: [{ email: reviewer.email, role: "reviewer" }] },
    owner.apiKey,
  );
  expect([200, 201]).toContain(stewards.status);
});

afterAll(() => env.cleanup());
afterEach(() => vi.restoreAllMocks());

describe("MCP context_upload", () => {
  it("is advertised to a writer, with the supported types in its description", async () => {
    const res = await app.request(`/nests/${nestId}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${editor.apiKey}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    const body = await res.json();
    const tool = body.result.tools.find((t: any) => t.name === "context_upload");
    expect(tool).toBeTruthy();
    expect(tool.description).toMatch(/pptx/);
    expect(Object.keys(tool.inputSchema.properties)).toEqual(
      expect.arrayContaining(["filename", "content_base64", "url", "title", "folder", "tags", "as"]),
    );
  });

  it("stores a base64 png as an asset and returns its markdown", async () => {
    const out = await callTool(editor.apiKey, "context_upload", { filename: "diagram.png", content_base64: PNG_B64 });
    expect(out.isError).toBe(false);
    expect(out.data.kind).toBe("image");
    expect(out.data.url).toMatch(new RegExp(`^/nests/${nestId}/assets/[0-9a-f-]{36}\\.png$`));
    expect(out.data.markdown).toBe(`![diagram](${out.data.url})`);
    expect(out.text).toContain(out.data.markdown);
    const served = await app.request(out.data.url, { headers: authed(viewer.apiKey) });
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(new Uint8Array(Buffer.from(PNG_B64, "base64")));
  });

  it("accepts a data: URL prefix on the base64", async () => {
    const out = await callTool(editor.apiKey, "context_upload", {
      filename: "dot.png",
      content_base64: `data:image/png;base64,${PNG_B64}`,
    });
    expect(out.isError).toBe(false);
    expect(out.data.markdown).toMatch(/^!\[dot\]\(/);
  });

  it("turns a PDF URL into a governed pdf document — a draft for an editor in a governed nest", async () => {
    const pdf = textPdf();
    const fetchSpy = await serveUrl(pdf, { "content-type": "application/pdf" });
    const out = await callTool(editor.apiKey, "context_upload", { url: "https://files.example.com/reports/Q3%20Report.pdf" });
    expect(out.isError).toBe(false);
    expect(fetchSpy).toHaveBeenCalledWith("https://files.example.com/reports/Q3%20Report.pdf", expect.any(Number));
    expect(out.data).toMatchObject({ kind: "pdf", id: "nodes/q3-report", title: "Q3 Report", type: "pdf" });
    expect(out.data.status).not.toBe("published");
    const read = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/q3-report`, undefined, owner.apiKey);
    expect(read.status).toBe(200);
    expect(read.data.node.content).toContain("Revenue grew 12 percent.");
    expect(read.data.node.pdf.bytes).toBe(pdf.length);
  });

  it("turns a pptx into a governed document with its original", async () => {
    const deck = await buildPptx([{ title: "Kickoff", bullets: ["Agenda"], notes: "Welcome everyone" }]);
    const out = await callTool(editor.apiKey, "context_upload", {
      filename: "Kickoff Deck.pptx",
      content_base64: b64(deck),
      folder: "decks",
      tags: ["kickoff"],
    });
    expect(out.isError).toBe(false);
    expect(out.data).toMatchObject({ kind: "office", id: "nodes/decks/kickoff-deck", type: "document" });
    expect(out.data.markdown).toBe("[[Kickoff Deck]]");
    expect(out.data.original.url).toMatch(new RegExp(`^/nests/${nestId}/originals/[0-9a-f-]{36}\\.pptx$`));
    const read = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${out.data.id}`, undefined, owner.apiKey);
    expect(read.data.node.content).toContain("## Slide 1: Kickoff");
    expect(read.data.node.content).toContain("Welcome everyone");
    expect(read.data.node.tags).toContain("#kickoff");
  });

  it("refuses a title already used in the nest, like context_create", async () => {
    const deck = await buildPptx([{ title: "Again" }]);
    const out = await callTool(editor.apiKey, "context_upload", { filename: "Kickoff Deck.pptx", content_base64: b64(deck) });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/already exists/);
  });

  it("refuses a viewer (write tier), and writes nothing", async () => {
    const before = nestFiles("assets").length;
    const out = await callTool(viewer.apiKey, "context_upload", { filename: "x.png", content_base64: PNG_B64 });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/permission/i);
    expect(nestFiles("assets").length).toBe(before);
  });

  it("refuses svg, exe and an oversize file, naming the allowed types and caps", async () => {
    for (const filename of ["logo.svg", "setup.exe"]) {
      const out = await callTool(editor.apiKey, "context_upload", { filename, content_base64: PNG_B64 });
      expect(out.isError, filename).toBe(true);
      expect(out.text).toMatch(/png, jpg, jpeg, gif, webp \(images, max 10 MB\)/);
      expect(out.text).toMatch(/pptx, docx/);
      expect(out.text).toMatch(/mp4, webm \(video, max 30 MB\)/);
    }
    // Over the type's cap: refused on the decoded size, before decoding.
    // (PDF_MAX_MB lowered so the MCP request stays under MAX_BODY_BYTES.)
    const prev = process.env.PDF_MAX_MB;
    process.env.PDF_MAX_MB = "1";
    try {
      const big = Buffer.alloc(1024 * 1024 + 1).toString("base64");
      const out = await callTool(editor.apiKey, "context_upload", { filename: "huge.pdf", content_base64: big });
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/PDF too large \(1\.0 MB, max 1 MB\)/);
    } finally {
      if (prev === undefined) delete process.env.PDF_MAX_MB;
      else process.env.PDF_MAX_MB = prev;
    }
  });

  it("refuses an oversize URL download on its declared length, and as it streams", async () => {
    await serveUrl(new Uint8Array(16), { "content-length": String(11 * 1024 * 1024) });
    const declared = await callTool(editor.apiKey, "context_upload", { url: "https://cdn.example.com/a.png" });
    expect(declared.isError).toBe(true);
    expect(declared.text).toMatch(/image too large .*max 10 MB/);
    vi.restoreAllMocks();
    await serveUrl(new Uint8Array(10 * 1024 * 1024 + 5));
    const streamed = await callTool(editor.apiKey, "context_upload", { url: "https://cdn.example.com/b.png" });
    expect(streamed.isError).toBe(true);
    expect(streamed.text).toMatch(/too large/);
  });

  it("refuses URLs on private, loopback and metadata addresses, and plain http — without connecting", async () => {
    for (const url of [
      "https://127.0.0.1/a.png",
      "https://[::1]/a.pdf",
      "https://169.254.169.254/latest/meta-data/x.png",
      "https://10.0.0.8/deck.pptx",
      "http://example.com/a.png",
    ]) {
      const out = await callTool(editor.apiKey, "context_upload", { url });
      expect(out.isError, url).toBe(true);
      expect(out.text, url).toMatch(/can't be fetched|https/);
    }
  });

  it("keeps the private-address fence up even when the metacognition dev switch is on", async () => {
    process.env.METACOGNITION_ALLOW_PRIVATE_URLS = "true";
    try {
      for (const url of ["https://127.0.0.1/a.png", "http://127.0.0.1/a.png"]) {
        const out = await callTool(editor.apiKey, "context_upload", { url });
        expect(out.isError, url).toBe(true);
        expect(out.text, url).toMatch(/can't be fetched|https/);
      }
    } finally {
      delete process.env.METACOGNITION_ALLOW_PRIVATE_URLS;
    }
  });

  it("refuses an `as` that contradicts the file, and needs exactly one source", async () => {
    const wrong = await callTool(editor.apiKey, "context_upload", { filename: "a.png", content_base64: PNG_B64, as: "document" });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/asset, not a document/);
    const both = await callTool(editor.apiKey, "context_upload", {
      filename: "a.png",
      content_base64: PNG_B64,
      url: "https://x.example.com/a.png",
    });
    expect(both.isError).toBe(true);
    expect(both.text).toMatch(/exactly one/);
    const none = await callTool(editor.apiKey, "context_upload", { filename: "a.png" });
    expect(none.isError).toBe(true);
  });
});

describe("REST upload routes take the same JSON body", () => {
  it("POST /assets with {filename, content_base64} answers like multipart", async () => {
    const json = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/assets`,
      { filename: "chart.png", content_base64: PNG_B64 },
      editor.apiKey,
    );
    expect(json.status).toBe(201);
    const form = new FormData();
    form.append("file", new File([Buffer.from(PNG_B64, "base64")], "chart.png", { type: "image/png" }));
    const multi = await app.request(`/nests/${nestId}/assets`, { method: "POST", headers: authed(editor.apiKey), body: form });
    expect(multi.status).toBe(201);
    const m = await multi.json();
    expect(Object.keys(json.data).sort()).toEqual(Object.keys(m).sort());
    expect(json.data.markdown).toBe(`![chart](${json.data.url})`);
    const svg = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/assets`,
      { filename: "x.svg", content_base64: PNG_B64 },
      editor.apiKey,
    );
    expect(svg.status).toBe(400);
    // The asset route takes images and video only.
    const pdf = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/assets`,
      { filename: "x.pdf", content_base64: b64(textPdf()) },
      editor.apiKey,
    );
    expect(pdf.status).toBe(400);
  });

  it("POST /nodes/pdf with {filename, content_base64} creates the pdf document", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/pdf`,
      { filename: "minutes.pdf", content_base64: b64(textPdf()), title: "Board Minutes", tags: ["board"] },
      editor.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.node).toMatchObject({ id: "nodes/board-minutes", type: "pdf" });
    expect(res.data.node.tags).toContain("#board");
  });

  it("POST /nodes/office with {url} fetches and creates the document", async () => {
    const deck = await buildPptx([{ title: "Fetched", bullets: ["From a URL"] }]);
    await serveUrl(deck);
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/office`,
      { url: "https://files.example.com/Fetched%20Deck.pptx" },
      editor.apiKey,
    );
    expect(res.status).toBe(201);
    expect(res.data.node.title).toBe("Fetched Deck");
    expect(res.data.node.content).toContain("From a URL");
  });

  it("a bad JSON body is a 400", async () => {
    const res = await app.request(`/nests/${nestId}/nodes/office`, {
      method: "POST",
      headers: { ...authed(editor.apiKey), "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("agent-write hold", () => {
  it("on a nest that holds agent writes, a key's document upload is refused, an asset is not", async () => {
    const gate = await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { require_push_confirmation: true }, root.apiKey);
    expect(gate.status).toBe(200);
    try {
      const doc = await callTool(owner.apiKey, "context_upload", { filename: "held.pdf", content_base64: b64(textPdf()) });
      expect(doc.isError).toBe(true);
      expect(doc.text).toMatch(/holds agent writes/);
      // Refused before the URL is fetched, as on REST.
      const fetchSpy = await serveUrl(textPdf());
      const byUrl = await callTool(owner.apiKey, "context_upload", { url: "https://files.example/held.pdf" });
      expect(byUrl.text).toMatch(/holds agent writes/);
      expect(fetchSpy).not.toHaveBeenCalled();
      const rest = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/nodes/pdf`,
        { filename: "held.pdf", content_base64: b64(textPdf()) },
        owner.apiKey,
      );
      expect(rest.status).toBe(403);
      const read = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/held`, undefined, owner.apiKey);
      expect(read.status).toBe(404);
      const asset = await callTool(owner.apiKey, "context_upload", { filename: "ok.png", content_base64: PNG_B64 });
      expect(asset.isError).toBe(false);
    } finally {
      await jsonRequest(app, "PATCH", `/nests/${nestId}/settings`, { require_push_confirmation: false }, root.apiKey);
    }
  });
});

describe("API.md", () => {
  it("documents the video cap the server enforces", async () => {
    const { config } = await import("../src/config.js");
    const api = readFileSync(join(process.cwd(), "API.md"), "utf8");
    const row = api.split("\n").find((l) => l.startsWith("| Video |"));
    expect(row).toBeTruthy();
    expect(row).toContain(`${config.VIDEO_MAX_BYTES / (1024 * 1024)} MB`);
    expect(api).not.toMatch(/\| Video \|[^\n]*100 MB/);
    expect(api).toContain("## Uploading files");
  });
});
