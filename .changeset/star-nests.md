---
"@promptowl/contextnest-community": minor
---

Pinned nests float to the top of the left rail (PO-1441). The pin you could already set on an All nests card (the bookmark) now also orders the rail: pinned nests first, by name, then the rest in the usual order. Every rail row offers the bookmark on hover (pinned rows keep it), and the nest header has the same toggle; all three move together, at once, and move back with an error if the server refuses. All nests gains a "Pinned" scope. Agents get the same over MCP: `nest_index` and `GET /index` carry `pinned`, and the new server-level tool `nest_pin` pins or unpins a nest for the key's owner.
