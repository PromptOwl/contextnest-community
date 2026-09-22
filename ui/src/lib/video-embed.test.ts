/**
 * YouTube / Vimeo embeds — the pure decisions behind them: which URLs become
 * a player (and which player URL), and which paragraphs are "just a video
 * link" as opposed to a link inside prose. DocumentViewer and the editor's
 * VideoPreview decoration both route through these, so the allowlist lives
 * in one place.
 */
import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import {
  ASSET_VIDEO_RE,
  toEmbedUrl,
  classifyVideoUrl,
  classifyVideoParagraph,
  classifyVideoText,
} from "./video-embed";

const YT_ID = "dQw4w9WgXcQ";
const YT_EMBED = `https://www.youtube-nocookie.com/embed/${YT_ID}`;

describe("toEmbedUrl — YouTube", () => {
  it.each([
    `https://www.youtube.com/watch?v=${YT_ID}`,
    `https://youtube.com/watch?v=${YT_ID}`,
    `https://m.youtube.com/watch?v=${YT_ID}`,
    `http://www.youtube.com/watch?v=${YT_ID}`,
    `https://www.youtube.com/watch?feature=share&v=${YT_ID}`,
    `https://www.youtube.com/watch?v=${YT_ID}&list=PL1234567890`,
    `https://youtu.be/${YT_ID}`,
    `https://youtu.be/${YT_ID}?si=abcdef`,
    `https://www.youtube.com/shorts/${YT_ID}`,
    `https://www.youtube.com/embed/${YT_ID}`,
    `https://www.youtube-nocookie.com/embed/${YT_ID}`,
    `https://youtube-nocookie.com/embed/${YT_ID}`,
    `https://WWW.YouTube.com/watch?v=${YT_ID}`,
  ])("embeds %s via youtube-nocookie", (url) => {
    expect(toEmbedUrl(url)).toEqual({ provider: "youtube", embedUrl: YT_EMBED });
  });

  it.each([
    [`https://www.youtube.com/watch?v=${YT_ID}&t=90`, 90],
    [`https://www.youtube.com/watch?v=${YT_ID}&t=90s`, 90],
    [`https://youtu.be/${YT_ID}?t=1m30s`, 90],
    [`https://youtu.be/${YT_ID}?t=1h2m3s`, 3723],
    [`https://www.youtube.com/embed/${YT_ID}?start=45`, 45],
  ])("carries the start time of %s", (url, seconds) => {
    expect(toEmbedUrl(url)).toEqual({
      provider: "youtube",
      embedUrl: `${YT_EMBED}?start=${seconds}`,
    });
  });

  it("ignores a malformed or zero start time rather than rejecting the video", () => {
    expect(toEmbedUrl(`https://youtu.be/${YT_ID}?t=soon`)).toEqual({ provider: "youtube", embedUrl: YT_EMBED });
    expect(toEmbedUrl(`https://youtu.be/${YT_ID}?t=0`)).toEqual({ provider: "youtube", embedUrl: YT_EMBED });
  });
});

describe("toEmbedUrl — Vimeo", () => {
  it.each([
    "https://vimeo.com/76979871",
    "https://www.vimeo.com/76979871",
    "http://vimeo.com/76979871",
    "https://player.vimeo.com/video/76979871",
    "https://vimeo.com/76979871/",
  ])("embeds %s via player.vimeo.com", (url) => {
    expect(toEmbedUrl(url)).toEqual({
      provider: "vimeo",
      embedUrl: "https://player.vimeo.com/video/76979871",
    });
  });

  it("keeps the privacy hash of an unlisted video", () => {
    expect(toEmbedUrl("https://vimeo.com/76979871/a1b2c3d4e5")).toEqual({
      provider: "vimeo",
      embedUrl: "https://player.vimeo.com/video/76979871?h=a1b2c3d4e5",
    });
    expect(toEmbedUrl("https://player.vimeo.com/video/76979871?h=a1b2c3d4e5")).toEqual({
      provider: "vimeo",
      embedUrl: "https://player.vimeo.com/video/76979871?h=a1b2c3d4e5",
    });
  });
});

describe("toEmbedUrl — everything else stays a link", () => {
  it.each([
    // look-alike and smuggled hosts
    `https://youtube.com.evil.io/watch?v=${YT_ID}`,
    `https://evil.com/youtube.com/watch?v=${YT_ID}`,
    `https://evil.com/?u=https://youtu.be/${YT_ID}`,
    `https://notyoutube.com/watch?v=${YT_ID}`,
    `https://youtu.be.evil.io/${YT_ID}`,
    "https://vimeo.com.attacker/76979871",
    "https://attacker.com/vimeo.com/76979871",
    `https://user:pass@evil.io/watch?v=${YT_ID}`,
    `https://www.youtube.com@evil.io/watch?v=${YT_ID}`,
    `https://www.youtube.com:8443/watch?v=${YT_ID}`,
    // schemes
    `javascript:alert(1)//https://youtu.be/${YT_ID}`,
    `javascript://youtu.be/${YT_ID}`,
    `data:text/html,https://youtu.be/${YT_ID}`,
    `ftp://youtu.be/${YT_ID}`,
    // bad ids
    "https://youtu.be/short",
    `https://youtu.be/${YT_ID}X`,
    `https://www.youtube.com/watch?v=${YT_ID.slice(0, 10)}`,
    `https://www.youtube.com/watch?v=${YT_ID.slice(0, 10)}$`,
    "http://vimeo.com/abc",
    "https://vimeo.com/76979871abc",
    "https://vimeo.com/76979871/not-a-hash!",
    // pages that aren't one video
    "https://www.youtube.com/playlist?list=PL1234567890",
    "https://www.youtube.com/@somechannel",
    "https://www.youtube.com/",
    "https://www.youtube.com/watch",
    "https://vimeo.com/channels/staffpicks",
    "https://vimeo.com/",
    "https://player.vimeo.com/video/",
    // not URLs
    "",
    "youtube",
    `www.youtube.com/watch?v=${YT_ID}`,
  ])("rejects %s", (url) => {
    expect(toEmbedUrl(url)).toBeNull();
  });
});

