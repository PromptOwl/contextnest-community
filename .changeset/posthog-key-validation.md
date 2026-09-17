---
"@promptowl/contextnest-community": patch
---

Server Settings rejects a malformed product analytics key. The PostHog key field saved any string, so a typo silently turned analytics on with a key that could never send an event. A key must now look like a PostHog project API key (`phc_…`); anything else is refused with an inline message and nothing is written. Clearing the field still turns analytics off.
