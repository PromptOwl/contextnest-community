/**
 * CU-wdqcq02pmh — PDFs as governed `pdf` documents.
 *
 * POST /nests/:id/nodes/pdf (multipart `file`) runs the engine's
 * context_import_pdf and then the SAME governance bookkeeping a normal create
 * / update does; GET /nests/:id/nodes/:nodeId/pdf serves the binary through
 * the node read path, so a public reader only ever gets the approved
 * version's bytes. The extracted text is the node body (what agents read);
 * it changes only by re-upload.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import {
  setupTestEnv,
  createTestApp,
  registerUser,
  jsonRequest,
  authed,
  resetAuthRateLimit,
} from "./helpers.js";
import { buildPdf, textPdf, textPdfV2, scannedPdf } from "./pdf-fixtures.js";

type User = { apiKey: string; userId: string; email: string };

function uploadPdf(
  app: any,
  nestId: string,
  apiKey: string | null,
  bytes: Uint8Array,
  fields: Record<string, string> = {},
  filename = "report.pdf",
) {
  const form = new FormData();
  form.append("file", new File([bytes], filename, { type: "application/pdf" }));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return app.request(`/nests/${nestId}/nodes/pdf`, {
    method: "POST",
    headers: apiKey ? authed(apiKey) : {},
    body: form,
  });
}

async function getPdf(app: any, url: string, apiKey?: string) {
  const res = await app.request(url, { headers: apiKey ? authed(apiKey) : {} });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { res, bytes };
}

/**
 * Make the engine's `context_update` throw once — the second step of a PDF
 * replace (after context_import_pdf has staged the new binary + text). The
 * dynamic import resolves the same module instance the app under test uses
 * (createTestApp resets modules before building it).
 */
async function failNextContextUpdate() {
  const eng = await import("../src/nodes/engine.js");
  const real = eng.engineApi.run.bind(eng.engineApi);
  const spy = vi.spyOn(eng.engineApi, "run").mockImplementation((async (
    op: string,
    input: unknown,
    ctx: unknown,
  ) => {
    if (op === "context_update") {
      spy.mockRestore();
      throw new Error("injected: disk full");
    }
    return (real as any)(op, input, ctx);
  }) as any);
  return spy;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Every .pdf under a nest's storage dir (sidecars + archived binaries). */
function pdfFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pdfFilesUnder(p));
    else if (entry.name.endsWith(".pdf")) out.push(p);
  }
  return out;
}

// ─── Suite A: upload, governance, validation (governed nest, key mode) ──────

