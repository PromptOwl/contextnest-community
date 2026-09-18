/**
 * `lazy()` that survives a deploy. Chunks are content-hashed and the build
 * empties the output dir, so a tab holding yesterday's index.html asks for
 * a chunk that no longer exists the moment it navigates somewhere new —
 * "Failed to fetch dynamically imported module". The fix is a fresh
 * index.html: reload once. The flag stops a loop if the reload does not
 * help (offline, genuinely broken build) — then the error reaches the
 * boundary as it did before.
 */
import { lazy, type ComponentType } from "react";

const FLAG = "chunk-reload";

export function lazyChunk<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
) {
  return lazy(() =>
    load().then(
      (m) => {
        try {
          sessionStorage.removeItem(FLAG);
        } catch {
          /* storage blocked — the flag just doesn't clear */
        }
        return m;
      },
      (err) => {
        if (!isChunkLoadError(err)) throw err;
        let reloaded = false;
        try {
          reloaded = sessionStorage.getItem(FLAG) === "1";
          if (!reloaded) sessionStorage.setItem(FLAG, "1");
        } catch {
          /* storage blocked — reload once anyway, we cannot tell */
        }
        if (reloaded) throw err;
        window.location.reload();
        // Never resolves: the page is going away.
        return new Promise<{ default: T }>(() => {});
      },
    ),
  );
}

/** Vite/browser wording for a missing or unreachable chunk. */
export function isChunkLoadError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? "");
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /Loading chunk .* failed/i.test(msg)
  );
}
