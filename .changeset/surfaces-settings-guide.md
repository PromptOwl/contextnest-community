---
"@promptowl/contextnest-community": patch
---

Server settings → Surfaces (po-1448). The buffer key has a **Generate** button: it makes 32 random bytes in the browser (base64, the same as `openssl rand -base64 32`) and fills the field; the key reaches the server only on Save. When a key is already saved, Generate first asks, because messages Nest is holding were encrypted with the old key and are lost. The Hosted Slack app card has a "Where do I find these?" guide: where the Client ID, Client Secret and Signing Secret are in Slack (Basic Information → App Credentials), and this server's redirect, events, interactions and `/nest` command URLs, each with a Copy button, built from the Public base URL (or a note to set it first). UI only; no API change.
