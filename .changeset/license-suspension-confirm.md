---
"@promptowl/contextnest-community": patch
---

**A suspension takes effect on the next license check, and a restart can't hide it.** A suspended license used to be confirmed only by a check at least an hour after the first suspended answer, and that hour was tracked in memory — so any restart (a redeploy, a Cloud Run instance, `tsx watch` in dev) started it over and the server never went read-only. Now two suspended answers within an hour confirm it (spec §9.4), which with the 60-second check is about a minute; one stray answer still can't. The server also checks with PromptOwl when it starts instead of trusting the 24-hour cache, falling back to the cache only when PromptOwl can't be reached.

**Nest-level writes are refused on a read-only server too.** Creating, renaming and deleting a nest (and syncing or deleting an unsynced folder) skipped the read-only check, so they still worked while the server was suspended or unlicensed. They now get the same 503 as every other write — the reason for admins, the neutral line for everyone else.
