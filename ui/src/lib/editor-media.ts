/**
 * Image / video insertion in the markdown editor — the pure decisions behind
 * the toolbar's "Image / video" menu, the drag-over overlay, clipboard paste
 * and the empty-document placeholder. MarkdownEditor.tsx only reads these,
 * so "never in a read-only / locked / preview doc" is decided in one place.
 */
import { toEmbedUrl } from "./video-embed";

// Media the editor can upload into nest assets — mirrors the server
// allowlist in src/nests/asset-routes.ts (SVG deliberately excluded there;
// stored-XSS surface).
export const MEDIA_ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm";
export const MEDIA_FILE_RE = /\.(png|jpe?g|gif|webp|mp4|webm)$/i;
export const VIDEO_FILE_RE = /\.(mp4|webm)$/i;
// Client-side mirrors of the server's per-type caps — fail fast with a
// friendly toast instead of shipping the file upstream to be rejected.
// Video mirrors the server default (config.VIDEO_MAX_BYTES = 30 MB), kept under
// Cloud Run's 32 MiB request limit. If a deployment raises VIDEO_MAX_MB, bump
// this to match so the client doesn't reject an upload the server would accept.
export const IMAGE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
export const VIDEO_MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30 MB

const MB = 1024 * 1024;
/** Helper line under "Upload image or video" — derived from the caps above. */
export const MEDIA_HELPER_TEXT =
  `PNG, JPG, GIF, WebP up to ${IMAGE_MAX_UPLOAD_BYTES / MB} MB · ` +
  `MP4, WebM up to ${VIDEO_MAX_UPLOAD_BYTES / MB} MB`;

export const DEFAULT_PLACEHOLDER = "Start writing...";
export const MEDIA_PLACEHOLDER =
  "Start writing… — drop in images or videos, or paste a YouTube link";

export interface MediaAffordances {
  /** "Upload image or video" in the toolbar menu (+ paste-to-upload). */
  upload: boolean;
  /** "Embed YouTube or Vimeo link" in the toolbar menu. */
  embed: boolean;
  /** "Drop to add an image or video" while a file is dragged over. */
  dropOverlay: boolean;
}

/**
 * Which media affordances a doc shows. Nothing in a read-only / locked doc
 * (`editable: false`) or in preview; embedding a link needs no uploader,
 * uploading and dropping do.
 */
export function mediaAffordances(opts: {
  editable: boolean;
  previewing: boolean;
  canUpload: boolean;
}): MediaAffordances {
  const writable = opts.editable && !opts.previewing;
  return {
    upload: writable && opts.canUpload,
    embed: writable,
    dropOverlay: writable && opts.canUpload,
  };
}

/**
 * The empty-document placeholder: a caller's own text verbatim, else the
 * default — which mentions media only when dropping a file would work.
 */
export function editorPlaceholder(
  custom: string | undefined,
  canUpload: boolean,
): string {
  if (custom !== undefined) return custom;
  return canUpload ? MEDIA_PLACEHOLDER : DEFAULT_PLACEHOLDER;
}

/** True when a drag carries files (not a text or in-editor block drag). */
export function isFileDrag(
  types: ReadonlyArray<string> | null | undefined,
): boolean {
  return !!types && Array.from(types).includes("Files");
}

const MEDIA_MIME_TYPES = new Set(MEDIA_ACCEPT.split(","));

/**
 * True when a drag-over payload is definitely not an accepted image/video —
 * used to skip the drop overlay before the real filename is known (drag
 * events only expose MIME type via `dataTransfer.items`, not the filename,
 * until drop). A blank/unknown type is treated as "might be accepted": some
 * OS + file-type combinations never report one, and a false "supported"
 * beats hiding the overlay for an upload that would have worked.
 */
export function isUnsupportedFileDrag(
  items: ReadonlyArray<{ kind: string; type: string }> | null | undefined,
): boolean {
  if (!items) return false;
  const fileItems = Array.from(items).filter((item) => item.kind === "file");
  if (fileItems.length === 0) return false;
  return fileItems.every(
    (item) => item.type !== "" && !MEDIA_MIME_TYPES.has(item.type),
  );
}

/** Toast shown when a dropped file isn't an accepted image/video. */
export function unsupportedMediaDropMessage(fileName: string): string {
  return `"${fileName}" isn't a supported image or video. ${MEDIA_HELPER_TEXT}`;
}

/** The first file on the upload allowlist, or null. */
export function pickMediaFile<T extends { name: string }>(
  files: ArrayLike<T> | null | undefined,
): T | null {
  if (!files) return null;
  for (const file of Array.from(files)) {
    if (MEDIA_FILE_RE.test(file.name)) return file;
  }
  return null;
}

export type EmbedInputResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * Validate the "Embed YouTube or Vimeo link" input. On success returns the
 * URL to insert as its own paragraph — as the author wrote it (trimmed), with
 * `https://` added when they left the scheme off, so it's a bare URL the
 * editor preview and the read view both turn into a player.
 */
export function validateEmbedInput(raw: string): EmbedInputResult {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "Paste a YouTube or Vimeo link." };
  const invalid: EmbedInputResult = {
    ok: false,
    error: "That isn't a YouTube or Vimeo video link.",
  };
  if (/\s/.test(trimmed)) return invalid;
  const url = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return toEmbedUrl(url) ? { ok: true, url } : invalid;
}

/**
 * Should a paste upload its image/video file? Only in a writable doc with an
 * uploader, and never with the caret in a code block or table — those keep
 * the default paste, the same guard the table-paste path already had.
 */
export function shouldUploadPastedMedia(opts: {
  hasMediaFile: boolean;
  canUpload: boolean;
  editable: boolean;
  inCodeBlock: boolean;
  inTable: boolean;
}): boolean {
  return (
    opts.hasMediaFile &&
    opts.canUpload &&
    opts.editable &&
    !opts.inCodeBlock &&
    !opts.inTable
  );
}
