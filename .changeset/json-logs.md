---
"@promptowl/contextnest-community": patch
---

**Structured JSON logs.** Set `LOG_FORMAT=json` to print every log line as one JSON object (`time`, `level`, `severity`, `message`) that Cloud Logging, Datadog or Loki can parse, with warnings and errors on stderr. The default stays plain text.