describe("classifyVideoUrl — asset videos keep working", () => {
  const ASSET = "/nests/abc123/assets/11111111-1111-1111-1111-111111111111.mp4";
  it("recognises same-origin mp4 / webm assets as the AssetVideo player", () => {
    expect(classifyVideoUrl(ASSET)).toEqual({ kind: "asset", src: ASSET });
    const webm = ASSET.replace(".mp4", ".webm");
    expect(classifyVideoUrl(webm)).toEqual({ kind: "asset", src: webm });
    expect(ASSET_VIDEO_RE.test(ASSET)).toBe(true);
  });
  it("recognises an allowlisted provider URL as an embed", () => {
    expect(classifyVideoUrl(`https://youtu.be/${YT_ID}`)).toEqual({
      kind: "embed",
      provider: "youtube",
      embedUrl: YT_EMBED,
    });
  });
  it("leaves external files, non-video assets and random links alone", () => {
    expect(classifyVideoUrl(`https://evil.example.com${ASSET}`)).toBeNull();
    expect(classifyVideoUrl(ASSET.replace(".mp4", ".png"))).toBeNull();
    expect(classifyVideoUrl("https://example.com/")).toBeNull();
  });
});

// Real hast, from the same remark-gfm pipeline react-markdown runs — so the
// "autolinked bare URL" shape is what gfm actually produces, not a guess.
function paragraphChildren(markdown: string): any[] {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);
  const hast: any = processor.runSync(processor.parse(markdown));
  const p = hast.children.find((c: any) => c.type === "element" && c.tagName === "p");
  return p.children;
}

describe("classifyVideoParagraph — which paragraphs become a player", () => {
  it("a bare autolinked YouTube URL on its own line is an embed", () => {
    expect(classifyVideoParagraph(paragraphChildren(`https://www.youtube.com/watch?v=${YT_ID}`))).toEqual({
      kind: "embed",
      provider: "youtube",
      embedUrl: YT_EMBED,
    });
  });

  it("an angle-bracket autolink to Vimeo is an embed", () => {
    expect(classifyVideoParagraph(paragraphChildren("<https://vimeo.com/76979871>"))).toEqual({
      kind: "embed",
      provider: "vimeo",
      embedUrl: "https://player.vimeo.com/video/76979871",
    });
  });

  it("a titled markdown link stays a link", () => {
    expect(classifyVideoParagraph(paragraphChildren(`[Watch the demo](https://youtu.be/${YT_ID})`))).toBeNull();
  });

  it("a video URL inside prose stays a link", () => {
    expect(classifyVideoParagraph(paragraphChildren(`See https://youtu.be/${YT_ID} for the demo.`))).toBeNull();
  });

  it("a non-allowlisted bare URL stays a link", () => {
    expect(classifyVideoParagraph(paragraphChildren("https://example.com/watch?v=dQw4w9WgXcQ"))).toBeNull();
  });

  it("a www. autolink (no scheme written) stays a link, matching the editor", () => {
    expect(classifyVideoParagraph(paragraphChildren(`www.youtube.com/watch?v=${YT_ID}`))).toBeNull();
  });

  it("regression: a bare same-origin asset mp4 / webm is still the AssetVideo player", () => {
    const mp4 = "/nests/abc123/assets/11111111-1111-1111-1111-111111111111.mp4";
    expect(classifyVideoParagraph(paragraphChildren(mp4))).toEqual({ kind: "asset", src: mp4 });
    const webm = mp4.replace(".mp4", ".webm");
    expect(classifyVideoParagraph(paragraphChildren(webm))).toEqual({ kind: "asset", src: webm });
  });

  it("regression: an asset URL with other text is not a player", () => {
    expect(
      classifyVideoParagraph(paragraphChildren("see /nests/abc123/assets/11111111-1111-1111-1111-111111111111.mp4")),
    ).toBeNull();
  });
});

describe("classifyVideoText — the editor's view of a one-node paragraph", () => {
  it("plain text that is a bare provider URL embeds", () => {
    expect(classifyVideoText(`https://youtu.be/${YT_ID}`)?.kind).toBe("embed");
  });
  it("link-marked text whose href is the same URL embeds", () => {
    const url = `https://youtu.be/${YT_ID}`;
    expect(classifyVideoText(url, url)?.kind).toBe("embed");
  });
  it("link text that disagrees with its href does not embed", () => {
    expect(classifyVideoText(`https://youtu.be/${YT_ID}`, "https://evil.io/")).toBeNull();
    expect(classifyVideoText("Watch the demo", `https://youtu.be/${YT_ID}`)).toBeNull();
  });
});
