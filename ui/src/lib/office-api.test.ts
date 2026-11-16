import { describe, it, expect, vi, afterEach } from "vitest";
import { createOfficeNode } from "./api";

// The client half of Office uploads: a .pptx/.docx goes to /nodes/office as
// multipart, the same shape as the PDF upload.

describe("createOfficeNode", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the file + fields as multipart to /nodes/office", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ node: { id: "nodes/deck" }, version: 1 }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "deck.pptx");
    const res = await createOfficeNode("n1", file, { title: "Deck", folder: "gtm", tags: ["a"] });
    expect(res.node.id).toBe("nodes/deck");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/nests/n1/nodes/office");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect((form.get("file") as File).name).toBe("deck.pptx");
    expect(form.get("title")).toBe("Deck");
    expect(form.get("folder")).toBe("gtm");
    expect(form.getAll("tags")).toEqual(["a"]);
  });

  it("throws the server's error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "not a pptx" }), { status: 400 })));
    await expect(createOfficeNode("n1", new File(["x"], "x.pptx"))).rejects.toThrow("not a pptx");
  });
});
