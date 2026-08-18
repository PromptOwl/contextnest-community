---
"@promptowl/contextnest-community": patch
---

Record the verdict when an external edit is approved or rejected.

Rejecting a direct filesystem edit left no trace. The document's history showed
the approval of such an edit — the engine commits a version for it, and the
server mirrors that into `node_versions`, which is what the history panel reads —
but a rejection commits nothing, so the reviewer, the time and the reason were
unrecoverable from the audit trail.

The record already existed and was being discarded. `approveSuggestion` and
`rejectSuggestion` each build a chain event carrying the acting reviewer, a
timestamp, and the rejection reason or approval comment, return it, and persist
nothing; this server read only the event id for its response. The verdict is now
appended to the engine's own append-only chain-event log, so it survives without
a new table, a migration, or a version number.

A rejection still mints no version — it changes no content, and numbering one
would renumber the chain for an event that never touched the document.

`GET /nests/:nestId/nodes/:nodeId/versions` gains `externalEditVerdicts`
alongside `versions`, and the version-history panel lists rejected external edits
above the versions. The approve and reject endpoints now return
`historyRecorded`, so a verdict that failed to reach the audit log is not
reported as a clean success.

The rejected content itself is unchanged: the engine keeps it permanently under
`_archive/rejected/`. Surfacing that diff in the UI needs a read API the engine
does not expose yet.
