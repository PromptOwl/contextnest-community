---
"@promptowl/contextnest-community": minor
---

Optional PostHog product analytics, off by default. Set `POSTHOG_KEY` / `POSTHOG_HOST` by environment or from Settings → Advanced to point an instance at your own project; the browser only receives the key while `TELEMETRY_ENABLED` is on, so that switch still governs everything the server sends outward. posthog-js loads only when a key is configured.
