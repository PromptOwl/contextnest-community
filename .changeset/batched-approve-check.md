---
"@promptowl/contextnest-community": patch
---

**The review queue and activity feed check approval rights in a handful of queries instead of several per document.** Showing whether you can review each pending document ran the full approval check — your nest roles, the self-approve setting, the document's stewards and who submitted it — once per document, one after another. The nest-wide part was identical for every row. It is now resolved once, and the per-document stewards and submitters are fetched for the whole page in one query each, so a 50-document queue makes about eight database queries instead of hundreds. The same check now also filters the queue by steward. The approval rules are unchanged: single and batched checks share one decision function, and a test compares them across every steward scope, ownership and self-approve case.
