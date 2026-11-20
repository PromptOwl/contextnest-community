---
"@promptowl/contextnest-community": minor
---

The Graph view replays context pulls (po-1252). A Pulls tab beside the graph lists each retrieval made in the nest (MCP `context_get` / `context_search` / `context_query` / `context_resolve`, REST search, query and context, Hootie), newest first, with the agent and the person behind it. Clicking one lights its documents on the graph in the order they were handed over, along the links it walked, and lists the compiled context: each document's version, size and how it was reached ("Hop 1 via Returns Policy"). Agents get the same through `GET /nests/:id/pulls[/:pullId]` and the MCP tool `context_pull_log`. The access log now groups each call's rows as one pull and records order, size, and hop depth where the server walks the graph; an identical repeated pull is still recorded once, but a different pull is recorded whole. Who pulled is shown only to people with write access or above.
