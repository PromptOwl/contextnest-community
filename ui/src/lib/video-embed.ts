/**
 * Video players for links that are "just a video" — shared by the read view
 * (DocumentViewer) and the editor's VideoPreview decoration, so both surfaces
 * agree on exactly which URLs become a player.
 *
 * Two kinds:
 *  - `asset`: a same-origin nest upload (`/nests/<id>/assets/<uuid>.mp4|webm`)
 *    → a native <video>.
 *  - `embed`: a YouTube or Vimeo page URL on an exact host allowlist → the
 *    provider's embeddable player URL, rendered in a sandboxed <iframe>.
 *
 * Everything else is null and stays an ordinary link. The markdown on disk is
 * never rewritten — the player is purely a rendering of the bare URL.
 */

// Same-origin nest video assets only: a root-relative /nests/<id>/assets/
// path with a server-minted uuid name (mirrors SAFE_NAME in
// src/nests/asset-routes.ts). External URLs never match.
export const ASSET_VIDEO_RE =
  /^\/nests\/[^/]+\/assets\/[0-9a-f-]{36}\.(mp4|webm)$/;

export type VideoProvider = "youtube" | "vimeo";

export interface VideoEmbed {
  provider: VideoProvider;
  embedUrl: string;
}

export type VideoMatch =
  | { kind: "asset"; src: string }
  | ({ kind: "embed" } & VideoEmbed);

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const VIMEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]);

const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
// Vimeo ids are ~9-10 digits today; cap at 12 so the id is plainly bounded.
const VIMEO_ID_RE = /^\d{1,12}$/;
const VIMEO_HASH_RE = /^[0-9a-f]+$/i;
// `90`, `90s`, `1m30s`, `1h2m3s`.
const START_RE = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/;

/** Seconds for a YouTube `t` / `start` value, or 0 when absent/unparseable. */
function parseStartSeconds(value: string | null): number {
  if (!value) return 0;
  const m = START_RE.exec(value);
  if (!m) return 0;
  const [, h, min, s] = m;
  return Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}

function youtubeId(url: URL): string | null {
  const segments = url.pathname.split("/").filter(Boolean);
  let id: string | null = null;
  if (url.hostname === "youtu.be") {
    if (segments.length === 1) id = segments[0];
  } else if (segments.length === 1 && segments[0] === "watch") {
    id = url.searchParams.get("v");
  } else if (
    segments.length === 2 &&
    (segments[0] === "shorts" || segments[0] === "embed")
  ) {
    id = segments[1];
  }
  return id && YOUTUBE_ID_RE.test(id) ? id : null;
}

function vimeoEmbed(url: URL): string | null {
  const segments = url.pathname.split("/").filter(Boolean);
  let id: string | undefined;
  let hash: string | null = null;
  if (url.hostname === "player.vimeo.com") {
    if (segments.length !== 2 || segments[0] !== "video") return null;
    id = segments[1];
    hash = url.searchParams.get("h");
  } else {
    if (segments.length < 1 || segments.length > 2) return null;
    id = segments[0];
    hash = segments[1] ?? null;
  }
  if (!id || !VIMEO_ID_RE.test(id)) return null;
  if (hash !== null && !VIMEO_HASH_RE.test(hash)) return null;
  const base = `https://player.vimeo.com/video/${id}`;
  return hash ? `${base}?h=${hash}` : base;
}

/**
 * The embeddable player URL for a YouTube / Vimeo page URL, or null when the
 * URL is anything else (wrong scheme, look-alike host, port, credentials,
 * playlist/channel pages, malformed ids). YouTube is routed through
 * youtube-nocookie.com.
 */
export function toEmbedUrl(raw: string): VideoEmbed | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();

  if (YOUTUBE_HOSTS.has(host)) {
    const id = youtubeId(url);
    if (!id) return null;
    const start = parseStartSeconds(
      url.searchParams.get("t") ?? url.searchParams.get("start"),
    );
    const base = `https://www.youtube-nocookie.com/embed/${id}`;
    return {
      provider: "youtube",
      embedUrl: start > 0 ? `${base}?start=${start}` : base,
    };
  }
  if (VIMEO_HOSTS.has(host)) {
    const embedUrl = vimeoEmbed(url);
    return embedUrl ? { provider: "vimeo", embedUrl } : null;
  }
  return null;
}

/** Asset video, provider embed, or null (stays a link / text). */
export function classifyVideoUrl(raw: string): VideoMatch | null {
  const url = raw.trim();
  if (!url) return null;
  if (ASSET_VIDEO_RE.test(url)) return { kind: "asset", src: url };
  const embed = toEmbedUrl(url);
  return embed ? { kind: "embed", ...embed } : null;
}

/**
 * The editor's view: a paragraph holding one text node, optionally carrying a
 * link mark. It's a player only when the text itself is the URL — a titled
 * link (`[Watch](https://youtu.be/…)`) or link text that disagrees with its
 * href stays a link.
 */
export function classifyVideoText(
  text: string,
  href?: string | null,
): VideoMatch | null {
  const url = text.trim();
  if (href != null && href !== url) return null;
  return classifyVideoUrl(url);
}

// Minimal hast shape — what react-markdown hands a `p` component as `node`.
interface HastLike {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastLike[];
}

function hastText(node: HastLike): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/**
 * The read view's decision for a rendered paragraph: a player when its only
 * content is a bare URL — plain text (how a root-relative asset path comes
 * through) or a link whose text *is* its href (how remark-gfm autolinks a
 * bare `https://…` URL, and how `<https://…>` parses). A titled link, a www.
 * autolink (text lacks the scheme), or a URL inside prose stays as is.
 */
export function classifyVideoParagraph(
  children: HastLike[] | undefined,
): VideoMatch | null {
  const kids = (children ?? []).filter(
    (c) => !(c.type === "text" && !(c.value ?? "").trim()),
  );
  if (kids.length !== 1) return null;
  const only = kids[0];
  if (only.type === "text") return classifyVideoText(only.value ?? "");
  if (only.type === "element" && only.tagName === "a") {
    const href = only.properties?.href;
    if (typeof href !== "string") return null;
    return classifyVideoText(hastText(only), href);
  }
  return null;
}
