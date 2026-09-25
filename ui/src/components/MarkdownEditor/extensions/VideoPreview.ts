import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
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
// set as DocumentViewer's EmbedVideo — see the note there on why
// allow-scripts + allow-same-origin is acceptable only because embedUrl is
// pinned to youtube-nocookie.com / player.vimeo.com by toEmbedUrl.
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

// The same video can appear more than once in a doc; keys must stay unique
// or ProseMirror may hand one paragraph's player to another. The n-th repeat
// (in document order) gets `#n` — stable while typing elsewhere, and the
// first occurrence keeps the bare key.
function uniqueKey(key: string, seen: Map<string, number>): string {
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  return n === 1 ? key : `${key}#${n}`;
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
  const seen = new Map<string, number>();
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
    const { key: baseKey, toDOM } = widgetFor(match);
    const key = uniqueKey(baseKey, seen);
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
 * The video player is just a decoration over a plain paragraph whose text is
 * the URL — so a Backspace at the start of the paragraph right after it hits
 * ProseMirror's default `joinBackward`, which merges the two paragraphs and
 * appends the typed text straight onto the URL, corrupting it (and visually
 * destroying the player, since the merged paragraph no longer matches
 * classifyVideoText). This finds that case — empty selection, caret at the
 * very start of a text block, immediately preceded by a video paragraph — so
 * the caller can redirect the caret into the video paragraph instead of
 * merging into it. Exported and doc-only (no view/DOM needed) so it's
 * unit-testable the same way collectVideoPreviewDecorations is.
 */
export function findBackspaceIntoVideo(
  doc: ProseMirrorNode,
  from: number,
): { pos: number } | null {
  const $from = doc.resolve(from);
  if ($from.parentOffset !== 0) return null;
  const before = $from.before($from.depth);
  if (before <= 0) return null;
  const prevNode = doc.resolve(before).nodeBefore;
  if (!prevNode || prevNode.type.name !== "paragraph") return null;
  if (prevNode.childCount !== 1) return null;
  const child = prevNode.firstChild;
  if (!child?.isText || !child.text) return null;
  const linkMark = child.marks.find((m) => m.type.name === "link");
  const match = classifyVideoText(
    child.text,
    linkMark ? (linkMark.attrs.href as string | null) : undefined,
  );
  return match ? { pos: before - 1 } : null;
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
          // First Backspace right after a video moves the caret into the
          // video paragraph instead of merging it into the current one — see
          // findBackspaceIntoVideo. A second Backspace from there behaves
          // normally (editing the URL text directly), same as clicking in.
          handleKeyDown(view, event) {
            if (event.key !== "Backspace") return false;
            const { state } = view;
            if (!state.selection.empty) return false;
            const target = findBackspaceIntoVideo(state.doc, state.selection.from);
            if (!target) return false;
            const tr = state.tr.setSelection(
              TextSelection.near(state.doc.resolve(target.pos), -1),
            );
            view.dispatch(tr.scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },
});

export default VideoPreview;
