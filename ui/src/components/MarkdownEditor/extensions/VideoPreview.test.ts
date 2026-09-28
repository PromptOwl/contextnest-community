import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { findBackspaceIntoVideo } from "./VideoPreview";

// Minimal schema — just enough to build the doc/paragraph/text/link shapes
// findBackspaceIntoVideo cares about. No view/DOM involved, so this is
// unit-testable the same way collectVideoPreviewDecorations's own doc-only
// design is.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
  },
  marks: {
    link: { attrs: { href: {} } },
  },
});

const YT = "https://youtu.be/dQw4w9WgXcQ";

function paragraph(text: string, href?: string) {
  const marks = href ? [schema.marks.link.create({ href })] : [];
  return schema.nodes.paragraph.create(null, schema.text(text, marks));
}

describe("findBackspaceIntoVideo", () => {
  it("targets the start of the video paragraph (to select it) instead of merging", () => {
    const video = paragraph(YT);
    const doc = schema.nodes.doc.create(null, [video, paragraph("Hello")]);
    const from = video.nodeSize + 1; // start of the paragraph after the video
    expect(findBackspaceIntoVideo(doc, from)).toEqual({ pos: 0 });
  });

  it("does nothing when the caret isn't at the start of the paragraph", () => {
    const video = paragraph(YT);
    const doc = schema.nodes.doc.create(null, [video, paragraph("Hello")]);
    const from = video.nodeSize + 2; // one char into "Hello"
    expect(findBackspaceIntoVideo(doc, from)).toBeNull();
  });

  it("does nothing when the previous paragraph is ordinary text", () => {
    const first = paragraph("Intro");
    const doc = schema.nodes.doc.create(null, [first, paragraph("Hello")]);
    expect(findBackspaceIntoVideo(doc, first.nodeSize + 1)).toBeNull();
  });

  it("does nothing at the very start of the document", () => {
    const doc = schema.nodes.doc.create(null, [paragraph("Hello")]);
    expect(findBackspaceIntoVideo(doc, 1)).toBeNull();
  });

  it("recognises a same-origin asset video paragraph", () => {
    const asset = "/nests/abc123/assets/11111111-1111-1111-1111-111111111111.mp4";
    const video = paragraph(asset);
    const doc = schema.nodes.doc.create(null, [video, paragraph("Hello")]);
    expect(findBackspaceIntoVideo(doc, video.nodeSize + 1)).toEqual({
      pos: 0,
    });
  });

  it("recognises a link-marked video URL whose text matches its href", () => {
    const video = paragraph(YT, YT);
    const doc = schema.nodes.doc.create(null, [video, paragraph("Hello")]);
    expect(findBackspaceIntoVideo(doc, video.nodeSize + 1)).toEqual({
      pos: 0,
    });
  });

  it("does not trigger for a titled link whose text disagrees with its href", () => {
    const notAVideo = paragraph("Watch the demo", YT);
    const doc = schema.nodes.doc.create(null, [notAVideo, paragraph("Hello")]);
    expect(findBackspaceIntoVideo(doc, notAVideo.nodeSize + 1)).toBeNull();
  });
});
