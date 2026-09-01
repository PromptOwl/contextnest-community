---
"@promptowl/contextnest-community": minor
---

Cite source node URLs in `POST /nests/:id/context`.

The one endpoint that grounds both "Chat with the nest" and "Set up agent" now carries each node's source URL, so answers can cite inline and consumers can render clickable citations. Two additive changes to the response shape: every `nodes[]` entry gains a `url` deep link (`<base>/?nest=<nestId>&doc=nodes/<slug>`), and every context block gains a `_source: <url>_` line alongside the existing `_tags:` line. The `_source:` line is built before the token estimate, so it counts against `max_tokens` rather than silently overflowing the budget.

URLs are built in one place — `resolveNodeUrl(node, { nestId, baseUrl })` in `src/governance/title-resolver.ts`, wrapping the existing `docLink()`. That is the seam the public `/p/:slug` URL will swap into once the publish/hosting work lands, rather than every call site.

The base is `PUBLIC_BASE_URL` when set, falling back to the request origin. When neither resolves, `resolveNodeUrl` returns `undefined`, so `url` is omitted from the payload and the `_source:` line is left out — no empty `href=""` reaches a consumer. **Set `PUBLIC_BASE_URL` on any deployment whose citations reach users**: without it the cited origin comes from the incoming `Host` header, which a proxy that forwards an untrusted value would let an attacker influence.
