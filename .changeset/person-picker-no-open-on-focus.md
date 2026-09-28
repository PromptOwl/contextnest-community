---
"@promptowl/contextnest-community": patch
---

Fix the person picker opening its full suggestion list as soon as a dialog
opens. The Assign Steward dialog focuses its email field on open, and the list
opened on any focus, covering the Scope and Role fields. It now opens on
click, typing or ArrowDown. Applies to the collaborator and team pickers too.
