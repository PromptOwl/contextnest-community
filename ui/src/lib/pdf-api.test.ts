import { describe, it, expect, vi, afterEach } from "vitest";
import { createPdfNode, pdfUrl } from "./api";

// CU-wdqcq02pmh — the client half of PDF documents: the binary URL the viewer
// and Download point at, and the multipart upload the Upload/Replace actions send.

describe("pdfUrl", () => {
  it("points at the node's /pdf route with no query by default", () => {
    expect(pdfUrl("n1", "nodes/q3-report")).toBe("/nests/n1/nodes/nodes/q3-report/pdf");
  });

  it("carries version, approved_only and download when asked", () => {
    expect(pdfUrl("n1", "nodes/a", { version: 3 })).toBe("/nests/n1/nodes/nodes/a/pdf?version=3");
    expect(pdfUrl("n1", "nodes/a", { approvedOnly: true, download: true })).toBe(
      "/nests/n1/nodes/nodes/a/pdf?approved_only=1&download=1",
    );
  });
});

describe("createPdfNode", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the file + fields as multipart to /nodes/pdf", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ node: { id: "nodes/x" }, version: 1 }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "x.pdf", {
      type: "application/pdf",
    });
    const res = await createPdfNode("n1", file, {
      title: "X",
      folder: "gtm",
      tags: ["a", "b"],
      nodeId: "nodes/x",
    });
    expect(res.node.id).toBe("nodes/x");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/nests/n1/nodes/pdf");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect((form.get("file") as File).name).toBe("x.pdf");
    expect(form.get("title")).toBe("X");
    expect(form.get("folder")).toBe("gtm");
    expect(form.get("nodeId")).toBe("nodes/x");
    expect(form.getAll("tags")).toEqual(["a", "b"]);
  });

  it("sends a replace's change note, trimmed, and omits a blank one", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ node: { id: "nodes/x" }, version: 2 }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["x"], "x.pdf");
    await createPdfNode("n1", file, { nodeId: "nodes/x", changeNote: "  Signed copy  " });
    await createPdfNode("n1", file, { nodeId: "nodes/x", changeNote: "   " });
    const forms = fetchMock.mock.calls.map((c) => (c as unknown as [string, RequestInit])[1].body as FormData);
    expect(forms[0].get("changeNote")).toBe("Signed copy");
    expect(forms[1].has("changeNote")).toBe(false);
  });

  it("throws the server's error message on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "PDF too large (30.0 MB, max 25 MB)" }), { status: 413 })),
    );
    await expect(createPdfNode("n1", new File(["x"], "x.pdf"))).rejects.toThrow(/too large/);
  });
});
