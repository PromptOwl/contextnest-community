import { describe, expect, it } from "vitest";
import {
  serializeImageNode,
  type ImageMarkdownNode,
  type ImageMarkdownState,
} from "./image-markdown-serializer";

// Minimal fake of prosemirror-markdown's MarkdownSerializerState — just
// enough of write/esc/closeBlock to assert what serializeImageNode does
// with them, without pulling in the real (unavailable in this test env)
// prosemirror-markdown package.
function fakeState() {
  const written: string[] = [];
  const closed: unknown[] = [];
  const state: ImageMarkdownState = {
    write: (content) => written.push(content),
    esc: (text) => text,
    closeBlock: (node) => closed.push(node),
  };
  return { state, written, closed };
}

function image(attrs: ImageMarkdownNode["attrs"]): ImageMarkdownNode {
  return { attrs };
}

describe("serializeImageNode", () => {
  it("writes standard markdown image syntax", () => {
    const { state, written } = fakeState();
    serializeImageNode(state, image({ src: "/nests/n1/assets/a.png" }));
    expect(written).toEqual(["![](/nests/n1/assets/a.png)"]);
  });

  it("includes alt and title when present", () => {
    const { state, written } = fakeState();
    serializeImageNode(
      state,
      image({ src: "https://x.test/a.png", alt: "A cat", title: "Cute" }),
    );
    expect(written).toEqual(['![A cat](https://x.test/a.png "Cute")']);
  });

  it("escapes parens in the src", () => {
    const { state, written } = fakeState();
    serializeImageNode(state, image({ src: "https://x.test/a(1).png" }));
    expect(written).toEqual(["![](https://x.test/a\\(1\\).png)"]);
  });

  it("closes its block so the next node gets a blank line before it", () => {
    // This is the regression: without closeBlock, a paragraph written right
    // after the image (e.g. a bare video URL) lands with no blank line
    // separating it, so on reparse CommonMark folds it into the image's
    // paragraph — see the file-level doc comment on serializeImageNode.
    const { state, closed } = fakeState();
    const node = image({ src: "/nests/n1/assets/a.png" });
    serializeImageNode(state, node);
    expect(closed).toEqual([node]);
  });
});
