---
"@promptowl/contextnest-community": minor
---

The Slack setup wizard now says who blocks a channel and lets you add channel members to the nest (po-1432). A refused channel names the readers who aren't in it ("Sam can read Engineering Ops but isn't in #testnest") or who have no Slack user linked to their email, and a public nest or a live public link is named as the cause. When people in the channel can't read the nest, "Add to nest…" opens a list of them; ticked people get read access and the channel is checked again. People with no account here are shown but can't be added. `POST /surfaces/bindings/preview` (and MCP `context_surfaces_binding_preview`) returns these names in a new `people` block for the caller only; stored bindings, alerts and the ledger stay counts-only.
