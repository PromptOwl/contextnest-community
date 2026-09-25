---
"@promptowl/contextnest-community": patch
---

Fix the nest header flashing the wrong Visibility and Reader Mode state on load.

Opening a nest previously showed the **Private**/**Reader: Off** defaults for
a moment before the real values arrived from the initial fetch, so a public
nest with Reader Mode on would briefly look private with reader mode off.
The visibility toggle/badge and the Reader Mode button in the nest header now
stay hidden until the nest's first fetch resolves, instead of rendering their
placeholder default state.