describe("POST /nests/:id/nodes/pdf — governed upload", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: User;
  let editor: User;
  let viewer: User;
  let reviewer: User;
  let nestId: string;
  let pdfId: string;
  const TEXT_PDF = textPdf();

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@pdf.test", "Owner");
    editor = await registerUser(app, "editor@pdf.test", "Editor");
    viewer = await registerUser(app, "viewer@pdf.test", "Viewer");
    await resetAuthRateLimit();
    reviewer = await registerUser(app, "reviewer@pdf.test", "Reviewer");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "PDF Nest" }, owner.apiKey);
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
  });

  afterAll(() => env.cleanup());

  it("AC1: an editor's text PDF becomes a pdf node with the extracted text, governed like any create", async () => {
    const res = await uploadPdf(app, nestId, editor.apiKey, TEXT_PDF, {
      title: "Quarterly Report",
      tags: "finance, q3",
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    const node = data.node;
    pdfId = node.id;
    expect(node.id).toBe("nodes/quarterly-report");
    expect(node.type).toBe("pdf");
    expect(node.title).toBe("Quarterly Report");
    // Stored the way every tag is (normalized, # prefix).
    expect(node.tags).toEqual(expect.arrayContaining(["#finance", "#q3"]));
    expect(node.content).toContain("Revenue grew 12 percent.");
    expect(node.content).toContain("Methodology notes.");
    expect(node.pdf).toMatchObject({
      pages: 2,
      text_layer: true,
      bytes: TEXT_PDF.length,
    });
    expect(node.pdf.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The binary sits beside the .md.
    expect(
      existsSync(join(env.dataDir, "nests", nestId, "nodes", "quarterly-report.pdf")),
    ).toBe(true);

    // Stewardship decides the status exactly as it does for a normal create
    // by the same person in the same nest.
    const doc = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Plain Doc", content: "A normal document." },
      editor.apiKey,
    );
    expect(doc.status).toBe(201);
    const [pdfRead, docRead] = await Promise.all([
      jsonRequest(app, "GET", `/nests/${nestId}/nodes/${pdfId}`, undefined, owner.apiKey),
      jsonRequest(app, "GET", `/nests/${nestId}/nodes/${doc.data.node.id}`, undefined, owner.apiKey),
    ]);
    expect(pdfRead.data.node.status).toBe(docRead.data.node.status);
    // …and in a governed nest an editor's upload is not live without review.
    expect(pdfRead.data.node.status).not.toBe("published");
    const versions = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/${pdfId}/versions`,
      undefined,
      owner.apiKey,
    );
    expect(versions.status).toBe(200);
  });

  it("AC2: a viewer-tier user cannot upload (403) and nothing is written", async () => {
    const before = pdfFilesUnder(join(env.dataDir, "nests", nestId)).length;
    const res = await uploadPdf(app, nestId, viewer.apiKey, textPdfV2(), {
      title: "Sneaky Upload",
    });
    expect(res.status).toBe(403);
    expect(pdfFilesUnder(join(env.dataDir, "nests", nestId)).length).toBe(before);
    const read = await jsonRequest(
      app,
      "GET",
      `/nests/${nestId}/nodes/nodes/sneaky-upload`,
      undefined,
      owner.apiKey,
    );
    expect(read.status).toBe(404);
  });

  it("AC2: an unauthenticated upload is refused", async () => {
    const res = await uploadPdf(app, nestId, null, textPdfV2(), { title: "Anon" });
    expect(res.status).toBe(401);
  });

  it("AC3: a non-PDF is a 400 and nothing is written", async () => {
    const before = pdfFilesUnder(join(env.dataDir, "nests", nestId)).length;
    for (const [bytes, name] of [
      [new TextEncoder().encode("just some text, not a pdf"), "notes.pdf"],
      [new TextEncoder().encode("<html><script>alert(1)</script></html>"), "page.pdf"],
      [textPdf(), "report.txt"], // real PDF bytes, but the upload is judged on bytes: allowed
    ] as const) {
      const res = await uploadPdf(app, nestId, editor.apiKey, bytes, { title: `Bad ${name}` }, name);
      if (name === "report.txt") {
        // Magic bytes decide, not the extension — a PDF named .txt is a PDF.
        expect(res.status).toBe(201);
        continue;
      }
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toMatch(/pdf/i);
      const read = await jsonRequest(
        app,
        "GET",
        `/nests/${nestId}/nodes/nodes/bad-${name.replace(".", "-")}`,
        undefined,
        owner.apiKey,
      );
      expect(read.status).toBe(404);
    }
    // Only the .txt-named real PDF added a sidecar.
    expect(pdfFilesUnder(join(env.dataDir, "nests", nestId)).length).toBe(before + 1);
  });

  it("AC3: a missing file field is a 400", async () => {
    const form = new FormData();
    form.append("title", "No File");
    const res = await app.request(`/nests/${nestId}/nodes/pdf`, {
      method: "POST",
      headers: authed(editor.apiKey),
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it("AC3: an oversize PDF is a 413 and nothing is written", async () => {
    const prev = process.env.PDF_MAX_MB;
    process.env.PDF_MAX_MB = "1";
    try {
      const before = pdfFilesUnder(join(env.dataDir, "nests", nestId)).length;
      const big = buildPdf([{ lines: ["Big file"] }], { padBytes: 1024 * 1024 + 10 });
      const res = await uploadPdf(app, nestId, editor.apiKey, big, { title: "Too Big" });
      expect(res.status).toBe(413);
      const data = await res.json();
      expect(data.error).toMatch(/too large/i);
      expect(data.error).toContain("1 MB");
      expect(pdfFilesUnder(join(env.dataDir, "nests", nestId)).length).toBe(before);
      const read = await jsonRequest(
        app,
        "GET",
        `/nests/${nestId}/nodes/nodes/too-big`,
        undefined,
        owner.apiKey,
      );
      expect(read.status).toBe(404);
    } finally {
      if (prev === undefined) delete process.env.PDF_MAX_MB;
      else process.env.PDF_MAX_MB = prev;
    }
  });

  it("the PDF route is exempt from the global body cap up to PDF_MAX_MB", async () => {
    // 12 MB > MAX_BODY_BYTES (10 MB) but < the 25 MB PDF default.
    const big = buildPdf([{ lines: ["Twelve megabytes"] }], { padBytes: 12 * 1024 * 1024 });
    const res = await uploadPdf(app, nestId, owner.apiKey, big, { title: "Large But Allowed" });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.node.content).toContain("Twelve megabytes");
  }, 60_000);

  it("a scanned PDF (no text layer) imports with an empty body and text_layer false", async () => {
    const res = await uploadPdf(app, nestId, editor.apiKey, scannedPdf(), { title: "Scanned Contract" });
    expect(res.status).toBe(201);
    const { node } = await res.json();
    expect(node.type).toBe("pdf");
    expect(node.pdf.text_layer).toBe(false);
    expect(node.pdf.pages).toBe(1);
    expect(node.content.trim()).toBe("");
  });

  it("serves the current binary to the editor with safe headers", async () => {
    const { res, bytes } = await getPdf(app, `/nests/${nestId}/nodes/${pdfId}/pdf`, editor.apiKey);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="quarterly-report.pdf"');
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("etag")).toMatch(/^"sha256:[0-9a-f]{64}"$/);
    expect(sameBytes(bytes, TEXT_PDF)).toBe(true);

    // Revalidation: same ETag → 304, no body.
    const again = await app.request(`/nests/${nestId}/nodes/${pdfId}/pdf`, {
      headers: { ...authed(editor.apiKey), "If-None-Match": res.headers.get("etag")! },
    });
    expect(again.status).toBe(304);
  });

  it("GET /pdf on a node that is not a pdf is a 404", async () => {
    const res = await app.request(`/nests/${nestId}/nodes/nodes/plain-doc/pdf`, {
      headers: authed(owner.apiKey),
    });
    expect(res.status).toBe(404);
  });

  it("the PDF body is read-only through PATCH (content changes only by re-upload)", async () => {
    const patch = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${pdfId}`,
      { content: "Hand-edited extraction" },
      editor.apiKey,
    );
    expect(patch.status).toBe(409);
    expect(patch.data.error).toMatch(/re-upload|upload a new/i);
    const append = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${pdfId}`,
      { append: "More text" },
      editor.apiKey,
    );
    expect(append.status).toBe(409);
    const read = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${pdfId}`, undefined, owner.apiKey);
    expect(read.data.node.content).not.toContain("Hand-edited");
    expect(read.data.node.content).not.toContain("More text");
  });

  it("an echo of the stored body is not an edit (editor autosave stays harmless)", async () => {
    const read = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${pdfId}`, undefined, owner.apiKey);
    const patch = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${pdfId}`,
      { content: read.data.node.content, title: "Quarterly Report", tags: read.data.node.tags },
      editor.apiKey,
    );
    expect(patch.status).toBe(200);
    expect(patch.data.node.type).toBe("pdf");
  });

  it("cannot convert a pdf node to another type, or another type to pdf", async () => {
    const out = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${pdfId}`,
      { type: "document" },
      editor.apiKey,
    );
    expect(out.status).toBe(400);
    expect(out.data.error).toMatch(/pdf/i);
    const into = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/nodes/plain-doc`,
      { type: "pdf" },
      editor.apiKey,
    );
    expect(into.status).toBe(400);
    expect(into.data.error).toMatch(/pdf/i);
  });

  it("POST /nodes with type pdf (no file) is a clean 400 pointing at the upload route", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Typed Pdf", content: "text", type: "pdf" },
      editor.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/nodes\/pdf/);
  });

  it("re-upload with nodeId adds a new version of the same node", async () => {
    const res = await uploadPdf(app, nestId, editor.apiKey, textPdfV2(), { nodeId: pdfId });
    expect(res.status).toBe(200);
    const { node, version } = await res.json();
    expect(node.id).toBe(pdfId);
    expect(node.title).toBe("Quarterly Report");
    expect(node.content).toContain("Revenue grew 14 percent.");
    expect(version).toBeGreaterThan(1);
    const { bytes } = await getPdf(app, `/nests/${nestId}/nodes/${pdfId}/pdf`, editor.apiKey);
    expect(sameBytes(bytes, textPdfV2())).toBe(true);
  });

  it("re-upload onto a node that is not a pdf is refused", async () => {
    const res = await uploadPdf(app, nestId, editor.apiKey, textPdf(), { nodeId: "nodes/plain-doc" });
    expect(res.status).toBe(400);
    const read = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/plain-doc`, undefined, owner.apiKey);
    expect(read.data.node.type).toBe("document");
  });

  it("a viewer cannot re-upload over an existing pdf node", async () => {
    const res = await uploadPdf(app, nestId, viewer.apiKey, textPdf(), { nodeId: pdfId });
    expect(res.status).toBe(403);
  });

  it("moving a pdf node is refused rather than orphaning its binary", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${pdfId}/move`,
      { folder: "archive" },
      owner.apiKey,
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/pdf/i);
  });

  it("deleting a pdf node removes its binary", async () => {
    const created = await uploadPdf(app, nestId, owner.apiKey, textPdf({ title: "Disposable" }), {
      title: "Disposable Pdf",
    });
    expect(created.status).toBe(201);
    const sidecar = join(env.dataDir, "nests", nestId, "nodes", "disposable-pdf.pdf");
    expect(existsSync(sidecar)).toBe(true);
    const del = await jsonRequest(app, "DELETE", `/nests/${nestId}/nodes/nodes/disposable-pdf`, undefined, owner.apiKey);
    expect(del.status).toBe(200);
    expect(existsSync(sidecar)).toBe(false);
  });
});

