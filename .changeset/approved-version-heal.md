---
"@promptowl/contextnest-community": patch
---

Documents whose approved version can no longer be rebuilt (history damaged by an older import) no longer show up empty to readers. On the read that hits one, the approval moves to the newest published version that still rebuilds, credited to the server (system:approved-heal) rather than the original reviewer, and that version's history entry notes the move (Approved version moved from v3 to v4 — v3 could not be rebuilt). No version is created, the saved history is not rewritten, and a draft or pending version is never promoted. This covers the public reader, the document list, exports and MCP reads. If no newer published version rebuilds, nothing changes.
