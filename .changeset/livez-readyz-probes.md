---
"@promptowl/contextnest-community": patch
---

**Split liveness and readiness probes.** New public `GET /livez` (the process answers) and `GET /readyz` (the database answers and nest storage is writable; `503` naming the failed check otherwise). The Helm chart now points its liveness and startup probes at `/livez` and its readiness probe at `/readyz`, so a database or storage outage takes the pod out of rotation instead of leaving it serving errors. `/health` is unchanged.