// ─── Suite B: public nest serves the approved version's bytes ───────────────

describe("GET /nests/:id/nodes/:nodeId/pdf — public reader gets the approved binary", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let owner: User;
  let reviewer: User;
  let nestId: string;
  let pdfId: string;
  const V1 = textPdf();
  const V2 = textPdfV2();

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("key");
    owner = await registerUser(app, "owner@pubpdf.test", "Owner");
    reviewer = await registerUser(app, "reviewer@pubpdf.test", "Reviewer");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Public PDFs" }, owner.apiKey);
    nestId = nest.data.nest.id;
    // No stewards yet → v1 auto-publishes and is the approved version.
    const v1 = await uploadPdf(app, nestId, owner.apiKey, V1, { title: "Handbook" });
    expect(v1.status).toBe(201);
    pdfId = (await v1.json()).node.id;
    const approved = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${pdfId}`, undefined, owner.apiKey);
    expect(approved.data.node.status).toBe("published");

    // Turn stewardship on → the owner's re-upload lands as a draft v2.
    await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/collaborators`,
      { email: reviewer.email, permission: "read" },
      owner.apiKey,
    );
    const st = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/stewards`,
      { scope: "nest", users: [{ email: reviewer.email, role: "reviewer" }] },
      owner.apiKey,
    );
    expect([200, 201]).toContain(st.status);
    const v2 = await uploadPdf(app, nestId, owner.apiKey, V2, { nodeId: pdfId });
    expect(v2.status).toBe(200);
    const draft = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${pdfId}`, undefined, owner.apiKey);
    expect(draft.data.node.status).toBe("draft");
    expect(draft.data.node.content).toContain("Revenue grew 14 percent.");

    const vis = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/visibility`,
      { visibility: "public", acknowledge_public: true },
      owner.apiKey,
    );
    expect(vis.status).toBe(200);
  });

  afterAll(() => env.cleanup());

  it("AC4: an anonymous reader gets v1's bytes, never the v2 draft", async () => {
    const { res, bytes } = await getPdf(app, `/nests/${nestId}/nodes/${pdfId}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(sameBytes(bytes, V1)).toBe(true);
    expect(sameBytes(bytes, V2)).toBe(false);
  });

  it("an anonymous reader cannot ask for the draft version by number", async () => {
    const { res, bytes } = await getPdf(app, `/nests/${nestId}/nodes/${pdfId}/pdf?version=2`);
    // Either refused or pinned to the approved bytes — never the draft.
    if (res.status === 200) expect(sameBytes(bytes, V1)).toBe(true);
    else expect([403, 404]).toContain(res.status);
    expect(sameBytes(bytes, V2)).toBe(false);
  });

  it("the anonymous JSON read shows v1's text, matching the served binary", async () => {
    const res = await app.request(`/nests/${nestId}/nodes/${pdfId}`);
    expect(res.status).toBe(200);
    const { node } = await res.json();
    expect(node.content).toContain("Revenue grew 12 percent.");
    expect(node.content).not.toContain("14 percent");
    expect(node.pdf.sha256).toBe(
      (await (await app.request(`/nests/${nestId}/nodes/${pdfId}/pdf`)).headers.get("etag"))!.replace(/"/g, ""),
    );
  });

  it("the owner (draft access) gets the draft; ?version=1 and ?approved_only=1 give v1", async () => {
    const cur = await getPdf(app, `/nests/${nestId}/nodes/${pdfId}/pdf`, owner.apiKey);
    expect(sameBytes(cur.bytes, V2)).toBe(true);
    const old = await getPdf(app, `/nests/${nestId}/nodes/${pdfId}/pdf?version=1`, owner.apiKey);
    expect(old.res.status).toBe(200);
    expect(sameBytes(old.bytes, V1)).toBe(true);
    const pub = await getPdf(app, `/nests/${nestId}/nodes/${pdfId}/pdf?approved_only=1`, owner.apiKey);
    expect(sameBytes(pub.bytes, V1)).toBe(true);
  });

  it("an unknown version is a 404; a junk version is a 400", async () => {
    const missing = await app.request(`/nests/${nestId}/nodes/${pdfId}/pdf?version=99`, {
      headers: authed(owner.apiKey),
    });
    expect(missing.status).toBe(404);
    const junk = await app.request(`/nests/${nestId}/nodes/${pdfId}/pdf?version=abc`, {
      headers: authed(owner.apiKey),
    });
    expect(junk.status).toBe(400);
  });

  it("after approval the public reader gets v2", async () => {
    const submit = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${pdfId}/submit-review`,
      { note: "new edition" },
      owner.apiKey,
    );
    expect([200, 201]).toContain(submit.status);
    const approve = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${pdfId}/approve`,
      {},
      reviewer.apiKey,
    );
    expect(approve.status).toBe(200);
    const { res, bytes } = await getPdf(app, `/nests/${nestId}/nodes/${pdfId}/pdf`);
    expect(res.status).toBe(200);
    expect(sameBytes(bytes, V2)).toBe(true);
  });

  it("a replace whose second write fails leaves the node exactly as it was (draft branch)", async () => {
    const before = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${pdfId}`, undefined, owner.apiKey);
    const spy = await failNextContextUpdate();
    try {
      const v3 = buildPdf([{ lines: ["Doomed third edition."] }]);
      const res = await uploadPdf(app, nestId, owner.apiKey, v3, { nodeId: pdfId });
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    const after = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${pdfId}`, undefined, owner.apiKey);
    expect(after.data.node.content).toBe(before.data.node.content);
    expect(after.data.node.pdf.sha256).toBe(before.data.node.pdf.sha256);
    expect(after.data.node.version).toBe(before.data.node.version);
    expect(after.data.node.status).toBe(before.data.node.status);
    const cur = await getPdf(app, `/nests/${nestId}/nodes/${pdfId}/pdf`, owner.apiKey);
    expect(sameBytes(cur.bytes, V2)).toBe(true);
    const onDisk = new Uint8Array(
      readFileSync(join(env.dataDir, "nests", nestId, "nodes", "handbook.pdf")),
    );
    expect(sameBytes(onDisk, V2)).toBe(true);
  });

  it("discarding a draft re-upload restores the sealed PDF beside the node", async () => {
    const v3 = buildPdf([{ lines: ["Third edition, never approved."] }]);
    const up = await uploadPdf(app, nestId, owner.apiKey, v3, { nodeId: pdfId });
    expect(up.status).toBe(200);
    const drafted = await getPdf(app, `/nests/${nestId}/nodes/${pdfId}/pdf`, owner.apiKey);
    expect(sameBytes(drafted.bytes, v3)).toBe(true);
    const discard = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${pdfId}/discard`, {}, owner.apiKey);
    expect(discard.status).toBe(200);
    const cur = await getPdf(app, `/nests/${nestId}/nodes/${pdfId}/pdf`, owner.apiKey);
    expect(cur.res.status).toBe(200);
    expect(sameBytes(cur.bytes, V2)).toBe(true);
    // The live sidecar itself is the sealed binary again (no drift left behind).
    const onDisk = new Uint8Array(
      readFileSync(join(env.dataDir, "nests", nestId, "nodes", "handbook.pdf")),
    );
    expect(sameBytes(onDisk, V2)).toBe(true);
    const read = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/${pdfId}`, undefined, owner.apiKey);
    expect(read.data.node.content).toContain("Revenue grew 14 percent.");
  });

  it("a discard that cannot restore the sealed PDF says so in its response", async () => {
    const v3 = buildPdf([{ lines: ["Another unapproved edition."] }]);
    expect((await uploadPdf(app, nestId, owner.apiKey, v3, { nodeId: pdfId })).status).toBe(200);
    // Lose the archived copy of the sealed (v2) binary — only that one.
    const archive = join(env.dataDir, "nests", nestId, "nodes", ".versions", "handbook");
    const v2Hex = createHash("sha256").update(V2).digest("hex");
    rmSync(join(archive, `${v2Hex}.pdf`));
    const discard = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${pdfId}/discard`, {}, owner.apiKey);
    expect(discard.status).toBe(200);
    expect(discard.data.warning).toMatch(/PDF/);
    // Put the sealed binary back for the tests that follow (as an admin would).
    const { writeFileSync } = await import("fs");
    writeFileSync(join(env.dataDir, "nests", nestId, "nodes", "handbook.pdf"), V2);
  });

  it("reverting a pdf node to an old version restores that version's PDF and text", async () => {
    const res = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes/${pdfId}/revert`,
      { targetVersion: 1 },
      owner.apiKey,
    );
    expect(res.status).toBe(200);
    expect(res.data.node.content).toContain("Revenue grew 12 percent.");
    const cur = await getPdf(app, `/nests/${nestId}/nodes/${pdfId}/pdf`, owner.apiKey);
    expect(sameBytes(cur.bytes, V1)).toBe(true);
    // The public still sees the approved v2 until the revert is approved.
    const pub = await getPdf(app, `/nests/${nestId}/nodes/${pdfId}/pdf`);
    expect(sameBytes(pub.bytes, V2)).toBe(true);
  });

  it("a document whose own id ends in /pdf is still readable (route fall-through)", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "pdf", content: "A doc literally titled pdf.", folder: "guides" },
      owner.apiKey,
    );
    expect(created.status).toBe(201);
    expect(created.data.node.id).toBe("nodes/guides/pdf");
    const read = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/guides/pdf`, undefined, owner.apiKey);
    expect(read.status).toBe(200);
    expect(read.data.node.content).toContain("literally titled pdf");
  });

  it("regression: public reader still gets the approved body for a normal document", async () => {
    const created = await jsonRequest(
      app,
      "POST",
      `/nests/${nestId}/nodes`,
      { title: "Policy", content: "Approved policy text." },
      owner.apiKey,
    );
    expect(created.status).toBe(201);
    const id = created.data.node.id;
    const submit = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${id}/submit-review`, {}, owner.apiKey);
    expect([200, 201]).toContain(submit.status);
    const ok = await jsonRequest(app, "POST", `/nests/${nestId}/nodes/${id}/approve`, {}, reviewer.apiKey);
    expect(ok.status).toBe(200);
    const edit = await jsonRequest(
      app,
      "PATCH",
      `/nests/${nestId}/nodes/${id}`,
      { content: "DRAFT policy text." },
      owner.apiKey,
    );
    expect(edit.status).toBe(200);
    const anon = await app.request(`/nests/${nestId}/nodes/${id}`);
    const { node } = await anon.json();
    expect(node.content).toContain("Approved policy text.");
    expect(node.content).not.toContain("DRAFT");
  });
});

