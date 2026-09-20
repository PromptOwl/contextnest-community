---
"@promptowl/contextnest-community": minor
---

Send server usage telemetry to PostHog, and publish the Docker image to Docker Hub.

The batched events the server already collects (`nest.create`, `node.create`,
`user.login`, `context.resolve`, …) are now mirrored to PostHog when
`POSTHOG_KEY` is set, alongside an hourly `server.heartbeat` carrying user and
nest counts. Events are keyed on the user id and a hashed, stable server id —
no document content and no email addresses are sent. `TELEMETRY_ENABLED`
(default on) remains the single switch for everything the server sends outward.

The image is now built for publication: devDependencies are pruned from the
runtime layer (367M → 115M), it runs as the unprivileged `node` user, carries
OCI labels and a `/health` healthcheck, and handles SIGTERM so `docker stop`
returns immediately instead of waiting out its grace period.
