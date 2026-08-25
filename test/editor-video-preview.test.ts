import { describe, it, expect } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { collectVideoPreviewDecorations } from "../ui/src/components/MarkdownEditor/extensions/VideoPreview";

// Model-only test — no DOM needed. Builds real ProseMirror docs from the
// editor's schema and asserts the video-preview decorator's behavior.
const schema = getSchema([StarterKit]);

const ASSET_URL = "/nests/abc123/assets/11111111-1111-1111-1111-111111111111.mp4";

describe("VideoPreview decorations", () => {
  it("decorates a paragraph whose sole content is a same-origin asset video URL", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text(ASSET_URL)]),
    ]);
    // 1 to hide the raw URL text + 1 widget for the <video> element.
    expect(collectVideoPreviewDecorations(doc).length).toBe(2);
  });

  it("does NOT decorate an external video-looking URL", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("https://evil.example.com/nests/x/assets/11111111-1111-1111-1111-111111111111.mp4"),
      ]),
    ]);
    expect(collectVideoPreviewDecorations(doc).length).toBe(0);
  });

  it("does NOT decorate a paragraph with the URL plus other text", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text(`see ${ASSET_URL}`)]),
    ]);
    expect(collectVideoPreviewDecorations(doc).length).toBe(0);
  });

  it("does NOT decorate a non-video asset URL", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("/nests/abc123/assets/11111111-1111-1111-1111-111111111111.png"),
      ]),
    ]);
    expect(collectVideoPreviewDecorations(doc).length).toBe(0);
  });

  it("does NOT decorate a non-uuid asset filename", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("/nests/abc123/assets/not-a-uuid.mp4"),
      ]),
    ]);
    expect(collectVideoPreviewDecorations(doc).length).toBe(0);
  });
});
