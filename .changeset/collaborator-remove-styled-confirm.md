---
"@promptowl/contextnest-community": patch
---

Fix removing a collaborator showing a native browser confirmation popup instead of the app's styled dialog.

The native `window.confirm()` popup also displayed the deployment's internal
Cloud Run URL in its header. Removing a collaborator now opens the same
styled `AlertDialog` used elsewhere in the app; the remove action itself was
unaffected.
