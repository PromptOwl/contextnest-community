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

// YouTube / Vimeo embeds (CU-wdqcq02pmf). The markdown stays the bare URL;
// the decoration only paints an <iframe> player over it. Widgets carry a key
// so ProseMirror doesn't rebuild (and reload) the iframe on every keystroke.
describe("VideoPreview decorations — YouTube / Vimeo embeds", () => {
  const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const para = (...content: any[]) =>
    schema.node("doc", null, [schema.node("paragraph", null, content)]);
  const link = (href: string) => schema.marks.link.create({ href });
  const widgetKeys = (doc: any) =>
    collectVideoPreviewDecorations(doc)
      .map((d: any) => d.spec?.key)
      .filter(Boolean);

  it("decorates a paragraph that is only a bare YouTube URL with an embed widget", () => {
    const doc = para(schema.text(YT));
    expect(collectVideoPreviewDecorations(doc).length).toBe(2);
    expect(widgetKeys(doc)).toEqual([
      "video-embed:https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ]);
  });

  it("decorates a bare URL the editor has auto-linked (link mark, href === text)", () => {
    const doc = para(schema.text("https://vimeo.com/76979871", [link("https://vimeo.com/76979871")]));
    expect(widgetKeys(doc)).toEqual([
      "video-embed:https://player.vimeo.com/video/76979871",
    ]);
  });

  it("does NOT decorate a titled link to a video", () => {
    const doc = para(schema.text("Watch the demo", [link(YT)]));
    expect(collectVideoPreviewDecorations(doc).length).toBe(0);
  });

  it("does NOT decorate link text that disagrees with its href", () => {
    const doc = para(schema.text(YT, [link("https://evil.example.com/")]));
    expect(collectVideoPreviewDecorations(doc).length).toBe(0);
  });

  it("does NOT decorate a non-allowlisted or look-alike external URL", () => {
    expect(collectVideoPreviewDecorations(para(schema.text("https://example.com/watch?v=dQw4w9WgXcQ"))).length).toBe(0);
    expect(collectVideoPreviewDecorations(para(schema.text("https://youtube.com.evil.io/watch?v=dQw4w9WgXcQ"))).length).toBe(0);
  });

  it("does NOT decorate a video URL inside prose", () => {
    expect(collectVideoPreviewDecorations(para(schema.text(`see ${YT} later`))).length).toBe(0);
  });

  it("asset videos keep their <video> widget key", () => {
    expect(widgetKeys(para(schema.text(ASSET_URL)))).toEqual([`video-asset:${ASSET_URL}`]);
  });
});
