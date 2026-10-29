---
"@promptowl/contextnest-community": patch
---

**Prometheus metrics.** Set `METRICS_ENABLED=true` to serve `GET /metrics`: request latency by route, MCP tool calls by tool and status (vault-busy shows as `503`), Postgres pool connections and Node process metrics. `METRICS_TOKEN` puts the endpoint behind a bearer token. The Helm chart gains `metrics.enabled` and a `metrics.serviceMonitor` toggle for prometheus-operator, and a starter Grafana dashboard ships in `deploy/grafana/`. Off by default; a server without it never loads the metrics library.
