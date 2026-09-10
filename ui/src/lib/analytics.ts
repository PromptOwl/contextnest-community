/**
 * PostHog product analytics, off unless the server hands out a project key
 * (POSTHOG_KEY, cleared whenever usage telemetry is switched off).
 *
 * posthog-js is imported dynamically so an instance with analytics off never
 * downloads it. The key arrives with /health, one round-trip after the app
 * mounts, so events fired before that — the first page view, always — are
 * buffered rather than dropped, and flushed once init resolves. A session that
 * never gets a key discards the buffer.
 */
type Loaded = { capture: (e: string, p?: Record<string, unknown>) => void };

let ready: Promise<Loaded | null> | null = null;
/** Events fired before init resolved. Bounded — analytics must never grow
 *  without limit on an instance that has no key configured. */
const pending: Array<[string, Record<string, unknown> | undefined]> = [];
const MAX_PENDING = 50;

export function initAnalytics(key: string | null | undefined, host?: string) {
  if (!key) {
    // No analytics on this server: nothing will ever flush the buffer.
    pending.length = 0;
    return;
  }
  if (ready) return;
  ready = import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(key, {
        api_host: host || "https://us.i.posthog.com",
        // Self-hosted installs have no accounts on the PostHog side — only
        // identify someone when the app deliberately calls identify().
        person_profiles: "identified_only",
      });
      for (const [event, props] of pending.splice(0)) posthog.capture(event, props);
      return posthog as Loaded;
    })
    .catch((e) => {
      console.warn("[analytics] PostHog failed to load", e);
      pending.length = 0;
      return null;
    });
}

/** Fire an event; buffered until init, and dropped when analytics is off. */
export function track(event: string, props?: Record<string, unknown>) {
  if (!ready) {
    if (pending.length < MAX_PENDING) pending.push([event, props]);
    return;
  }
  void ready.then((ph) => ph?.capture(event, props));
}

/** Test seam: forget the loaded client and any buffered events. */
export function resetAnalyticsForTests() {
  ready = null;
  pending.length = 0;
}
