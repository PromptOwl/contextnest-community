/**
 * Parent side of the hosted-artifact viewer bridge (the iframe side is
 * src/shared/artifact-bridge.ts, appended to `/hosted?embed=1`).
 *
 * The iframe runs attacker-authorable HTML, so every message it posts is
 * untrusted: callers check `event.source` is the viewer's iframe, then run the
 * payload through parseBridgeMessage, which accepts only the three shapes the
 * bridge sends, with bounded strings and a finite, clamped frac.
 */

export type BridgeMessage =
  | { type: "cn-ready" }
  | { type: "cn-place"; snippet: string; frac: number }
  | { type: "cn-activate"; id: string };

const MAX_SNIPPET = 200;
const MAX_ID = 200;

export function parseBridgeMessage(data: unknown): BridgeMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  switch (m.type) {
    case "cn-ready":
      return { type: "cn-ready" };
    case "cn-place": {
      if (typeof m.snippet !== "string" || m.snippet.length > MAX_SNIPPET) return null;
      if (typeof m.frac !== "number" || !Number.isFinite(m.frac)) return null;
      return { type: "cn-place", snippet: m.snippet, frac: Math.min(1, Math.max(0, m.frac)) };
    }
    case "cn-activate":
      if (typeof m.id !== "string" || !m.id || m.id.length > MAX_ID) return null;
      return { type: "cn-activate", id: m.id };
    default:
      return null;
  }
}

/** Parent → iframe. Target "*" because the sandboxed frame's origin is opaque. */
export function postToBridge(
  frame: HTMLIFrameElement | null,
  msg:
    | { type: "cn-goto"; snippet: string; frac: number }
    | {
        type: "cn-highlights";
        items: { id: string; quote: string; before: string }[];
        active: string | null;
      },
): void {
  frame?.contentWindow?.postMessage(msg, "*");
}
