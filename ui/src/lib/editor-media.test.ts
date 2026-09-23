/**
 * Making image / video insertion obvious in the editor — the pure decisions
 * behind the toolbar menu, the drag-over overlay, clipboard paste and the
 * empty-document placeholder. The React wiring in MarkdownEditor.tsx only
 * reads these, so read-only / locked / preview docs are guarded in one place.
 */
import { describe, it, expect } from "vitest";
import {
  MEDIA_FILE_RE,
  MEDIA_HELPER_TEXT,
  DEFAULT_PLACEHOLDER,
  MEDIA_PLACEHOLDER,
  mediaAffordances,
  editorPlaceholder,
  isFileDrag,
  pickMediaFile,
  validateEmbedInput,
  shouldUploadPastedMedia,
} from "./editor-media";

describe("mediaAffordances — who sees the image/video controls", () => {
  it("an editable doc with an uploader gets upload, embed and the drop overlay", () => {
    expect(mediaAffordances({ editable: true, previewing: false, canUpload: true })).toEqual({
      upload: true,
      embed: true,
      dropOverlay: true,
    });
  });

  it("an editable doc without an uploader can still embed a link, but not upload/drop", () => {
    expect(mediaAffordances({ editable: true, previewing: false, canUpload: false })).toEqual({
      upload: false,
      embed: true,
      dropOverlay: false,
    });
  });

  it("regression: a read-only / locked doc shows none of them", () => {
    expect(mediaAffordances({ editable: false, previewing: false, canUpload: true })).toEqual({
      upload: false,
      embed: false,
      dropOverlay: false,
    });
  });

  it("regression: preview mode shows none of them", () => {
    expect(mediaAffordances({ editable: true, previewing: true, canUpload: true })).toEqual({
      upload: false,
      embed: false,
      dropOverlay: false,
    });
  });
});

describe("editorPlaceholder", () => {
  it("the default placeholder mentions images, videos and YouTube when uploads work", () => {
    const p = editorPlaceholder(undefined, true);
    expect(p).toBe(MEDIA_PLACEHOLDER);
    expect(p).toMatch(/image/i);
    expect(p).toMatch(/video/i);
    expect(p).toMatch(/YouTube/);
  });

  it("without an uploader it doesn't promise drag-and-drop", () => {
    expect(editorPlaceholder(undefined, false)).toBe(DEFAULT_PLACEHOLDER);
    expect(DEFAULT_PLACEHOLDER).not.toMatch(/drop/i);
  });

  it("regression: a caller's own placeholder is used verbatim", () => {
    expect(editorPlaceholder("Describe the agent…", true)).toBe("Describe the agent…");
    expect(editorPlaceholder("Describe the agent…", false)).toBe("Describe the agent…");
  });
});

describe("MEDIA_HELPER_TEXT", () => {
  it("names the accepted types and both size caps", () => {
    expect(MEDIA_HELPER_TEXT).toBe("PNG, JPG, GIF, WebP up to 10 MB · MP4, WebM up to 30 MB");
  });
});

describe("isFileDrag — only a file drag lights the overlay", () => {
  it("true when the drag carries files", () => {
    expect(isFileDrag(["Files"])).toBe(true);
    expect(isFileDrag(["text/plain", "Files"])).toBe(true);
  });
  it("false for text / in-editor block drags", () => {
    expect(isFileDrag(["text/plain", "text/html"])).toBe(false);
    expect(isFileDrag([])).toBe(false);
    expect(isFileDrag(undefined)).toBe(false);
  });
});

describe("pickMediaFile — which pasted/dropped file uploads", () => {
  const f = (name: string) => ({ name });
  it("picks the first allowlisted image or video", () => {
    expect(pickMediaFile([f("image.png")])?.name).toBe("image.png");
    expect(pickMediaFile([f("notes.txt"), f("clip.webm")])?.name).toBe("clip.webm");
  });
  it("ignores anything else (svg stays excluded, like the server)", () => {
    expect(pickMediaFile([f("logo.svg")])).toBeNull();
    expect(pickMediaFile([f("data.csv")])).toBeNull();
    expect(pickMediaFile([])).toBeNull();
    expect(pickMediaFile(null)).toBeNull();
  });
  it("regression: the upload allowlist is unchanged", () => {
    for (const ok of ["a.png", "a.jpg", "a.JPEG", "a.gif", "a.webp", "a.mp4", "a.webm"]) {
      expect(MEDIA_FILE_RE.test(ok)).toBe(true);
    }
    for (const no of ["a.svg", "a.mov", "a.pdf", "a.png.exe"]) {
      expect(MEDIA_FILE_RE.test(no)).toBe(false);
    }
  });
});

describe("validateEmbedInput — the 'Embed YouTube or Vimeo link' box", () => {
  it("accepts a YouTube or Vimeo URL and inserts it as written", () => {
    expect(validateEmbedInput("  https://youtu.be/dQw4w9WgXcQ  ")).toEqual({
      ok: true,
      url: "https://youtu.be/dQw4w9WgXcQ",
    });
    expect(validateEmbedInput("https://vimeo.com/76979871")).toEqual({
      ok: true,
      url: "https://vimeo.com/76979871",
    });
  });

  it("adds https:// to a scheme-less link so the bare URL still embeds", () => {
    expect(validateEmbedInput("youtu.be/dQw4w9WgXcQ")).toEqual({
      ok: true,
      url: "https://youtu.be/dQw4w9WgXcQ",
    });
    expect(validateEmbedInput("www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({
      ok: true,
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
  });

  it("empty input asks for a link", () => {
    expect(validateEmbedInput("   ")).toEqual({ ok: false, error: "Paste a YouTube or Vimeo link." });
  });

  it.each([
    "https://example.com/video",
    "https://youtube.com.evil.io/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/playlist?list=PL123",
    "javascript:alert(1)",
    "not a url",
  ])("rejects %s with an inline error", (raw) => {
    expect(validateEmbedInput(raw)).toEqual({
      ok: false,
      error: "That isn't a YouTube or Vimeo video link.",
    });
  });

  it("a link containing whitespace is rejected rather than inserted as prose", () => {
    expect(validateEmbedInput("https://youtu.be/dQw4w9WgXcQ extra").ok).toBe(false);
  });
});

// Review on #319: paste-to-upload must respect the code-block / table guard
// the paste handler already had — a screenshot pasted inside a code block or
// a table cell falls through to the default paste, as before.
describe("shouldUploadPastedMedia", () => {
  const base = { hasMediaFile: true, canUpload: true, editable: true, inCodeBlock: false, inTable: false };
  it("uploads a pasted image in ordinary text", () => {
    expect(shouldUploadPastedMedia(base)).toBe(true);
  });
  it("not inside a code block or a table", () => {
    expect(shouldUploadPastedMedia({ ...base, inCodeBlock: true })).toBe(false);
    expect(shouldUploadPastedMedia({ ...base, inTable: true })).toBe(false);
  });
  it("regression: not in a read-only / locked doc, without an uploader, or without a media file", () => {
    expect(shouldUploadPastedMedia({ ...base, editable: false })).toBe(false);
    expect(shouldUploadPastedMedia({ ...base, canUpload: false })).toBe(false);
    expect(shouldUploadPastedMedia({ ...base, hasMediaFile: false })).toBe(false);
  });
});
