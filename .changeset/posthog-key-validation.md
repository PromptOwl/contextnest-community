---
"@promptowl/contextnest-community": patch
---

Server Settings rejects a malformed product analytics key and says why. The PostHog key field saved any string, so a typo silently turned analytics on with a key that could never send an event. A key must now look like a PostHog project API key (`phc_` plus a long run of letters and digits); the inline message names the rule that failed — wrong prefix, stray characters, or too short — and nothing is written. Clearing the field still turns analytics off.
