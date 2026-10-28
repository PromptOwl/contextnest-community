---
"@promptowl/contextnest-community": patch
---

The Documents tab now shows when a document is still published while a newer version waits. A document with v2 published and v3 in review or sent back shows "Published (v2)" beside its Pending Review or Rejected badge, instead of only the red or amber one. The AI Ready card now counts every document with a published version that agents are served, so it no longer reads 0 while documents are live. List rows carry the live version as `approvedVersion`, and the census reports the count as `aiReady`.
