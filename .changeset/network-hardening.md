---
"@promptowl/contextnest-community": minor
---

Run behind firewalls and proxies:

- **Corporate egress proxy.** `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` now route outbound HTTP(S) through the proxy. This covers licensing, PromptOwl sign-in, models, OIDC, webhooks and telemetry. The proxy needs Node's `NODE_USE_ENV_PROXY=1`, which the Docker image sets. Startup logs the proxy in use with credentials masked, or explains why a configured proxy isn't used (set only in `.env`, flag off, or Node too old). SMTP, PostgreSQL and SES connect directly. Metacognition feed/MCP fetches deliberately do too: they use their own agents so the connect-time SSRF check (resolve, refuse private, pin) still runs. Under a proxy, the proxy would resolve the host and skip that check.
- **`NODE_EXTRA_CA_CERTS`** for TLS-inspecting proxies is documented. Startup reports whether it's set and warns if the file is missing.
- **`HOST`** binds the listener, e.g. `127.0.0.1`. Unset still listens on every interface.
- **`TRUSTED_PROXIES`** (IPs, CIDRs, `loopback`, `private`) limits who can set `X-Forwarded-For`, `X-Real-IP` and `X-Forwarded-Proto`. The client IP is the nearest untrusted hop. Unset keeps the old trust-every-peer behaviour, with a startup warning except on Cloud Run. A malformed value refuses to boot.
- `CONFIGURATION.md` gains Reverse proxies (with an nginx/Caddy and port-forwarding guide) and Corporate egress proxy (outbound allowlist) sections, and no longer tells you to "bind to 127.0.0.1" without a way to do it.
