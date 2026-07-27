import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

// Same-origin nest video assets only — mirrors ASSET_VIDEO_RE in
// DocumentViewer.tsx (and SAFE_NAME in src/nests/asset-routes.ts). Kept in
// lockstep manually, same as MEDIA_FILE_RE/VIDEO_FILE_RE already are between
// MarkdownEditor.tsx and the server allowlist.
export const ASSET_VIDEO_RE =
  /^\/nests\/[^/]+\/assets\/[0-9a-f-]{36}\.(mp4|webm)$/;

function createVideoWidget(url: string): HTMLVideoElement {
  const video = document.createElement("video");
  video.controls = true;
  video.preload = "metadata";
  video.className = "cn-video-embed";
  video.src = url;
  return video;
}

/**
 * Find every paragraph whose sole content is a same-origin asset video URL
 * and return the decorations that hide the raw text and show a <video>
 * widget in its place. Exported (model-only, no DOM needed to collect them)
 * so the matching logic is unit-testable against a real ProseMirror doc,
 * same as collectWikiLinkDecorations in WikiLink.ts.
 */
export function collectVideoPreviewDecorations(
  doc: ProseMirrorNode,
): Decoration[] {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "paragraph" || node.childCount !== 1) return;
    const child = node.firstChild;
    if (!child?.isText || !child.text) return;
    if (!ASSET_VIDEO_RE.test(child.text)) return;

    const url = child.text;
    const start = pos + 1;
    const end = start + child.nodeSize;
    decorations.push(
      Decoration.inline(start, end, { class: "video-url-hidden" }),
    );
    decorations.push(
      Decoration.widget(start, () => createVideoWidget(url), {
        side: -1,
        ignoreSelection: true,
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
 * as literal text. This decorates any paragraph that is *only* a
 * same-origin asset video URL with an inline <video> widget and visually
 * hides the raw URL text — the same "text stays the source of truth,
 * decoration renders it nicely" approach WikiLink/TaskCheckbox already use,
 * so no schema or markdown-serialization changes are needed (the .md on
 * disk, and old docs that already have a bare-URL video line, are
 * unaffected — this re-scans on every render).
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
