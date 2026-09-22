import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { classifyVideoText, type VideoMatch } from "../../../lib/video-embed";

// One matcher for the read view and the editor — see ui/src/lib/video-embed.ts.
export { ASSET_VIDEO_RE } from "../../../lib/video-embed";

function createVideoWidget(url: string): HTMLVideoElement {
  const video = document.createElement("video");
  video.controls = true;
  video.preload = "metadata";
  video.className = "cn-video-embed";
  video.src = url;
  return video;
}

// YouTube / Vimeo player. Wrapped in a non-editable box so clicks and the
// caret don't land "inside" the iframe as editor content. Same sandbox/allow
// set as DocumentViewer's EmbedVideo.
function createIframeWidget(
  embedUrl: string,
  provider: string,
): HTMLDivElement {
  const wrap = document.createElement("div");
  wrap.className = "cn-video-embed cn-video-embed--iframe";
  wrap.contentEditable = "false";
  const iframe = document.createElement("iframe");
  iframe.src = embedUrl;
  iframe.title = provider === "youtube" ? "YouTube video" : "Vimeo video";
  iframe.loading = "lazy";
  iframe.allow = "fullscreen; picture-in-picture; encrypted-media";
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  iframe.setAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-presentation allow-popups",
  );
  wrap.appendChild(iframe);
  return wrap;
}

function widgetFor(match: VideoMatch): {
  key: string;
  toDOM: () => HTMLElement;
} {
  return match.kind === "asset"
    ? { key: `video-asset:${match.src}`, toDOM: () => createVideoWidget(match.src) }
    : {
        key: `video-embed:${match.embedUrl}`,
        toDOM: () => createIframeWidget(match.embedUrl, match.provider),
      };
}

/**
 * Find every paragraph whose sole content is a video URL — a same-origin
 * asset video, or a bare YouTube/Vimeo URL (see classifyVideoText) — and
 * return the decorations that hide the raw text and show a player widget in
 * its place. Exported (model-only, no DOM needed to collect them) so the
 * matching logic is unit-testable against a real ProseMirror doc, same as
 * collectWikiLinkDecorations in WikiLink.ts.
 *
 * Widgets carry a `key` so ProseMirror reuses the existing DOM across
 * transactions instead of rebuilding it — without one, every keystroke
 * would recreate (and reload) the player.
 */
export function collectVideoPreviewDecorations(
  doc: ProseMirrorNode,
): Decoration[] {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "paragraph" || node.childCount !== 1) return;
    const child = node.firstChild;
    if (!child?.isText || !child.text) return;
    const linkMark = child.marks.find((m) => m.type.name === "link");
    const match = classifyVideoText(
      child.text,
      linkMark ? (linkMark.attrs.href as string | null) : undefined,
    );
    if (!match) return;

    const start = pos + 1;
    const end = start + child.nodeSize;
    const { key, toDOM } = widgetFor(match);
    decorations.push(
      Decoration.inline(start, end, { class: "video-url-hidden" }),
    );
    decorations.push(
      Decoration.widget(start, toDOM, {
        side: -1,
        ignoreSelection: true,
        key,
      }),
    );
  });
  return decorations;
}

/**
 * uploadAndInsertMedia (in this directory's MarkdownEditor.tsx) inserts an
 * uploaded video as a paragraph whose sole content is the bare asset URL —
 * DocumentViewer.tsx's read view upgrades that to a <video> player, but the
 * TipTap editing surface (including its own "preview" toggle) rendered it
 * as literal text. This decorates any paragraph that is *only* a video URL
 * (asset, or a bare YouTube/Vimeo link) with an inline player widget and
 * visually hides the raw URL text — the same "text stays the source of
 * truth, decoration renders it nicely" approach WikiLink/TaskCheckbox
 * already use, so no schema or markdown-serialization changes are needed
 * (the .md on disk keeps the bare URL — this re-scans on every render).
 */
export const VideoPreview = Extension.create({
  name: "videoPreview",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("videoPreview"),
        props: {
          decorations(state) {
            return DecorationSet.create(
              state.doc,
              collectVideoPreviewDecorations(state.doc),
            );
          },
        },
      }),
    ];
  },
});

export default VideoPreview;
