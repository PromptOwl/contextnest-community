---
"@promptowl/contextnest-community": patch
---

Every MCP tool now declares `readOnlyHint`, `destructiveHint` and `openWorldHint` in `tools/list`, on `/mcp` and `/nests/:id/mcp`, so clients can warn before a risky call and the ChatGPT app can pass OpenAI's review. New read-only tool `context_metacognition_preview` checks an agent config without saving; `context_metacognition_configure` now only saves, and its `dry_run` still works but is deprecated.
