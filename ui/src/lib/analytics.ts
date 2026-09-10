/**
 * PostHog product analytics, off unless the server hands out a project key
 * (POSTHOG_KEY, cleared whenever usage telemetry is switched off).
 *
 * posthog-js is imported dynamically so an instance with analytics off never
 * downloads it, and every call here is a no-op until `initAnalytics` has run.
 */
let ready: Promise<{ capture: (e: string, p?: Record<string, unknown>) => void } | null> | null =
  null;

export function initAnalytics(key: string | null | undefined, host?: string) {
  if (!key || ready) return;
  ready = import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(key, {
        api_host: host || "https://us.i.posthog.com",
        // Self-hosted installs have no accounts on the PostHog side — only
        // identify someone when the app deliberately calls identify().
        person_profiles: "identified_only",
      });
      return posthog;
    })
    .catch((e) => {
      console.warn("[analytics] PostHog failed to load", e);
      return null;
    });
}

/** Fire an event; silently dropped when analytics is off. */
export function track(event: string, props?: Record<string, unknown>) {
  void ready?.then((ph) => ph?.capture(event, props));
}
