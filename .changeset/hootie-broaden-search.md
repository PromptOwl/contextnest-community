---
"@promptowl/contextnest-community": patch
---

Hootie looks harder before saying the nest doesn't know. When the documents it was given don't answer the question, it can search the nest again with other words, up to twice per question. The panel shows "Searching the nest for '…'" while a search runs. Searches run as you, so they only ever see what you can read, and each one is recorded in the activity log as Hootie's read. The answer can cite anything any search found. Models or gateways that don't take tools still get a broader second look when the first retrieval comes back thin: the question's keywords are relaxed to their stems, and the documents linked to the best hits are added.
