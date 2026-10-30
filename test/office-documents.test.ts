/**
 * Office documents — POST /nests/:id/nodes/office turns a .pptx/.docx into a
 * governed markdown document; GET /nests/:id/originals/:file serves the
 * uploaded file as an attachment, behind the document's own read gate.
 *
 * Given/When/Then (ticket community-nest-upload-pptx-and-docx-as-governed-documents):
 *  - Given a pptx, when uploaded, then a document with one section per slide
 *    (title, text, notes) and a link to the original is created.
 *  - Given a docx, then headings and tables become markdown.
 *  - Given a governed nest, then the upload lands as a draft for review.
 *  - Given a zip bomb or a malformed file, then 400 and nothing is written.
 *  - Given the original link, then it downloads as an attachment and needs
 *    read permission.
 *  - Given search, then slide text is found.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
  resetAuthRateLimit,
} from "./helpers.js";
import { buildDocx, buildPptx, buildXlsx, bombDocx } from "./office-fixtures.js";
import { OFFICE_MAX_XML_BYTES } from "../src/nodes/office-extract.js";

type User = { apiKey: string; userId: string; email: string };

function uploadOffice(
  app: any,
  nestId: string,
  apiKey: string | null,
  bytes: Uint8Array,
  filename: string,
  fields: Record<string, string> = {},
) {
  const form = new FormData();
  form.append("file", new File([bytes], filename));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return app.request(`/nests/${nestId}/nodes/office`, {
    method: "POST",
    headers: apiKey ? authed(apiKey) : {},
    body: form,
  });
}

function originalsUnder(dataDir: string, nestId: string): string[] {
  const dir = join(dataDir, "nests", nestId, ".originals");
  return existsSync(dir) ? readdirSync(dir) : [];
}

const DECK_SLIDES = Array.from({ length: 10 }, (_, i) => ({
  title: `Topic ${i + 1}`,
  bullets: [`Point for slide ${i + 1}`],
  notes: `Notes for slide ${i + 1}`,
}));
DECK_SLIDES[6].bullets = ["The quokka migration is on schedule"];

describe("POST /nests/:id/nodes/office — governed nest", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: User;
  let editor: User;
  let viewer: User;
  let reviewer: User;
  let outsider: User;
  let nestId: string;
  let deck: Uint8Array;
  let deckDoc: any;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@office.test", "Owner");
    editor = await registerUser(app, "editor@office.test", "Editor");
    viewer = await registerUser(app, "viewer@office.test", "Viewer");
    await resetAuthRateLimit();
    reviewer = await registerUser(app, "reviewer@office.test", "Reviewer");
    outsider = await registerUser(app, "outsider@office.test", "Outsider");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Office Nest" }, owner.apiKey);
    nestId = nest.data.nest.id;
    for (const [u, permission] of [
      [editor, "write"],
      [viewer, "read"],
      [reviewer, "read"],
    ] as const) {
      const r = await jsonRequest(
        app,
        "POST",
        `/nests/${nestId}/collaborators`,
        { email: u.email, permission },
        owner.apiKey,
      );
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
    deck = await buildPptx(DECK_SLIDES);
  });

  afterAll(() => env.cleanup());

  it("a pptx becomes a draft document with one section per slide and a link to the original", async () => {
    const res = await uploadOffice(app, nestId, editor.apiKey, deck, "Board Deck.pptx", { tags: "board, q3" });
    expect(res.status).toBe(201);
    const { node } = await res.json();
    deckDoc = node;
    expect(node.id).toBe("nodes/board-deck");
    expect(node.type).toBe("document");
    expect(node.title).toBe("Board Deck");
    expect(node.tags).toEqual(expect.arrayContaining(["#board", "#q3"]));
    // Governed nest: an editor's create is not live without review.
    expect(node.status).not.toBe("published");
    for (let i = 1; i <= 10; i++) {
      expect(node.content).toContain(`## Slide ${i}: Topic ${i}`);
      expect(node.content).toContain(`Notes for slide ${i}`);
    }
    expect(node.content.indexOf("## Slide 2:")).toBeLessThan(node.content.indexOf("## Slide 3:"));
    expect(node.original).toMatchObject({ filename: "Board Deck.pptx", kind: "pptx", bytes: deck.length });
    expect(node.original.file).toMatch(/^[0-9a-f-]{36}\.pptx$/);
    expect(node.content).toContain(`[Download the original](/nests/${nestId}/originals/${node.original.file})`);
    expect(originalsUnder(env.dataDir, nestId)).toEqual([node.original.file]);
  });

  it("the original downloads as an attachment, byte for byte, for someone who can read the document", async () => {
    const url = `/nests/${nestId}/originals/${deckDoc.original.file}`;
    const res = await app.request(url, { headers: authed(owner.apiKey) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="Board Deck\.pptx"/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(deck);
    const etag = res.headers.get("etag")!;
    const again = await app.request(url, { headers: { ...authed(owner.apiKey), "If-None-Match": etag } });
    expect(again.status).toBe(304);
  });

  it("the original follows the document's read gate", async () => {
    const url = `/nests/${nestId}/originals/${deckDoc.original.file}`;
    // Someone outside the nest gets nothing.
    const out = await app.request(url, { headers: authed(outsider.apiKey) });
    expect([403, 404]).toContain(out.status);
    // A nest viewer gets the file exactly when they can read the document.
    const doc = await app.request(`/nests/${nestId}/nodes/${deckDoc.id}`, { headers: authed(viewer.apiKey) });
    const orig = await app.request(url, { headers: authed(viewer.apiKey) });
    expect(orig.status === 200).toBe(doc.status === 200);
    // Names that aren't server-minted never reach the filesystem.
    const bad = await app.request(`/nests/${nestId}/originals/..%2F..%2Ftest.db`, { headers: authed(owner.apiKey) });
    expect([400, 404]).toContain(bad.status);
    // A well-formed name nothing binds is a 404.
    const unbound = await app.request(
      `/nests/${nestId}/originals/00000000-0000-4000-8000-000000000000.pptx`,
      { headers: authed(owner.apiKey) },
    );
    expect(unbound.status).toBe(404);
  });

  it("a moved document's link to its original still works", async () => {
    const moved = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${deckDoc.id}/move`,
      { folder: "archive" },
      owner.apiKey,
    );
    expect(moved.status).toBe(200);
    const res = await app.request(`/nests/${nestId}/originals/${deckDoc.original.file}`, {
      headers: authed(owner.apiKey),
    });
    expect(res.status).toBe(200);
  });

  it("a docx's headings and tables become markdown", async () => {
    const doc = await buildDocx([
      { heading: 1, text: "Travel policy" },
      { p: "Book through the portal." },
      { table: [["Class", "Allowed"], ["Economy", "Always"], ["Business", "Over 6 hours"]] },
    ]);
    const res = await uploadOffice(app, nestId, editor.apiKey, doc, "policy.docx", { folder: "hr" });
    expect(res.status).toBe(201);
    const { node } = await res.json();
    expect(node.id).toBe("nodes/hr/policy");
    expect(node.content).toContain("# Travel policy");
    expect(node.content).toContain("| Class | Allowed |\n| --- | --- |\n| Economy | Always |\n| Business | Over 6 hours |");
    expect(node.original.kind).toBe("docx");
  });

  it("an xlsx becomes one table per sheet, and its original downloads byte for byte", async () => {
    const book = await buildXlsx([
      { name: "Pipeline", rows: [["Account", "Stage"], ["Acme", "Won"]] },
      { name: "Owners", rows: [["Owner"], ["Kim"]] },
    ]);
    const res = await uploadOffice(app, nestId, editor.apiKey, book, "Q4 Pipeline.xlsx");
    expect(res.status).toBe(201);
    const { node } = await res.json();
    expect(node.original.kind).toBe("xlsx");
    expect(node.content).toContain("(Excel, 2 sheets)");
    expect(node.content).toContain("## Sheet: Pipeline\n\n| Account | Stage |\n| --- | --- |\n| Acme | Won |");
    expect(node.content).toContain("## Sheet: Owners");
    const dl = await app.request(`/nests/${nestId}/originals/${node.original.file}`, { headers: authed(owner.apiKey) });
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(book);
  });

  it("a viewer can't upload, and nothing is written", async () => {
    const before = originalsUnder(env.dataDir, nestId).length;
    const res = await uploadOffice(app, nestId, viewer.apiKey, deck, "Sneaky.pptx");
    expect(res.status).toBe(403);
    expect(originalsUnder(env.dataDir, nestId).length).toBe(before);
  });

  it("a zip bomb, a renamed .exe, a mismatched package and a legacy file are 400s and nothing is written", async () => {
    const before = originalsUnder(env.dataDir, nestId).length;
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, ...new Array(200).fill(7)]);
    const cases: Array<[Uint8Array, string]> = [
      [await bombDocx(OFFICE_MAX_XML_BYTES + 1024 * 1024), "bomb.docx"],
      [exe, "installer.pptx"],
      [await buildDocx([{ p: "x" }]), "renamed.pptx"],
      [deck, "legacy.ppt"],
    ];
    for (const [bytes, name] of cases) {
      const res = await uploadOffice(app, nestId, editor.apiKey, bytes, name);
      expect(res.status).toBe(400);
      const slug = name.replace(/\.\w+$/, "");
      const read = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/${slug}`, undefined, owner.apiKey);
      expect(read.status).toBe(404);
    }
    expect(originalsUnder(env.dataDir, nestId).length).toBe(before);
  });

  it("an oversize file is a 413 and nothing is written", async () => {
    const prev = process.env.OFFICE_MAX_MB;
    process.env.OFFICE_MAX_MB = "1";
    try {
      const before = originalsUnder(env.dataDir, nestId).length;
      const big = new Uint8Array(1024 * 1024 + 10);
      big.set([0x50, 0x4b, 0x03, 0x04]);
      const res = await uploadOffice(app, nestId, editor.apiKey, big, "big.pptx");
      expect(res.status).toBe(413);
      expect(originalsUnder(env.dataDir, nestId).length).toBe(before);
    } finally {
      if (prev === undefined) delete process.env.OFFICE_MAX_MB;
      else process.env.OFFICE_MAX_MB = prev;
    }
  });

  it("a missing file field is a 400", async () => {
    const form = new FormData();
    form.append("title", "No file");
    const res = await app.request(`/nests/${nestId}/nodes/office`, {
      method: "POST",
      headers: authed(editor.apiKey),
      body: form,
    });
    expect(res.status).toBe(400);
  });
});

describe("Office documents — ungoverned nest", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: User;
  let nestId: string;

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "solo@office.test", "Solo");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Solo Nest" }, owner.apiKey);
    nestId = nest.data.nest.id;
  });

  afterAll(() => env.cleanup());

  it("publishes, and search finds text from slide 7", async () => {
    const res = await uploadOffice(app, nestId, owner.apiKey, await buildPptx(DECK_SLIDES), "Roadmap.pptx");
    expect(res.status).toBe(201);
    const { node } = await res.json();
    expect(node.status).toBe("published");
    const search = await jsonRequest(app, "GET", `/nests/${nestId}/search?q=quokka`, undefined, owner.apiKey);
    expect(search.status).toBe(200);
    expect(search.data.nodes.map((n: any) => n.id)).toContain(node.id);
  });
});
