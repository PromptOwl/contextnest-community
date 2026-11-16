---
"@promptowl/contextnest-community": patch
---

Agents now get a link a person can open. `nest_index` and `GET /index` give each nest a `web_url`, and `context_get`, `context_create`, `context_update`, `context_list`, `context_search` and `context_upload` include the document's web app address in their result. REST create and update responses carry `web_url` too. A browser that opens `/nests/<id>` is sent to `/nest/<id>` instead of getting JSON or a 404.

An HTML page posted by an agent now renders as a page. `context_create` says to use `type: "artifact"` with the raw HTML as `content`. A document whose whole body is one `html` code fence or a full HTML document is stored as an artifact with the fence removed, and the result says so; when artifacts are disabled it is stored as sent and the result says that. This applies to MCP and to REST calls made with an API key.
