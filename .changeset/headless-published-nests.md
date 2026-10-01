---
"@promptowl/contextnest-community": minor
---

Publish a nest API-only (headless). An owner or nest admin can turn on API-only access for a private nest (Collaborators tab, or `PUT /nests/:id/headless`) and create one read-only access key per buyer or integration, each labeled and revocable. A key works with `ctx` and any MCP client to list, get, query and search the nest's approved documents, and nothing else: no browsing, no sign-in, no drafts or version history, no comments, no export, no writes. Everything else answers 403 `headless_reader`. Each key is its own service identity, never shown as a person in people search, the teammates list or user counts. Turning API-only access off pauses every key, and deleting a key revokes it. While a nest is headless it stays private.