// ─── Suite C: agents read the extracted text ────────────────────────────────

describe("MCP context_get on a pdf node", () => {
  let env: ReturnType<typeof setupTestEnv>;
  let app: any;
  let nestId: string;

  async function callTool(name: string, args: Record<string, unknown>) {
    const res = await app.request(`/nests/${nestId}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(res.status).toBe(200);
    const ct = res.headers.get("content-type") || "";
    const payload = ct.includes("application/json")
      ? await res.json()
      : JSON.parse(
          (await res.text()).split("\n").find((l: string) => l.startsWith("data: "))!.slice(6),
        );
    expect(payload.error).toBeUndefined();
    return payload.result.content.map((c: any) => c.text).join("");
  }

  beforeAll(async () => {
    env = setupTestEnv();
    app = await createTestApp("open");
    const nest = await jsonRequest(app, "POST", "/nests", { name: "Agent PDFs" });
    nestId = nest.data.nest.id;
    expect((await uploadPdf(app, nestId, null, textPdf(), { title: "Board Deck" })).status).toBe(201);
    expect((await uploadPdf(app, nestId, null, scannedPdf(), { title: "Signed Scan" })).status).toBe(201);
  });

  afterAll(() => env.cleanup());

  it("AC5: returns the extracted text plus a source-file line", async () => {
    const text = await callTool("context_get", { id: "nodes/board-deck" });
    expect(text).toContain("**Type:** pdf");
    expect(text).toContain("**Source file:** PDF, 2 pages");
    expect(text).not.toContain("no text layer");
    expect(text).toContain("Revenue grew 12 percent.");
  });

  it("flags a scanned PDF as having no text layer", async () => {
    const text = await callTool("context_get", { id: "nodes/signed-scan" });
    expect(text).toContain("**Source file:** PDF, 1 page, no text layer");
  });

  it("a replace whose publish step fails leaves the node as it was (auto-publish branch)", async () => {
    const before = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/board-deck`);
    const spy = await failNextContextUpdate();
    try {
      const res = await uploadPdf(app, nestId, null, textPdfV2(), { nodeId: "nodes/board-deck" });
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    const after = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/board-deck`);
    expect(after.data.node.content).toBe(before.data.node.content);
    expect(after.data.node.pdf.sha256).toBe(before.data.node.pdf.sha256);
    expect(after.data.node.status).toBe("published");
    const cur = await getPdf(app, `/nests/${nestId}/nodes/nodes/board-deck/pdf`);
    expect(sameBytes(cur.bytes, textPdf())).toBe(true);
  });

  it("a replace in an ungoverned nest publishes the new version (auto-publish branch)", async () => {
    const res = await uploadPdf(app, nestId, null, textPdfV2(), { nodeId: "nodes/board-deck" });
    expect(res.status).toBe(200);
    const { node, version } = await res.json();
    expect(version).toBe(2);
    expect(node.status).toBe("published");
    const read = await jsonRequest(app, "GET", `/nests/${nestId}/nodes/nodes/board-deck`);
    expect(read.data.node.status).toBe("published");
    expect(read.data.node.version).toBe(2);
    const text = await callTool("context_get", { id: "nodes/board-deck" });
    expect(text).toContain("Revenue grew 14 percent.");
    // Same bytes again: a no-op, not a third version.
    const again = await uploadPdf(app, nestId, null, textPdfV2(), { nodeId: "nodes/board-deck" });
    expect(again.status).toBe(200);
    expect((await again.json()).version).toBe(2);
  });

  it("regression: a normal document's context_get has no source-file line", async () => {
    await jsonRequest(app, "POST", `/nests/${nestId}/nodes`, {
      title: "Plain",
      content: "Plain body.",
    });
    const text = await callTool("context_get", { id: "nodes/plain" });
    expect(text).toContain("Plain body.");
    expect(text).not.toContain("Source file");
  });
});
